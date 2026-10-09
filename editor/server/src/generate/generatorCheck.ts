// =============================================================================
// generatorCheck.ts — 起動時に生成器の Python と指紋の設定を 1 回だけ確かめてログへ出す
// =============================================================================
// 生成器を起動できない環境(PATH に python が無い・PATH で先に見つかる python が 3.13 でない・
// Microsoft Store の偽物 WindowsApps\python.exe に解決される)は、最初の「新規作成」まで誰も
// 気づかない。起動ログで先に知らせる。起動は止めない — 生成を使わない運用(local・閲覧専用)
// まで止まるため。
import { execFile } from 'node:child_process';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { generatorEnv } from './pyTemplate.js';

/**
 * 生成器が前提とする Python の版。既定の起動コマンド(PATH 上の python)は版を指定しないので、
 * ここで確かめる。
 */
export const EXPECTED_PYTHON_VERSION = '3.13';

const VERSION_PROBE = "import sys; print('%d.%d' % sys.version_info[:2])";
const PROBE_TIMEOUT_MS = 10_000;
/** テスト用の偽の生成器のファイル名。本番で差し替え忘れると偽物が黙ってテンプレを作る。 */
const FAKE_GENERATOR_BASENAME = 'fake_generate_template.py';

/** 確認結果の出力先(既定はサーバのロガー。テストで差し替える)。 */
interface StartupLog {
  info(msg: string): void;
  warn(msg: string): void;
}

/** `<bin> <args> -c <probe>` で版を取る。起動できなければ理由を返す(reject しない)。 */
function probePythonVersion(): Promise<{ version: string } | { failure: string }> {
  return new Promise((resolve) => {
    const child = execFile(
      config.python.bin,
      [...config.python.args, '-c', VERSION_PROBE],
      { timeout: PROBE_TIMEOUT_MS, encoding: 'utf8', env: generatorEnv() },
      (err, stdout, stderr) => {
        if (err) {
          const code = (err as { code?: unknown }).code;
          const detail = stderr.trim();
          if ((err as { killed?: unknown }).killed === true) {
            resolve({ failure: `${PROBE_TIMEOUT_MS / 1000} 秒以内に応答がありません` });
            return;
          }
          resolve({
            failure:
              `${err.message}${code === undefined ? '' : ` [code=${String(code)}]`}` +
              `${detail === '' ? '' : ` ${detail}`}`,
          });
          return;
        }
        resolve({ version: stdout.trim() });
      },
    );
    child.on('error', (err) => resolve({ failure: err.message }));
  });
}

/**
 * 生成器の Python の版と指紋の設定を確かめ、結果をログへ出す。reject しない — 呼び出し側は
 * 待たずに投げるため、ここで例外を漏らすと unhandled rejection でプロセスが落ちる。
 */
export async function checkGeneratorAtStartup(log: StartupLog = logger): Promise<void> {
  try {
    await runChecks(log);
  } catch (err) {
    logger.warn(
      `[generate] 生成器の起動時確認に失敗しました: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function runChecks(log: StartupLog): Promise<void> {
  const command = [config.python.bin, ...config.python.args].join(' ');
  const probe = await probePythonVersion();
  if ('failure' in probe) {
    log.warn(
      `[generate] 生成器の Python を起動できません(${command}): ${probe.failure} — ` +
        '作成タブの「新規作成」は失敗します。Python 3.13 を入れてユーザー環境変数 PATH に通し' +
        '(WindowsApps の python より前)、新しいコマンドプロンプトからサーバを起動し直すか、' +
        'PYTHON_BIN / appconfig の python.bin・python.args を確認してください',
    );
  } else if (probe.version !== EXPECTED_PYTHON_VERSION) {
    log.warn(
      `[generate] 生成器の Python が ${probe.version} です(${command})。` +
        `${EXPECTED_PYTHON_VERSION} を前提にしています — PATH で先に見つかる python が ` +
        `${EXPECTED_PYTHON_VERSION} になるよう PATH を直す(システム PATH はユーザー PATH より先に` +
        `探されます)か、PYTHON_BIN に ${EXPECTED_PYTHON_VERSION} の python.exe を指定してください`,
    );
  } else {
    log.info(`[generate] 生成器の Python: ${probe.version}(${command})`);
  }
  if (config.python.scriptSha256 === undefined) {
    log.warn(
      `[generate] 生成器の指紋が未設定です(${config.python.script})。共有フォルダ上の生成器を` +
        '使うなら PY_GENERATE_SCRIPT_SHA256 / appconfig の python.scriptSha256 の設定を推奨します',
    );
  }
  // Windows のパスはバックスラッシュ区切りなので、実行環境に関わらず両方の区切りで切る。
  const scriptName = config.python.script.split(/[\\/]/).pop() ?? '';
  if (scriptName.toLowerCase() === FAKE_GENERATOR_BASENAME) {
    log.warn(
      `[generate] 生成器が偽物(テスト用)のままです(${config.python.script})。` +
        '本番では PY_GENERATE_SCRIPT で既存の生成器を指してください',
    );
  }
}
