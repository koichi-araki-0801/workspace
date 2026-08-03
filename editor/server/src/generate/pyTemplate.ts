// =============================================================================
// pyTemplate.ts — Python テンプレート生成器を child_process で呼び出す
// =============================================================================
import { execFile } from 'node:child_process';
import { assertTemplateId } from '@editor/shared';
import { config } from '../config.js';

interface GenerateAttributes {
  companyCode: string;
  fundCode: string;
  editionType: string;
  basedOnTemplateId?: string;
}

/**
 * 既存の Python テンプレート生成器を `child_process` 経由で呼び出す。属性は JSON 引数で
 * 渡し、生成されたテンプレート HTML は stdout から読む。
 * NOTE: `scripts/generate_template.py` は現状この JSON-in / HTML-out 契約を実装した
 * プレースホルダ。統合時は同じ I/O 契約を保ったまま本物の生成器に差し替える。
 */
export function generateTemplate(attrs: GenerateAttributes): Promise<string> {
  // `basedOnTemplateId` は生成器側で templates ディレクトリと連結して読まれる。request 由来の
  // ままだと任意ファイルの中身を新規テンプレートとして取り込めるため、渡す前に検査する
  // (Python 側にも basename + 実パス封じ込めの二重チェックを置いてある)。
  if (attrs.basedOnTemplateId) assertTemplateId(attrs.basedOnTemplateId);
  return new Promise((resolve, reject) => {
    const child = execFile(
      config.python.bin,
      [config.python.script, JSON.stringify(attrs)],
      {
        timeout: config.python.timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
        encoding: 'utf8',
        // Python ツールに UTF-8 出力を強制する(Windows の既定は cp932)。
        env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
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
