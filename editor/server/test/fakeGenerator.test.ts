// =============================================================================
// fakeGenerator.test.ts — テスト用の偽の生成器(fake_generate_template.py)の入出力
// =============================================================================
// 実プロセスで起動する(Windows は py -3.13、それ以外は python3)。e2e と local の検証の
// 「新規作成」がこれを通るので、元テンプレの読み先が TEMPLATES_DIR だけであることを固定する。
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(HERE, '../scripts/fake_generate_template.py');
const [BIN, BIN_ARGS]: [string, string[]] =
  process.platform === 'win32' ? ['py', ['-3.13']] : ['python3', []];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-fake-generator-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const ATTRS = {
  companyCode: 'AM01',
  fundCode: '510037',
  editionType: '交付版',
};

const pendingOf = (name: string) => path.join(tmp, name, 'pending');
const readOut = (name: string, id = 'AM01_510037_交付版') =>
  fs.readFileSync(path.join(pendingOf(name), `${id}.html`), 'utf8');

function run(
  attrs: Record<string, unknown>,
  extraEnv: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const env: Record<string, string> = { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', ...extraEnv };
  for (const key of ['PATH', 'SYSTEMROOT', 'TEMP', 'TMP']) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return new Promise((resolve) => {
    execFile(
      BIN,
      [...BIN_ARGS, SCRIPT, JSON.stringify(attrs)],
      { encoding: 'utf8', timeout: 20_000, env },
      (err, stdout, stderr) => {
        const code = err ? Number((err as { code?: unknown }).code ?? 1) : 0;
        resolve({ code, stdout, stderr });
      },
    );
  });
}

describe('fake_generate_template.py', () => {
  it('元テンプレ指定が無ければ属性入りのスケルトンを PENDING_DIR へ書き、標準出力には何も出さない', async () => {
    const r = await run(ATTRS, { PENDING_DIR: pendingOf('blank') });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('');
    expect(readOut('blank')).toContain('{{ fund.name }}');
    expect(readOut('blank')).toContain('ファンド: 510037');
    // 一時ファイルを残さない(名前の変更で置き換える)。
    expect(fs.readdirSync(pendingOf('blank'))).toEqual(['AM01_510037_交付版.html']);
  }, 30_000);

  it('書き出しに失敗したら一時ファイルを残さず、エラーで終わる', async () => {
    // 書き先の名前にフォルダを置き、名前の変更を失敗させる。
    fs.mkdirSync(path.join(pendingOf('fail'), 'AM01_510037_交付版.html'), { recursive: true });
    const r = await run(ATTRS, { PENDING_DIR: pendingOf('fail') });
    expect(r.code).not.toBe(0);
    expect(fs.readdirSync(pendingOf('fail'))).toEqual(['AM01_510037_交付版.html']);
  }, 30_000);

  it('PENDING_DIR が無ければエラー(書き先を勝手に決めない)', async () => {
    const r = await run(ATTRS, {});
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('PENDING_DIR');
  }, 30_000);

  it('sourceFundCode は templates/ の 会社_コピー元_版種.html を写す(会社コードの大小を問わず、旧形式は見ない)', async () => {
    const templates = path.join(tmp, 'templates-source');
    fs.mkdirSync(templates, { recursive: true });
    fs.writeFileSync(path.join(templates, 'am01_510037_交付版.html'), '<p>src</p>', 'utf8');
    fs.writeFileSync(
      path.join(templates, 'AM01_510037_20250101_交付版.html'),
      '<p>旧形式</p>',
      'utf8',
    );
    fs.writeFileSync(path.join(templates, 'AM01_510037_全体版.html'), '<p>版種違い</p>', 'utf8');
    const r = await run(
      { ...ATTRS, fundCode: '510155', sourceFundCode: '510037' },
      { TEMPLATES_DIR: templates, PENDING_DIR: pendingOf('source') },
    );
    expect(r.code).toBe(0);
    expect(readOut('source', 'AM01_510155_交付版')).toBe('<p>src</p>');
  }, 30_000);

  it('コピー元が旧形式(4 つ区切り)しか無ければエラーで、前の pending を残す', async () => {
    const templates = path.join(tmp, 'templates-legacy');
    fs.mkdirSync(templates, { recursive: true });
    fs.writeFileSync(
      path.join(templates, 'AM01_510037_20250101_交付版.html'),
      '<p>旧形式</p>',
      'utf8',
    );
    fs.mkdirSync(pendingOf('legacy'), { recursive: true });
    fs.writeFileSync(
      path.join(pendingOf('legacy'), 'AM01_510037_交付版.html'),
      '<p>前の生成物</p>',
      'utf8',
    );
    const r = await run(
      { ...ATTRS, sourceFundCode: '510037' },
      { TEMPLATES_DIR: templates, PENDING_DIR: pendingOf('legacy') },
    );
    expect(r.code).toBe(2);
    expect(readOut('legacy')).toBe('<p>前の生成物</p>');
  }, 30_000);

  it('属性に区切り文字やパスが混ざればエラー(PENDING_DIR の外へ書かない)', async () => {
    const r = await run({ ...ATTRS, fundCode: '../x' }, { PENDING_DIR: pendingOf('bad') });
    expect(r.code).toBe(2);
  }, 30_000);

  it('TEMPLATES_DIR が無ければ sourceFundCode はエラー(既定の置き場を黙って読まない)', async () => {
    const r = await run(
      { ...ATTRS, sourceFundCode: '510037' },
      { PENDING_DIR: pendingOf('nodir') },
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('TEMPLATES_DIR');
  }, 30_000);

  it('sourceFundCode のコピー元が無い・規約外ならエラー', async () => {
    const templates = path.join(tmp, 'templates-empty');
    fs.mkdirSync(templates, { recursive: true });
    const env = { TEMPLATES_DIR: templates, PENDING_DIR: pendingOf('empty') };
    const missing = await run({ ...ATTRS, sourceFundCode: '999999' }, env);
    expect(missing.code).toBe(2);
    const bad = await run({ ...ATTRS, sourceFundCode: '../x' }, env);
    expect(bad.code).toBe(2);
  }, 30_000);
});
