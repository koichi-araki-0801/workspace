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
  baseDate: '20261001',
};

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
  it('元テンプレ指定が無ければ属性入りのスケルトンを出す', async () => {
    const r = await run(ATTRS, {});
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('{{ fund.name }}');
    expect(r.stdout).toContain('ファンド: 510037');
  }, 30_000);

  it('sourceFundCode はコピー元ファンドの基準日が最新のテンプレートを写す(会社コードの大小を問わない)', async () => {
    const templates = path.join(tmp, 'templates-source');
    fs.mkdirSync(templates, { recursive: true });
    fs.writeFileSync(
      path.join(templates, 'AM01_510037_20240101_交付版.html'),
      '<p>old</p>',
      'utf8',
    );
    fs.writeFileSync(
      path.join(templates, 'am01_510037_20250101_交付版.html'),
      '<p>new</p>',
      'utf8',
    );
    fs.writeFileSync(
      path.join(templates, 'AM01_510037_20260101_全体版.html'),
      '<p>版種違い</p>',
      'utf8',
    );
    const r = await run(
      { ...ATTRS, fundCode: '510155', sourceFundCode: '510037' },
      { TEMPLATES_DIR: templates },
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('<p>new</p>');
  }, 30_000);

  it('sourceFundCode のコピー元が無い・規約外ならエラー', async () => {
    const templates = path.join(tmp, 'templates-empty');
    fs.mkdirSync(templates, { recursive: true });
    const missing = await run({ ...ATTRS, sourceFundCode: '999999' }, { TEMPLATES_DIR: templates });
    expect(missing.code).toBe(2);
    const bad = await run({ ...ATTRS, sourceFundCode: '../x' }, { TEMPLATES_DIR: templates });
    expect(bad.code).toBe(2);
  }, 30_000);

  it('元テンプレは TEMPLATES_DIR の <id>.html を読む', async () => {
    const templates = path.join(tmp, 'templates');
    fs.mkdirSync(templates, { recursive: true });
    fs.writeFileSync(
      path.join(templates, 'AM01_510037_20240710_交付版.html'),
      '<p>元テンプレ</p>',
      'utf8',
    );
    const r = await run(
      { ...ATTRS, basedOnTemplateId: 'AM01_510037_20240710_交付版' },
      { TEMPLATES_DIR: templates },
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('<p>元テンプレ</p>');
  }, 30_000);

  it('TEMPLATES_DIR が無ければ元テンプレ指定はエラー(既定の置き場を黙って読まない)', async () => {
    const r = await run({ ...ATTRS, basedOnTemplateId: 'AM01_510037_20240710_交付版' }, {});
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('TEMPLATES_DIR');
    expect(r.stdout).toBe('');
  }, 30_000);

  it('置き場の外を指す元テンプレ指定はエラー', async () => {
    const r = await run({ ...ATTRS, basedOnTemplateId: '../outside' }, { TEMPLATES_DIR: tmp });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('invalid basedOnTemplateId');
  }, 30_000);
});
