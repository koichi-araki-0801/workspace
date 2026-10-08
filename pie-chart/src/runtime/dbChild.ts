// =============================================================================
// runtime/dbChild.ts — exe での DB 取得を子プロセスで行う(親の側と子の側)
// -----------------------------------------------------------------------------
// 読み込み中の DLL はそのプロセスが生きている間は消せない(Windows)。ドライバを親が
// 読み込むと、実行ごとのフォルダを終了時にも消せなくなる。そこで同じ exe を子プロセス
// (`__db-fetch`)として起動し、ドライバの読み込みとストアドの呼び出しを子だけに任せる。
// 親は子が終わってからフォルダを消す。
// やり取り: 親は要求(JSON)を子の stdin に書き、子は応答を `RESPONSE_MARKER` で始まる 1 行の
// JSON として stdout に書く。ドライバや Node が stdout に何か書いても応答を取り違えないよう、
// 親は印の付いた行だけを読む。
// 信頼の置き方: `__db-fetch` は誰でも任意の stdin で呼べるので、子は要求のハッシュを信用せず、
// ビルド時に exe へ埋め込んだハッシュとファイルを照合する。これが主たる防御。ドライバの場所を
// `<作業フォルダの親>/<実行ごと>/sqlserverv8.node` の形に限る検査は、`__db-fetch` の誤用に
// 対する多層防御にとどまる(許可する親は子自身の TEMP から導くので、子を自分で起動できる者
// は止められない)。照合から `dlopen` までの間に同じユーザーがファイルを差し替える余地は残る。
// Node は共有モードを指定してファイルを開けず、この窓は塞げない。悪用には同一ユーザーの
// コード実行がすでに要るため、許容する限界とする。
// =============================================================================

import { type ChildProcess, spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { type MsSqlDriver, callSprocItems, checkConnection } from '../input/db.js';
import { type DbStage, DbStageError, InterruptedError, errorMessage } from '../input/dbStage.js';
import type { SprocArgs } from '../input/sprocArgs.js';
import { loadMsSqlDriver } from './msDriver.js';
import {
  DRIVER_ASSET_KEY,
  DRIVER_FILE_NAME,
  createRunDir,
  embeddedDriverSha256,
  registerDriverPath,
  removeRunDir,
  runDirParent,
  verifyDriverFile,
  writeVerifiedDriver,
} from './nativeDriver.js';
import { readSeaAsset } from './seaRuntime.js';

export const RESPONSE_MARKER = 'PIECHART-DB-RESPONSE ';

export type HelperMode = 'fetch' | 'load' | 'connect';

/** 親が子に頼む内容(ドライバの場所は親が書き出した後に足す)。 */
export interface HelperRequest {
  mode: HelperMode;
  connectionString: string;
  proc: string;
  args: SprocArgs | null;
  timeoutMs: number;
}

export interface ChildRequest extends HelperRequest {
  driverPath: string;
}

type ChildResponse =
  | { ok: true; items: Array<[string, number]> }
  | { ok: false; stage: DbStage; message: string };

const MODES: ReadonlySet<string> = new Set(['fetch', 'load', 'connect']);
const STAGES: ReadonlySet<string> = new Set([
  'extract',
  'verify',
  'load',
  'connect',
  'query',
  'child',
]);

// ── 1. 子の側 ──────────────────────────────────────────────────────────────

export interface ChildDeps {
  loadDriver: () => MsSqlDriver;
  verify: (file: string, sha: string) => void;
  register: (file: string) => void;
  /** exe に埋め込んだドライバのハッシュ。照合はこれだけを基準にする。 */
  expectedSha256: () => string;
  /** 実行ごとのフォルダを作る親フォルダ。ドライバはこの直下のフォルダの中に限る。 */
  allowedParent: () => string;
}

const defaultChildDeps: ChildDeps = {
  loadDriver: loadMsSqlDriver,
  verify: verifyDriverFile,
  register: registerDriverPath,
  expectedSha256: embeddedDriverSha256,
  allowedParent: runDirParent,
};

function samePath(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * ドライバが `<許可された親>/<実行ごとのフォルダ>/sqlserverv8.node` の形か確かめ、実体のパスを
 * 返す。以降の照合・登録・読み込みは、検査した実体のパスだけを使う(検査後の差し替え対策)。
 */
function resolveDriverLocation(driverPath: string, allowedParent: string): string {
  const outside = (): DbStageError =>
    new DbStageError('verify', `driver path is outside the working folder: ${driverPath}`);
  let realParent: string;
  try {
    realParent = fs.realpathSync(allowedParent);
  } catch {
    throw new DbStageError('verify', `working folder not found: ${allowedParent}`);
  }
  let realDriver: string;
  try {
    realDriver = fs.realpathSync(driverPath);
  } catch {
    throw outside();
  }
  if (
    !samePath(path.basename(realDriver), DRIVER_FILE_NAME) ||
    !samePath(path.dirname(path.dirname(realDriver)), realParent)
  ) {
    throw outside();
  }
  return realDriver;
}

/** 照合 → 登録 → 読み込み → (モードに応じて)接続確認かストアド呼び出し。 */
export async function handleChildRequest(
  req: ChildRequest,
  deps: ChildDeps,
): Promise<ChildResponse> {
  try {
    const expected = deps.expectedSha256();
    if (!expected) {
      throw new DbStageError('verify', 'this executable has no embedded DB driver hash.');
    }
    const driverFile = resolveDriverLocation(req.driverPath, deps.allowedParent());
    // 親が照合してから子が読み込むまでの間に差し替えられていないか、読み込む直前にもう一度見る。
    deps.verify(driverFile, expected);
    deps.register(driverFile);
    let driver: MsSqlDriver;
    try {
      driver = deps.loadDriver();
    } catch (err) {
      throw new DbStageError(
        'load',
        `${errorMessage(err)} (an application control policy such as AppLocker / WDAC, or ` +
          'antivirus software, may be blocking DLLs written to %TEMP%)',
      );
    }
    if (req.mode === 'load') return { ok: true, items: [] };
    if (req.mode === 'connect') {
      await checkConnection(driver, req.connectionString, req.timeoutMs);
      return { ok: true, items: [] };
    }
    if (!req.args) throw new DbStageError('child', 'fetch request without procedure arguments.');
    const items = await callSprocItems(driver, {
      connectionString: req.connectionString,
      proc: req.proc,
      args: req.args,
      timeoutMs: req.timeoutMs,
    });
    return { ok: true, items };
  } catch (err) {
    const e = err instanceof DbStageError ? err : new DbStageError('child', errorMessage(err));
    return { ok: false, stage: e.stage, message: e.message };
  }
}

/** 子が受け取った要求の形を検査する(親以外が `__db-fetch` を呼んでも暴走させない)。 */
export function parseChildRequest(text: string): ChildRequest {
  const v = JSON.parse(text) as Record<string, unknown>;
  if (typeof v.mode !== 'string' || !MODES.has(v.mode)) throw new Error('invalid mode.');
  for (const key of ['driverPath', 'connectionString', 'proc'] as const) {
    if (typeof v[key] !== 'string') throw new Error(`invalid ${key}.`);
  }
  if (typeof v.timeoutMs !== 'number' || !(v.timeoutMs > 0)) throw new Error('invalid timeoutMs.');
  const args = v.args as Record<string, unknown> | null;
  if (
    args !== null &&
    (typeof args !== 'object' ||
      typeof args.fund !== 'string' ||
      typeof args.baseDate !== 'string' ||
      typeof args.chartType !== 'string')
  ) {
    throw new Error('invalid args.');
  }
  return v as unknown as ChildRequest;
}

async function readAll(input: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of input) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** `__db-fetch` の本体。応答を 1 行書き、終了コードを返す。 */
export async function runDbChild(
  input: NodeJS.ReadableStream = process.stdin,
  write: (s: string) => void = (s) => process.stdout.write(s),
  deps: ChildDeps = defaultChildDeps,
): Promise<number> {
  let res: ChildResponse;
  try {
    res = await handleChildRequest(parseChildRequest(await readAll(input)), deps);
  } catch (err) {
    res = { ok: false, stage: 'child', message: `invalid request: ${errorMessage(err)}` };
  }
  write(`${RESPONSE_MARKER}${JSON.stringify(res)}\n`);
  return res.ok ? 0 : 1;
}

// ── 2. 親の側 ──────────────────────────────────────────────────────────────

/** 子の stdout から印の付いた行を探して応答として読む。 */
export function parseChildResponse(stdout: string): ChildResponse {
  const line = stdout
    .split(/\r?\n/)
    .reverse()
    .find((l) => l.startsWith(RESPONSE_MARKER));
  if (line === undefined) throw new Error('no response line from the DB helper process.');
  const v = JSON.parse(line.slice(RESPONSE_MARKER.length)) as Record<string, unknown>;
  if (v.ok === true && Array.isArray(v.items)) {
    return { ok: true, items: v.items as Array<[string, number]> };
  }
  if (v.ok === false && typeof v.stage === 'string' && STAGES.has(v.stage)) {
    return { ok: false, stage: v.stage as DbStage, message: String(v.message) };
  }
  throw new Error('invalid response from the DB helper process.');
}

export interface ParentDeps {
  spawn: (cmd: string, args: string[]) => ChildProcess;
  execPath: string;
  parentDir: string;
  driverBytes: () => Buffer;
  driverSha256: string;
  /** タイムアウトに足す猶予。子がドライバの取り消しに応じないときに親が止めるまでの余白。 */
  graceMs: number;
  onSignal: (handler: () => void) => () => void;
  warn: (msg: string) => void;
}

/** SIGINT / SIGBREAK(Ctrl+C / Ctrl+Break)に handler を付け、外す関数を返す。 */
export function onInterruptSignals(handler: () => void): () => void {
  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGBREAK'];
  for (const s of signals) process.on(s, handler);
  return () => {
    for (const s of signals) process.off(s, handler);
  };
}

export function defaultParentDeps(): ParentDeps {
  return {
    spawn: (cmd, args) => nodeSpawn(cmd, args, { stdio: 'pipe', windowsHide: true }),
    execPath: process.execPath,
    parentDir: runDirParent(),
    driverBytes: () => readSeaAsset(DRIVER_ASSET_KEY),
    driverSha256: embeddedDriverSha256(),
    graceMs: 30_000,
    onSignal: onInterruptSignals,
    warn: (msg) => console.error(msg),
  };
}

function stderrTail(text: string): string {
  const trimmed = text.trim();
  return trimmed === '' ? '' : `\n${trimmed.slice(-500)}`;
}

/**
 * 実行ごとのフォルダにドライバを書き出し、子プロセスに処理させて結果を返す。フォルダは
 * 成功・失敗・中断のどの場合も `finally` で消す。
 */
export async function runDbHelper(
  req: HelperRequest,
  deps: ParentDeps = defaultParentDeps(),
  hooks: { onRunDir?: (dir: string) => void } = {},
): Promise<{ items: Array<[string, number]>; runDir: string }> {
  if (!deps.driverSha256) {
    throw new DbStageError(
      'extract',
      'this executable was built without DB support (build-exe.mjs --no-db).',
    );
  }
  const runDir = createRunDir(deps.parentDir);
  hooks.onRunDir?.(runDir);
  try {
    const driverPath = writeVerifiedDriver(runDir, deps.driverBytes(), deps.driverSha256);
    const limitMs = req.timeoutMs + deps.graceMs;
    const response = await new Promise<ChildResponse>((resolve, reject) => {
      const child = deps.spawn(deps.execPath, ['__db-fetch']);
      // 子が早く死ぬと `stdin.end()` が EPIPE を出す。結果は子の `close` / `error` で決めるので、
      // 流れの `error` は握りつぶす(未処理だと `finally` に届く前に親が落ちる)。
      for (const stream of [child.stdin, child.stdout, child.stderr]) stream?.on('error', () => {});
      let out = '';
      let err = '';
      let timedOut = false;
      let interrupted = false;
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (c: string) => {
        out += c;
      });
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (c: string) => {
        err += c;
      });
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, limitMs);
      const offSignal = deps.onSignal(() => {
        interrupted = true;
        child.kill();
      });
      const settle = (): void => {
        clearTimeout(timer);
        offSignal();
      };
      child.once('error', (e: Error) => {
        settle();
        reject(new DbStageError('child', `could not start the DB helper process: ${e.message}`));
      });
      child.once('close', (code: number | null) => {
        settle();
        if (interrupted) {
          reject(new InterruptedError());
          return;
        }
        if (timedOut) {
          reject(
            new DbStageError(
              'child',
              `the DB helper process did not finish within ${limitMs} ms and was stopped.`,
            ),
          );
          return;
        }
        try {
          resolve(parseChildResponse(out));
        } catch {
          reject(
            new DbStageError(
              'child',
              `the DB helper process exited with code ${code} without a valid response.` +
                stderrTail(err),
            ),
          );
        }
      });
      const request: ChildRequest = { ...req, driverPath };
      child.stdin?.end(JSON.stringify(request));
    });
    if (!response.ok) throw new DbStageError(response.stage, response.message);
    return { items: response.items, runDir };
  } finally {
    const failure = removeRunDir(runDir);
    if (failure) deps.warn(`[db] could not remove ${runDir}: ${failure}`);
  }
}
