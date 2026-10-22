// =============================================================================
// fakeGenerator.test.ts — テスト用の偽の生成器(fake_generate_template.py)の入出力
// =============================================================================
// 実プロセスで起動する(Windows は py -3.13、それ以外は python3)。e2e と local の検証の
// 「新規作成」がこれを通る。本番の生成器と同じく位置引数・output/・実行ログで動くことを固定する。
// スクリプトは一時フォルダの `template/src/` へ写して起動し、リポジトリの output/ log/ を汚さない。
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { parseOutputNames } from '../src/generate/generatorLog.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(HERE, '../scripts/fake_generate_template.py');
const [BIN, BIN_ARGS]: [string, string[]] =
  process.platform === 'win32' ? ['py', ['-3.13']] : ['python3', []];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-fake-generator-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const REP1 = 'R-AM01';
const FUND = '510037';
const DATE = '2026-10-23';

interface Sandbox {
  src: string;
  output: string;
  log: string;
  templates: string;
}

/** 名前ごとに独立した template/ を作り、スクリプトを template/src/ へ写す。 */
function sandbox(name: string): Sandbox {
  const root = path.join(tmp, name, 'template');
  const src = path.join(root, 'src');
  fs.mkdirSync(src, { recursive: true });
  fs.copyFileSync(SCRIPT, path.join(src, 'fake_generate_template.py'));
  const templates = path.join(tmp, name, 'templates');
  fs.mkdirSync(templates, { recursive: true });
  return { src, output: path.join(root, 'output'), log: path.join(root, 'log'), templates };
}

function run(
  sb: Sandbox,
  args: string[],
  extraEnv: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const env: Record<string, string> = {
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8',
    TEMPLATES_DIR: sb.templates,
    ...extraEnv,
  };
  for (const key of ['PATH', 'SYSTEMROOT', 'TEMP', 'TMP']) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return new Promise((resolve) => {
    execFile(
      BIN,
      [...BIN_ARGS, path.join(sb.src, 'fake_generate_template.py'), ...args],
      { encoding: 'utf8', timeout: 20_000, env, cwd: sb.src },
      (err, stdout, stderr) => {
        const code = err ? Number((err as { code?: unknown }).code ?? 1) : 0;
        resolve({ code, stdout, stderr });
      },
    );
  });
}

const logFile = (sb: Sandbox, fund = FUND) =>
  path.join(sb.log, `build_${REP1}_${fund}_${DATE}.log`);
const readLog = (sb: Sandbox, fund = FUND) => fs.readFileSync(logFile(sb, fund), 'utf8');
const files = (sb: Sandbox) => (fs.existsSync(sb.output) ? fs.readdirSync(sb.output).sort() : []);
const argsLines = (text: string) => text.split('\n').filter((l) => l.includes('INFO args='));

describe('fake_generate_template.py', () => {
  it('両版を output/ に書き、ログに [OUTPUT] 行を追記する', async () => {
    const sb = sandbox('basic');
    const r = await run(sb, [REP1, FUND, DATE]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('');
    expect(files(sb)).toEqual(['AM01_510037_交付版.html', 'AM01_510037_全体版.html']);
    const html = fs.readFileSync(path.join(sb.output, 'AM01_510037_交付版.html'), 'utf8');
    expect(html).toContain('{{ fund.name }}');
    expect(html).toContain('href="../css/AM01_510037_交付版.css"');
    expect(parseOutputNames(readLog(sb))).toEqual([
      'AM01_510037_交付版.html',
      'AM01_510037_全体版.html',
    ]);
  }, 30_000);

  it('同じ日にもう一度走らせると同じログへ追記する', async () => {
    const sb = sandbox('append');
    await run(sb, [REP1, FUND, DATE]);
    await run(sb, [REP1, FUND, DATE]);
    expect(argsLines(readLog(sb))).toHaveLength(2);
  }, 30_000);

  it('空文字の位置引数が Python に空文字として届く', async () => {
    const sb = sandbox('empty-arg');
    const r = await run(sb, [REP1, FUND, DATE, '', '1']);
    expect(r.code).toBe(0);
    expect(argsLines(readLog(sb))[0]).toContain('args=["R-AM01","510037","2026-10-23","","1"]');
  }, 30_000);

  it('コピー元があれば TEMPLATES_DIR の両版を写す(会社の大小は問わない)', async () => {
    const sb = sandbox('source');
    fs.writeFileSync(path.join(sb.templates, 'am01_510037_交付版.html'), '<p>src-d</p>', 'utf8');
    fs.writeFileSync(path.join(sb.templates, 'AM01_510037_全体版.html'), '<p>src-z</p>', 'utf8');
    const r = await run(sb, [REP1, '510155', DATE, '510037']);
    expect(r.code).toBe(0);
    expect(fs.readFileSync(path.join(sb.output, 'AM01_510155_交付版.html'), 'utf8')).toBe(
      '<p>src-d</p>',
    );
    expect(fs.readFileSync(path.join(sb.output, 'AM01_510155_全体版.html'), 'utf8')).toBe(
      '<p>src-z</p>',
    );
  }, 30_000);

  it('コピー元が無ければ exit 2 で何も書かない', async () => {
    const sb = sandbox('nosource');
    fs.writeFileSync(path.join(sb.templates, 'AM01_510037_交付版.html'), '<p>d</p>', 'utf8');
    const r = await run(sb, [REP1, '510155', DATE, '510037']);
    expect(r.code).toBe(2);
    expect(files(sb)).toEqual([]);
  }, 30_000);

  it('999001 は組入先 999000 の両版も書く', async () => {
    const sb = sandbox('f1');
    expect((await run(sb, [REP1, '999001', DATE])).code).toBe(0);
    expect(files(sb)).toEqual([
      'AM01_999000_交付版.html',
      'AM01_999000_全体版.html',
      'AM01_999001_交付版.html',
      'AM01_999001_全体版.html',
    ]);
    expect(parseOutputNames(readLog(sb, '999001'))).toHaveLength(4);
  }, 30_000);

  it('999002 は他社 ZZ99 の交付版も書く', async () => {
    const sb = sandbox('f2');
    expect((await run(sb, [REP1, '999002', DATE])).code).toBe(0);
    expect(files(sb)).toContain('ZZ99_999002_交付版.html');
    expect(parseOutputNames(readLog(sb, '999002'))).toContain('ZZ99_999002_交付版.html');
  }, 30_000);

  it('999003 は交付版しか書かない', async () => {
    const sb = sandbox('f3');
    expect((await run(sb, [REP1, '999003', DATE])).code).toBe(0);
    expect(files(sb)).toEqual(['AM01_999003_交付版.html']);
  }, 30_000);

  it('999004 は全体版をログに載せるが書かない', async () => {
    const sb = sandbox('f4');
    expect((await run(sb, [REP1, '999004', DATE])).code).toBe(0);
    expect(files(sb)).toEqual(['AM01_999004_交付版.html']);
    expect(parseOutputNames(readLog(sb, '999004'))).toEqual([
      'AM01_999004_交付版.html',
      'AM01_999004_全体版.html',
    ]);
  }, 30_000);

  it('引数が 3 つ未満なら exit 2', async () => {
    const sb = sandbox('few');
    const r = await run(sb, [REP1, FUND]);
    expect(r.code).toBe(2);
    expect(files(sb)).toEqual([]);
  }, 30_000);

  it('区切り文字やパスが混ざればエラー(output/ の外へ書かない)', async () => {
    const sb = sandbox('bad');
    const r = await run(sb, [REP1, '../x', DATE]);
    expect(r.code).toBe(2);
    expect(files(sb)).toEqual([]);
  }, 30_000);

  it('コピー元を指定して TEMPLATES_DIR が無ければエラー', async () => {
    const sb = sandbox('nodir');
    const r = await run(sb, [REP1, '510155', DATE, '510037'], { TEMPLATES_DIR: '' });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('TEMPLATES_DIR');
  }, 30_000);
});
