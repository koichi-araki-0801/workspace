// =============================================================================
// pyTemplate.ts — Python テンプレート生成器を child_process で呼び出す
// =============================================================================
// 生成器は社内の共有フォルダなどに置かれた既存ツールで、editor はそのパスを設定
// (`config.python.script`)で指すだけ。子プロセスへ渡すものは「起動に要る環境変数」と
// 「ルートで検証した属性」だけに絞る。`process.env` を丸ごと渡すと、HTTPS のパスフレーズや
// DB 接続の追加文字列を共有上のコードが読める。秘密値だけを削る拒否リストにしないのは、
// 秘密値が増えたときに黙って漏れるため。
//
// 生成器はテンプレートを `PENDING_DIR/<会社_ファンド_版種>.html` に一時ファイル → 名前の変更で書き、
// editor はこの呼び出しで書かれたことを確かめてから読む。標準出力の HTML は使わない(書きかけや
// 前回の生成物を受け取らないため)。
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  assertSkeletonFileName,
  assertTemplateAttributeToken,
  skeletonFileName,
} from '@editor/shared';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { BuildAdmissionGate } from '../vivliostyle/buildAdmission.js';

/**
 * 生成器へ渡す属性。ルート(`generate.routes.ts`)で検証した値だけ。テンプレートは基準日を
 * 持たないので基準日は渡さない。
 */
export interface GenerateAttributes {
  companyCode: string;
  fundCode: string;
  editionType: string;
  /** シリーズから作成するときのコピー元ファンドコード(会社と版種は作成先と同じ)。 */
  sourceFundCode?: string;
  /** 償還ファンドとして作成するか。true のときだけ生成器へ渡す。 */
  isRedemption?: boolean;
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
 * `PENDING_DIR` は生成器の書き先。サーバの本当の置き場(`config.pendingDir`)を渡す。
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
  env.PENDING_DIR = config.pendingDir;
  return env;
}

/** 生成器へ渡す JSON を明示したキーだけで組む(呼び出し元のオブジェクトを素通ししない)。 */
function toGeneratorPayload(attrs: GenerateAttributes): GenerateAttributes {
  return {
    companyCode: attrs.companyCode,
    fundCode: attrs.fundCode,
    editionType: attrs.editionType,
    ...(attrs.sourceFundCode ? { sourceFundCode: attrs.sourceFundCode } : {}),
    ...(attrs.isRedemption ? { isRedemption: true } : {}),
  };
}

/**
 * 出力ファイルの状態(無ければ null)。シンボリックリンクは辿らない(`lstat`)。内容の指紋も持つのは、
 * 更新時刻の粒度が粗くファイル番号を返さない(`ino` が 0 の)ドライブでも書き直しを見分けるため。
 */
async function outputState(
  file: string,
): Promise<{ mtimeMs: number; ino: number; isFile: boolean; digest: string } | null> {
  try {
    const s = await lstat(file);
    const digest = s.isFile()
      ? createHash('sha256')
          .update(await readFile(file))
          .digest('hex')
      : '';
    return { mtimeMs: s.mtimeMs, ino: s.ino, isFile: s.isFile(), digest };
  } catch {
    return null;
  }
}

/**
 * 生成器を呼び出す。属性は JSON 引数で渡し、生成器は `PENDING_DIR/<会社_ファンド_版種>.html` を書く。
 * 読み先は検証済みの属性からここで組む(生成器に決めさせない)。終了コード 0 でも、そのファイルが
 * この呼び出しで書かれていなければ(呼び出し前からある古いファイルのまま・書かれていない・通常の
 * ファイルでない)失敗にする。前回の生成物を新しい出力と取り違えないため。
 */
export function generateTemplate(attrs: GenerateAttributes): Promise<string> {
  // `sourceFundCode` は生成器側でファイル名の照合に使われる。ルートでも検査するが、ここを別の
  // 呼び出し元から使われても区切り文字を持ち込ませないよう、渡す前にもう一度検査する
  // (Python 側にも区切り文字の検査がある)。会社・ファンド・版種も同じ理由でここで検査し、
  // 読み先が pending/ の外へ出ないことを名前の検査(`assertSkeletonFileName`)でも保つ。
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
  const payload = toGeneratorPayload(attrs);
  // 指紋の照合は枠を取った後・起動の直前に行う(待ち行列にいる間の差し替えも拾う)。
  return GENERATE_GATE.run(async () => {
    await assertGeneratorFingerprint();
    // 書かれたかの比較の基準は、起動の直前に取る(待ち行列の間に別の生成が書いた分を混ぜない)。
    const before = await outputState(output);
    await runGenerator(payload);
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

function runGenerator(payload: GenerateAttributes): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      config.python.bin,
      [...config.python.args, config.python.script, JSON.stringify(payload)],
      {
        timeout: config.python.timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
        encoding: 'utf8',
        env: generatorEnv(),
      },
      // 標準出力は使わない(出力は PENDING_DIR のファイル)。失敗時の stderr だけを残す。
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
