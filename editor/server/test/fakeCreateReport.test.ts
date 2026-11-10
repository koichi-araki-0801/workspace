// =============================================================================
// fakeCreateReport.test.ts — 偽の create_report.py(fake_create_report.py)の入出力
// =============================================================================
// 実プロセスで起動する(Windows は py -3.13、それ以外は python3。`fakeGenerator.test.ts` と同じ)。
// e2e と LocalDB での検証の「値入り HTML の生成」「単体 PDF」がこれを通る。
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(HERE, '../scripts/fake_create_report.py');
const [BIN, BIN_ARGS]: [string, string[]] =
  process.platform === 'win32' ? ['py', ['-3.13']] : ['python3', []];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-fake-report-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const FUND = '880008';
const SKELETON = '<html><body>{{ fund.name }}</body></html>';

/** 名前ごとに独立した dataRoot を作り、templates/ にスケルトンを置く。 */
function dataRoot(name: string, fund = FUND): string {
  const root = path.join(tmp, name);
  fs.mkdirSync(path.join(root, 'templates'), { recursive: true });
  fs.writeFileSync(path.join(root, 'templates', `XX01_${fund}_交付版.html`), SKELETON);
  return root;
}

function run(
  root: string,
  fund: string,
  flag: '--html-only' | '--pdf-only',
): Promise<{ code: number; stdout: string; stderr: string }> {
  const env: Record<string, string> = {
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8',
    TEMPLATES_DIR: path.join(root, 'templates'),
  };
  for (const key of ['PATH', 'SYSTEMROOT', 'TEMP', 'TMP']) {
    const value = process.env[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return new Promise((resolve) => {
    execFile(
      BIN,
      [...BIN_ARGS, SCRIPT, '01281', fund, '2023-11-17', '交付版', flag, '--fund-only'],
      { encoding: 'utf8', timeout: 20_000, env },
      (err, stdout, stderr) => {
        const code = err ? Number((err as { code?: unknown }).code ?? 1) : 0;
        resolve({ code, stdout, stderr });
      },
    );
  });
}

describe('fake_create_report.py', () => {
  it('fake writes filled html with yyyymmdd name', async () => {
    const root = dataRoot('html');
    const r = await run(root, FUND, '--html-only');
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('');
    expect(fs.readdirSync(path.join(root, 'filled'))).toEqual([
      `XX01_${FUND}_20231117_交付版.html`,
    ]);
    expect(
      fs.readFileSync(path.join(root, 'filled', `XX01_${FUND}_20231117_交付版.html`), 'utf8'),
    ).toBe(SKELETON);
  }, 30_000);

  it('fake writes pdf from pdf-input', async () => {
    const root = dataRoot('pdf');
    const missing = await run(root, FUND, '--pdf-only');
    expect(missing.code).toBe(3);
    fs.mkdirSync(path.join(root, 'pdf-input'));
    fs.writeFileSync(path.join(root, 'pdf-input', `XX01_${FUND}_20231117_交付版.html`), '<p>x</p>');
    const r = await run(root, FUND, '--pdf-only');
    expect(r.code).toBe(0);
    const pdf = fs.readFileSync(path.join(root, 'pdf', `XX01_${FUND}_20231117_交付版.pdf`));
    expect(pdf.subarray(0, 8).toString()).toBe('%PDF-1.4');
  }, 30_000);

  it('fake exits 0 without output for 999103', async () => {
    const root = dataRoot('nothing', '999103');
    const r = await run(root, '999103', '--html-only');
    expect(r.code).toBe(0);
    expect(fs.existsSync(path.join(root, 'filled'))).toBe(false);
  }, 30_000);

  it('fake exits 1 for 999101', async () => {
    const root = dataRoot('fail', '999101');
    const r = await run(root, '999101', '--html-only');
    expect(r.code).toBe(1);
  }, 30_000);

  it('fake exits 2 when the skeleton is missing', async () => {
    const root = dataRoot('noskel');
    const r = await run(root, '880009', '--html-only');
    expect(r.code).toBe(2);
  }, 30_000);
});
