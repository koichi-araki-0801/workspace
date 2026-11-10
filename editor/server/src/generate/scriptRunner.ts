// =============================================================================
// scriptRunner.ts — Python スクリプトの起動部品(指紋の照合・子プロセス起動・同時実行の枠)
// =============================================================================
// 作成タブのテンプレート生成器(`pyTemplate.ts`)が使う、スクリプトを安全に起動するための部品。
// 子プロセスへ渡す環境変数は許可リストで絞る。`process.env` を丸ごと渡すと、HTTPS のパスフレーズや
// DB 接続の追加文字列を共有上のコードが読める。秘密値だけを削る拒否リストにしないのは、
// 秘密値が増えたときに黙って漏れるため。同時実行の枠は全スクリプトで 1 つを共有する。
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { BuildAdmissionGate } from '../vivliostyle/buildAdmission.js';

/** 起動するスクリプトの指定。指紋が `undefined` のときは照合しない。 */
export interface ScriptSpec {
  script: string;
  scriptSha256: string | undefined;
  timeoutMs: number;
}

/**
 * 指紋が合わないときに利用者へ出す文言(スクリプトの差し替えは管理者の対応事項)。
 * テストから直接検証するために公開する。
 * @public
 */
export const GENERATOR_FINGERPRINT_MISMATCH_MESSAGE =
  'テンプレート生成器の指紋が設定と一致しないため、生成を中止しました。管理者に連絡してください';

/**
 * 生成の待ち行列が満杯のときに利用者へ出す文言(PDF ビルドの満杯時と同じ形)。
 * テストから直接検証するために公開する。
 */
export const GENERATE_QUEUE_FULL_MESSAGE =
  'テンプレート生成の順番待ちが混み合っています。しばらく待ってから再実行してください';

/**
 * 利用者へそのまま出せる文言と状態コードを持つ Error。`errorHandler` は `kind` を持つ値の
 * `message` を応答に使い、数値の `statusCode` を状態コードに使う。Error のインスタンスに
 * するのは、`auditedRethrow` が監査ログへ `message` を残すため。
 */
function generatorError(message: string, code: string, statusCode: number): Error {
  return Object.assign(new Error(message), { kind: 'unexpected' as const, code, statusCode });
}

/**
 * スクリプトの指紋を照合する(指紋の設定が無ければ何もしない)。起動のたびに読むのは、
 * 照合から起動までの間に共有上のスクリプトを差し替えられる幅を狭めるため。読めないときも
 * 拒否する — 照合できないスクリプトを起動すると、指紋を設定した意味が消える。
 */
export async function assertScriptFingerprint(spec: ScriptSpec): Promise<void> {
  const expected = spec.scriptSha256;
  if (expected === undefined) {
    return;
  }
  const script = spec.script;
  let actual: string;
  try {
    actual = createHash('sha256')
      .update(await readFile(script))
      .digest('hex');
  } catch (err) {
    logger.error(
      { err, script },
      `[generate] ${path.basename(script)} を読めず指紋を照合できません — 生成を拒否しました`,
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
      `[generate] ${path.basename(script)} の指紋が設定と一致しません — 生成を拒否しました`,
    );
    throw generatorError(
      GENERATOR_FINGERPRINT_MISMATCH_MESSAGE,
      'GENERATOR_FINGERPRINT_MISMATCH',
      500,
    );
  }
}

/**
 * 生成の受付制御。上限が無いと、同時に押された数だけ Python が立ち上がる。満杯なら待たせずに
 * 503 で断る — 待たせると、待つ間ずっと HTTP 接続とリクエストを握り続ける。
 */
const GENERATE_GATE = new BuildAdmissionGate({
  maxConcurrent: config.python.maxConcurrency,
  maxQueue: config.python.maxQueue,
  queueFullError: () => generatorError(GENERATE_QUEUE_FULL_MESSAGE, 'GENERATE_QUEUE_FULL', 503),
});

/** 同時実行の枠を取って `fn` を走らせる。満杯なら `GENERATE_QUEUE_FULL`(503)で断る。 */
export function withGeneratorSlot<T>(fn: () => Promise<T>): Promise<T> {
  return GENERATE_GATE.run(fn);
}

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
    if (value !== undefined) {
      env[key] = value;
    }
  }
  // Python ツールに UTF-8 出力を強制する(Windows の既定は cp932)。
  env.PYTHONUTF8 = '1';
  env.PYTHONIOENCODING = 'utf-8';
  env.TEMPLATES_DIR = config.templatesDir;
  return env;
}

/** スクリプトの起動の失敗。`timedOut` は時間切れで殺されたとき、`stderr` は失敗時の標準エラー。 */
export class ScriptRunError extends Error {
  readonly timedOut: boolean;
  readonly stderr: string;

  constructor(message: string, timedOut: boolean, stderr: string) {
    super(message);
    this.name = 'ScriptRunError';
    this.timedOut = timedOut;
    this.stderr = stderr;
  }
}

/**
 * `config.python.bin` でスクリプトを起動し、終了まで待つ。cwd はスクリプトのあるフォルダ。
 * 標準出力は使わない(出力はファイルと実行ログ)。失敗時の stderr だけを `ScriptRunError` に残す。
 */
export function runPythonScript(spec: ScriptSpec, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      config.python.bin,
      [...config.python.args, spec.script, ...args],
      {
        cwd: path.dirname(spec.script),
        timeout: spec.timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
        encoding: 'utf8',
        env: generatorEnv(),
      },
      (err, _stdout, stderr) => {
        if (err) {
          reject(new ScriptRunError(err.message, err.killed === true, stderr));
          return;
        }
        resolve();
      },
    );
    child.on('error', reject);
  });
}
