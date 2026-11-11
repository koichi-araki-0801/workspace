// =============================================================================
// fakeCreateReport.test.ts — 偽の create_report.py(fake_create_report.py)の入出力
// =============================================================================
// 実プロセスで起動する(Windows は py -3.13、それ以外は python3。`fakeGenerator.test.ts` と同じ)。
// e2e と LocalDB での検証の「値入り HTML の生成」「単体 PDF」がこれを通る。
import { execFile, execFileSync } from 'node:child_process';
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

type RunFlag = '--html-only' | '--pdf-only';

function run(
  root: string,
  fund: string,
  flag: RunFlag,
  options: { fromEditor?: boolean; stdin?: string } = {},
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
  const extra = options.fromEditor ? ['--from-editor'] : [];
  return new Promise((resolve) => {
    const child = execFile(
      BIN,
      [...BIN_ARGS, SCRIPT, '01281', fund, '2023-11-17', '交付版', flag, '--fund-only', ...extra],
      { encoding: 'utf8', timeout: 20_000, env },
      (err, stdout, stderr) => {
        const code = err ? Number((err as { code?: unknown }).code ?? 1) : 0;
        resolve({ code, stdout, stderr });
      },
    );
    child.stdin?.end(options.stdin ?? '');
  });
}

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.com',
};

function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'core.quotepath=false', ...args], {
    cwd: root,
    env: GIT_ENV,
    encoding: 'utf8',
  });
}

function gitRoot(name: string): string {
  const root = dataRoot(name);
  git(root, 'init', '-q');
  return root;
}

const ID = `XX01_${FUND}_20231117_交付版`;

describe('fake_create_report.py', () => {
  it('fake writes filled html with yyyymmdd name', async () => {
    const root = dataRoot('html');
    const r = await run(root, FUND, '--html-only', { fromEditor: true });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('');
    expect(fs.readdirSync(path.join(root, 'filled'))).toEqual([
      `XX01_${FUND}_20231117_交付版.html`,
    ]);
    expect(
      fs.readFileSync(path.join(root, 'filled', `XX01_${FUND}_20231117_交付版.html`), 'utf8'),
    ).toBe(SKELETON);
  }, 30_000);

  it('standalone html commits only the filled file', async () => {
    const root = gitRoot('sa-commit');
    fs.writeFileSync(path.join(root, 'templates', 'other.html'), 'o');
    git(root, 'add', 'templates/other.html');
    const r = await run(root, FUND, '--html-only');
    expect(r.code).toBe(0);
    const user = os.userInfo().username;
    expect(git(root, 'log', '-1', '--format=%ae%x09%s').trim()).toBe(
      `${user}@create_report.local	create_report（単独）で ${ID} を生成`,
    );
    expect(git(root, 'show', '--name-only', '--format=', 'HEAD').trim()).toBe(`filled/${ID}.html`);
  }, 30_000);

  it('standalone html stops on uncommitted change', async () => {
    const root = gitRoot('sa-dirty');
    expect((await run(root, FUND, '--html-only')).code).toBe(0);
    const file = path.join(root, 'filled', `${ID}.html`);
    fs.writeFileSync(file, 'hand edited');
    const r = await run(root, FUND, '--html-only');
    expect(r.code).toBe(4);
    expect(fs.readFileSync(file, 'utf8')).toBe('hand edited');
  }, 60_000);

  it('standalone html without repo writes and warns', async () => {
    const root = dataRoot('sa-norepo');
    const r = await run(root, FUND, '--html-only');
    expect(r.code).toBe(0);
    expect(fs.existsSync(path.join(root, 'filled', `${ID}.html`))).toBe(true);
    expect(r.stderr).not.toBe('');
  }, 30_000);

  it('editor html does not touch git', async () => {
    const root = gitRoot('ed-html');
    const r = await run(root, FUND, '--html-only', { fromEditor: true });
    expect(r.code).toBe(0);
    expect(() => git(root, 'rev-parse', '--verify', '-q', 'HEAD')).toThrow();
  }, 30_000);

  it('standalone pdf reads filled and writes pdf', async () => {
    const root = dataRoot('sa-pdf');
    expect((await run(root, FUND, '--pdf-only')).code).toBe(3);
    fs.mkdirSync(path.join(root, 'filled'));
    fs.writeFileSync(path.join(root, 'filled', `${ID}.html`), '<p>x</p>');
    expect((await run(root, FUND, '--pdf-only')).code).toBe(0);
    const pdf = fs.readFileSync(path.join(root, 'pdf', `${ID}.pdf`));
    expect(pdf.subarray(0, 8).toString()).toBe('%PDF-1.4');
  }, 30_000);

  it('editor pdf uses stdin and stdout only', async () => {
    const root = dataRoot('ed-pdf');
    const r = await run(root, FUND, '--pdf-only', { fromEditor: true, stdin: '<p>x</p>' });
    expect(r.code).toBe(0);
    expect(r.stdout.startsWith('%PDF-1.4')).toBe(true);
    expect(fs.existsSync(path.join(root, 'pdf'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'filled'))).toBe(false);
    expect((await run(root, FUND, '--pdf-only', { fromEditor: true })).code).toBe(3);
  }, 30_000);

  it('999104 writes non-pdf to stdout', async () => {
    const root = dataRoot('nonpdf', '999104');
    const r = await run(root, '999104', '--pdf-only', { fromEditor: true, stdin: '<p>x</p>' });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('not a pdf');
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
