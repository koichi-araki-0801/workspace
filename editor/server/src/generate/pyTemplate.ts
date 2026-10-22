// =============================================================================
// pyTemplate.ts — Python テンプレート生成器を child_process で呼び出す
// =============================================================================
// 生成器は社内の共有フォルダなどに置かれた既存ツールで、editor はそのパスを設定
// (`config.python.script`)で指すだけ。子プロセスへ渡すものは「起動に要る環境変数」と
// 「ルートで検証した属性」だけに絞る。`process.env` を丸ごと渡すと、HTTPS のパスフレーズや
// DB 接続の追加文字列を共有上のコードが読める。秘密値だけを削る拒否リストにしないのは、
// 秘密値が増えたときに黙って漏れるため。
//
// 起動は位置引数 `<Rep1 会社コード> <ファンドコード> <基準日> [コピー元] [償還=1]` で、cwd は
// スクリプトのあるフォルダ。生成器はスクリプトの 1 つ上の階層の `output/` へ
// `<会社>_<ファンド>_<版種>.html` を書き、1 つ上の `log/` の実行ログへ書いたファイルを
// `[OUTPUT] <名前>` の行で追記する。実行ログは実行をまたいで同じファイルへ足されるので、起動前の
// 長さを控えて今回の追記分だけを読む。editor は標準出力を使わず、ログに載った名前を 1 つずつ
// 検査し(この呼び出しで書かれた通常のファイルか・会社が合うか・空でないか)、通ったものだけを
// 読む。ログに載っていないファイルや前回の生成物を、今回の出力と取り違えないため。
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import {
  assertSkeletonFileName,
  assertTemplateAttributeToken,
  parseSkeletonFileName,
  type SkeletonAttributes,
  skeletonFileName,
} from '@editor/shared';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { BuildAdmissionGate } from '../vivliostyle/buildAdmission.js';
import { generatorLogPath, logSizeBefore, parseOutputNames, readRunLog } from './generatorLog.js';

/** 生成器が 1 ファンドにつき書く版の順(作成画面のファンドの結果はこの順で返す)。 */
export const GENERATED_EDITIONS = ['交付版', '全体版'] as const;

/**
 * 生成器へ渡す属性。ルート(`generate.routes.ts`)で検証した値だけ。版種は生成器が決めるので
 * 持たない。
 */
export interface GenerateAttributes {
  /** 出力ファイル名の会社(略称)。生成物の会社の照合に使う。 */
  companyCode: string;
  /** 生成器へ渡す Rep1 の委託会社コード(前後の空白は渡す前に除く)。 */
  rep1CompanyCode: string;
  fundCode: string;
  /** シリーズから作成するときのコピー元ファンドコード。 */
  sourceFundCode?: string;
  /** 償還ファンドとして作成するか。true のときだけ生成器へ渡す。 */
  isRedemption?: boolean;
}

/** 生成器が書いた 1 ファイル。 */
export interface GeneratedFile {
  fileName: string;
  attributes: SkeletonAttributes;
  html: string;
  /** `output/` 内の実パス(取り込み後に `removeGeneratedFiles` で消す)。 */
  path: string;
}

/**
 * 指紋が合わないときに利用者へ出す文言(生成器の差し替えは管理者の対応事項)。
 * テストから直接検証するために公開する。
 * @public
 */
export const GENERATOR_FINGERPRINT_MISMATCH_MESSAGE =
  'テンプレート生成器の指紋が設定と一致しないため、生成を中止しました。管理者に連絡してください';

/**
 * 利用者へそのまま出せる文言と状態コードを持つ Error。`errorHandler` は `kind` を持つ値の
 * `message` を応答に使い、数値の `statusCode` を状態コードに使う。Error のインスタンスに
 * するのは、`auditedRethrow` が監査ログへ `message` を残すため。
 */
function generatorError(message: string, code: string, statusCode: number): Error {
  return Object.assign(new Error(message), { kind: 'unexpected' as const, code, statusCode });
}

/**
 * 生成器のスクリプトの指紋を照合する(設定が無ければ何もしない)。生成のたびに読むのは、
 * 照合から起動までの間に共有上のスクリプトを差し替えられる幅を狭めるため。読めないときも
 * 拒否する — 照合できない生成器を起動すると、指紋を設定した意味が消える。
 */
async function assertGeneratorFingerprint(): Promise<void> {
  const expected = config.python.scriptSha256;
  if (expected === undefined) return;
  const script = config.python.script;
  let actual: string;
  try {
    actual = createHash('sha256')
      .update(await readFile(script))
      .digest('hex');
  } catch (err) {
    logger.error(
      { err, script },
      '[generate] 生成器のスクリプトを読めず指紋を照合できません — 生成を拒否しました',
    );
    throw generatorError(
      GENERATOR_FINGERPRINT_MISMATCH_MESSAGE,
      'GENERATOR_FINGERPRINT_MISMATCH',
      500,
    );
  }
  if (actual !== expected) {
    logger.error(
      { script, expected, actual },
      '[generate] 生成器の指紋が設定と一致しません — 生成を拒否しました',
    );
    throw generatorError(
      GENERATOR_FINGERPRINT_MISMATCH_MESSAGE,
      'GENERATOR_FINGERPRINT_MISMATCH',
      500,
    );
  }
}

/**
 * 生成の待ち行列が満杯のときに利用者へ出す文言(PDF ビルドの満杯時と同じ形)。
 * テストから直接検証するために公開する。
 */
export const GENERATE_QUEUE_FULL_MESSAGE =
  'テンプレート生成の順番待ちが混み合っています。しばらく待ってから再実行してください';

/**
 * 生成の受付制御。上限が無いと、同時に押された数だけ Python が立ち上がる。満杯なら待たせずに
 * 503 で断る — 待たせると、待つ間ずっと HTTP 接続とリクエストを握り続ける。
 */
const GENERATE_GATE = new BuildAdmissionGate({
  maxConcurrent: config.python.maxConcurrency,
  maxQueue: config.python.maxQueue,
  queueFullError: () => generatorError(GENERATE_QUEUE_FULL_MESSAGE, 'GENERATE_QUEUE_FULL', 503),
});

/**
 * 親から引き継ぐ環境変数。Windows で Python(既定の PATH 上の python。py ランチャを指定した場合は
 * それも)が動く最小限(`SYSTEMROOT` が無いと Python の乱数・ソケットの初期化が失敗する)。
 */
const INHERITED_ENV_KEYS = ['PATH', 'SYSTEMROOT', 'TEMP', 'TMP', 'PATHEXT', 'COMSPEC'] as const;

/**
 * 生成器(と起動時の版確認)の子プロセスへ渡す環境変数を組む。`TEMPLATES_DIR` はコピー元
 * (`sourceFundCode`)のテンプレートの読み先で、サーバの本当の置き場(`config.templatesDir`)を必ず渡す。
 * 書き先は環境変数でなく、スクリプトの位置から決まる `output/` なので渡さない。
 */
export function generatorEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of INHERITED_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  // Python ツールに UTF-8 出力を強制する(Windows の既定は cp932)。
  env.PYTHONUTF8 = '1';
  env.PYTHONIOENCODING = 'utf-8';
  env.TEMPLATES_DIR = config.templatesDir;
  return env;
}

/** 生成器の書き先。スクリプトの 1 つ上の階層の `output/`(生成器の約束で固定)。 */
export function generatorOutputDir(): string {
  return path.join(path.dirname(path.dirname(path.resolve(config.python.script))), 'output');
}

/**
 * 生成器へ渡す位置引数(スクリプトより後ろ)。トークンはここで検査するので、呼び出し元とは
 * 独立に区切り文字やパス要素を持ち込ませない。Rep1 コードは前後の空白を除いて渡す。
 * コピー元が無く償還だけのときは、位置を保つため空文字を置く。
 */
export function generatorArgs(attrs: GenerateAttributes, baseDate: string): string[] {
  const rep1 = assertTemplateAttributeToken('Rep1 委託会社コード', attrs.rep1CompanyCode.trim());
  assertTemplateAttributeToken('会社コード', attrs.companyCode);
  const fund = assertTemplateAttributeToken('ファンドコード', attrs.fundCode);
  const date = assertTemplateAttributeToken('基準日', baseDate);
  const source = attrs.sourceFundCode
    ? assertTemplateAttributeToken('コピー元ファンドコード', attrs.sourceFundCode)
    : undefined;
  const args = [rep1, fund, date];
  if (source !== undefined || attrs.isRedemption) args.push(source ?? '');
  if (attrs.isRedemption) args.push('1');
  return args;
}

interface OutputState {
  mtimeMs: number;
  ino: number;
  isFile: boolean;
  digest: string;
  /** 通常のファイルのときの中身(指紋と html を同じバイト列から作るため)。 */
  bytes: Buffer | null;
}

/** 大文字小文字を区別しない OS だけ、名前の比較キーを小文字にそろえる。 */
const foldName = (name: string): string =>
  process.platform === 'win32' ? name.toLowerCase() : name;

const isEnoent = (err: unknown): boolean => (err as NodeJS.ErrnoException).code === 'ENOENT';

/**
 * 出力ファイルの状態(無ければ null)。シンボリックリンクは辿らない(`lstat`)。内容の指紋も持つのは、
 * 更新時刻の粒度が粗くファイル番号を返さない(`ino` が 0 の)ドライブでも書き直しを見分けるため。
 * 無いこと(ENOENT)以外の失敗は「無い」と区別できないので投げる。
 */
async function outputState(file: string): Promise<OutputState | null> {
  try {
    const s = await lstat(file);
    const bytes = s.isFile() ? await readFile(file) : null;
    const digest = bytes ? createHash('sha256').update(bytes).digest('hex') : '';
    return { mtimeMs: s.mtimeMs, ino: s.ino, isFile: s.isFile(), digest, bytes };
  } catch (err) {
    if (isEnoent(err)) return null;
    throw err;
  }
}

/** `output/` の全 `.html` の起動前の状態。フォルダが無ければ空。 */
async function snapshotOutputs(dir: string): Promise<Map<string, OutputState>> {
  const states = new Map<string, OutputState>();
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    if (isEnoent(err)) return states;
    throw err;
  }
  for (const name of names) {
    if (!name.toLowerCase().endsWith('.html')) continue;
    const state = await outputState(path.join(dir, name));
    if (state) states.set(foldName(name), { ...state, bytes: null });
  }
  return states;
}

function rejected(message: string): Error {
  return new Error(`Python生成器${message}`);
}

/**
 * ログに載った 1 件を検査して読む。名前がフォルダ区切りや `..` を含むと `output/` の外を読ませ
 * られるので、まず名前だけで弾く。
 */
async function readGeneratedFile(
  dir: string,
  name: string,
  before: Map<string, OutputState>,
  companyCode: string,
): Promise<GeneratedFile> {
  if (name.includes('/') || name.includes('\\') || name.includes('..')) {
    throw rejected(`の出力名が不正です(フォルダ区切りや .. を含みます): ${name}`);
  }
  // 名前そのものは厳密に検査する(`:` や制御文字、トークン末尾の空白を持つ名前は通さない)。
  // 緩めるのは、有効な名前の会社を作成先と比べるときだけ。
  let attributes: SkeletonAttributes | null;
  try {
    attributes = parseSkeletonFileName(assertSkeletonFileName(name));
  } catch {
    attributes = null;
  }
  if (!attributes) throw rejected(`の出力名が 会社_ファンド_版種.html の形ではありません: ${name}`);
  if (!(GENERATED_EDITIONS as readonly string[]).includes(attributes.editionType)) {
    throw rejected(`の出力の版種が 交付版・全体版 ではありません: ${name}`);
  }
  if (attributes.companyCode.trimEnd().toLowerCase() !== companyCode.trimEnd().toLowerCase()) {
    throw rejected(`の出力の会社が作成先と違います: ${name}`);
  }
  const file = path.join(dir, name);
  const after = await outputState(file);
  if (after && !after.isFile) throw rejected(`の出力が通常のファイルではありません: ${name}`);
  const prev = before.get(foldName(name));
  const written =
    after?.bytes != null &&
    (prev === undefined ||
      after.mtimeMs > prev.mtimeMs ||
      after.ino !== prev.ino ||
      after.digest !== prev.digest);
  if (!written || !after?.bytes) throw rejected(`が ${name} を書き出していません`);
  const html = after.bytes.toString('utf8');
  if (!html.trim()) throw rejected(`が空の出力を返しました: ${name}`);
  return { fileName: name, attributes, html, path: file };
}

/**
 * 生成器を呼び出し、今回の実行ログに載ったファイルを検査して返す。作成画面のファンドの 2 版
 * (交付版・全体版の順)が先頭で、組入先はファイル名順に続く。終了コード 0 でも、ログに載った
 * ファイルがこの呼び出しで書かれていなければ失敗にする(前回の生成物を取り違えないため)。
 */
export function generateTemplates(
  attrs: GenerateAttributes,
  baseDate: string,
): Promise<GeneratedFile[]> {
  const args = generatorArgs(attrs, baseDate);
  const [rep1, fund] = args;
  const dir = generatorOutputDir();
  const log = generatorLogPath(config.python.script, rep1, fund, baseDate);
  // 指紋の照合は枠を取った後・起動の直前に行う(待ち行列にいる間の差し替えも拾う)。
  return GENERATE_GATE.run(async () => {
    await assertGeneratorFingerprint();
    // 書かれたかの比較の基準は、起動の直前に取る(待ち行列の間に別の生成が書いた分を混ぜない)。
    const before = await snapshotOutputs(dir);
    const sizeBefore = await logSizeBefore(log);
    await runGenerator(args);
    const listed = parseOutputNames(await readRunLog(log, sizeBefore));
    // 同じファイルを大文字小文字違いで 2 回挙げても 1 本として数える(最初の綴りを残す)。
    const seen = new Set<string>();
    const names = listed.filter((n) => {
      const key = n.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (names.length > config.python.maxOutputFiles) {
      throw rejected(
        `の出力が上限(${config.python.maxOutputFiles} 本)を超えています: ${names.length} 本`,
      );
    }
    const files: GeneratedFile[] = [];
    for (const name of names) {
      files.push(await readGeneratedFile(dir, name, before, attrs.companyCode));
    }
    return orderGenerated(files, attrs.fundCode);
  });
}

/** 作成画面のファンドの 2 版を先頭に、残り(組入先)をファイル名順に並べる。 */
function orderGenerated(files: GeneratedFile[], fundCode: string): GeneratedFile[] {
  const head: GeneratedFile[] = [];
  for (const edition of GENERATED_EDITIONS) {
    const hit = files.find(
      (f) => f.attributes.fundCode === fundCode && f.attributes.editionType === edition,
    );
    if (!hit) throw rejected(`が ${fundCode} の ${edition} を書き出していません`);
    head.push(hit);
  }
  const rest = files
    .filter((f) => !head.includes(f))
    .sort((a, b) => (a.fileName < b.fileName ? -1 : a.fileName > b.fileName ? 1 : 0));
  return [...head, ...rest];
}

/** 取り込み済みの生成物を `output/` から消す。既に無いファイルは無視する。 */
export async function removeGeneratedFiles(files: readonly GeneratedFile[]): Promise<void> {
  for (const f of files) {
    try {
      await unlink(f.path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
}

function runGenerator(args: string[], extraEnv: NodeJS.ProcessEnv = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      config.python.bin,
      [...config.python.args, config.python.script, ...args],
      {
        cwd: path.dirname(config.python.script),
        timeout: config.python.timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
        encoding: 'utf8',
        env: { ...generatorEnv(), ...extraEnv },
      },
      // 標準出力は使わない(出力は output/ のファイルと実行ログ)。失敗時の stderr だけを残す。
      (err, _stdout, stderr) => {
        if (err) {
          reject(
            new Error(`Python生成器の実行に失敗: ${err.message}${stderr ? `\n${stderr}` : ''}`),
          );
          return;
        }
        resolve();
      },
    );
    child.on('error', reject);
  });
}

// ── 旧契約(JSON 引数・PENDING_DIR)。生成ルートが新しい契約へ移るまでの橋渡し ──

/** 旧契約で生成器へ渡す属性。 */
export interface LegacyGenerateAttributes {
  companyCode: string;
  fundCode: string;
  editionType: string;
  sourceFundCode?: string;
  isRedemption?: boolean;
}

/** 旧契約の呼び出し。書き先は `PENDING_DIR`。 */
export function generateTemplate(attrs: LegacyGenerateAttributes): Promise<string> {
  if (attrs.sourceFundCode) {
    assertTemplateAttributeToken('コピー元ファンドコード', attrs.sourceFundCode);
  }
  const output = path.join(
    config.pendingDir,
    assertSkeletonFileName(
      skeletonFileName({
        companyCode: assertTemplateAttributeToken('会社コード', attrs.companyCode),
        fundCode: assertTemplateAttributeToken('ファンドコード', attrs.fundCode),
        editionType: assertTemplateAttributeToken('版種', attrs.editionType),
      }),
    ),
  );
  const payload = {
    companyCode: attrs.companyCode,
    fundCode: attrs.fundCode,
    editionType: attrs.editionType,
    ...(attrs.sourceFundCode ? { sourceFundCode: attrs.sourceFundCode } : {}),
    ...(attrs.isRedemption ? { isRedemption: true } : {}),
  };
  return GENERATE_GATE.run(async () => {
    await assertGeneratorFingerprint();
    const before = await outputState(output);
    await runGenerator([JSON.stringify(payload)], { PENDING_DIR: config.pendingDir });
    const after = await outputState(output);
    const written =
      after?.isFile === true &&
      (before === null ||
        after.mtimeMs > before.mtimeMs ||
        after.ino !== before.ino ||
        after.digest !== before.digest);
    if (!written) {
      throw new Error(`Python生成器が ${path.basename(output)} を書き出していません`);
    }
    const html = await readFile(output, 'utf8');
    if (!html.trim()) throw new Error('Python生成器が空の出力を返しました');
    return html;
  });
}
