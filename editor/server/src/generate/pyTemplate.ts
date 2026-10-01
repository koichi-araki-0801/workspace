// =============================================================================
// pyTemplate.ts — Python テンプレート生成器を child_process で呼び出す
// =============================================================================
// 生成器は社内の共有フォルダなどに置かれた既存ツールで、editor はそのパスを設定
// (`config.python.script`)で指すだけ。子プロセスへ渡すものは「起動に要る環境変数」と
// 「ルートで検証した属性」だけに絞る。`process.env` を丸ごと渡すと、HTTPS のパスフレーズや
// DB 接続の追加文字列を共有上のコードが読める。秘密値だけを削る拒否リストにしないのは、
// 秘密値が増えたときに黙って漏れるため。
import { execFile } from 'node:child_process';
import { assertTemplateId } from '@editor/shared';
import { config } from '../config.js';

/** 生成器へ渡す属性。ルート(`generate.routes.ts`)で検証した値とサーバが決めた基準日だけ。 */
export interface GenerateAttributes {
  companyCode: string;
  fundCode: string;
  editionType: string;
  /** サーバの現在日(`yyyyMMdd`)。ファイル名・台帳の基準日と同じ値を生成器にも見せる。 */
  baseDate: string;
  basedOnTemplateId?: string;
}

/**
 * 親から引き継ぐ環境変数。Windows で py ランチャと Python が動く最小限
 * (`SYSTEMROOT` が無いと Python の乱数・ソケットの初期化が失敗する)。
 */
const INHERITED_ENV_KEYS = ['PATH', 'SYSTEMROOT', 'TEMP', 'TMP', 'PATHEXT', 'COMSPEC'] as const;

/**
 * 生成器(と起動時の版確認)の子プロセスへ渡す環境変数を組む。`TEMPLATES_DIR` は元テンプレ指定
 * (`basedOnTemplateId`)の読み先で、サーバの本当の置き場(`config.templatesDir`)を必ず渡す。
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

/** 生成器へ渡す JSON を明示したキーだけで組む(呼び出し元のオブジェクトを素通ししない)。 */
function toGeneratorPayload(attrs: GenerateAttributes): GenerateAttributes {
  return {
    companyCode: attrs.companyCode,
    fundCode: attrs.fundCode,
    editionType: attrs.editionType,
    baseDate: attrs.baseDate,
    ...(attrs.basedOnTemplateId ? { basedOnTemplateId: attrs.basedOnTemplateId } : {}),
  };
}

/**
 * 生成器を呼び出す。属性は JSON 引数で渡し、生成されたテンプレート HTML は stdout から読む
 * (入出力の約束。テスト用の偽物は `config.python.script` の既定)。
 */
export function generateTemplate(attrs: GenerateAttributes): Promise<string> {
  // `basedOnTemplateId` は生成器側で templates ディレクトリと連結して読まれる。ルートでも検査
  // するが、ここを別の呼び出し元から使われても任意ファイルを取り込ませないよう、渡す前に
  // もう一度検査する(Python 側にも basename + 実パス封じ込めの検査がある)。
  if (attrs.basedOnTemplateId) assertTemplateId(attrs.basedOnTemplateId);
  return runGenerator(toGeneratorPayload(attrs));
}

function runGenerator(payload: GenerateAttributes): Promise<string> {
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
      (err, stdout, stderr) => {
        if (err) {
          reject(
            new Error(`Python生成器の実行に失敗: ${err.message}${stderr ? `\n${stderr}` : ''}`),
          );
          return;
        }
        if (!stdout.trim()) {
          reject(new Error('Python生成器が空の出力を返しました'));
          return;
        }
        resolve(stdout);
      },
    );
    child.on('error', reject);
  });
}
