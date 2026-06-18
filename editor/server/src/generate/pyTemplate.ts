import { execFile } from 'node:child_process';
import { config } from '../config.js';

export interface GenerateAttributes {
  companyCode: string;
  fundCode: string;
  editionType: string;
  basedOnTemplateId?: string;
}

/**
 * Invoke the existing Python template generator via child_process. Attributes
 * are passed as a JSON argument; the generated template HTML is read from
 * stdout. NOTE: scripts/generate_template.py is currently a placeholder
 * implementing this JSON-in / HTML-out contract; swap in the real generator
 * there (keeping the same I/O contract) when it is integrated.
 */
export function generateTemplate(attrs: GenerateAttributes): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      config.python.bin,
      [config.python.script, JSON.stringify(attrs)],
      {
        timeout: config.python.timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
        encoding: 'utf8',
        // Force the Python tool to emit UTF-8 (Windows defaults to cp932).
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
