// =============================================================================
// valuesFile.test.ts — 編集タブの値ファイル(json/)の読み取り層の単体テスト
// =============================================================================
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-values-file-'));
process.env.DATA_ROOT = tmp;
process.env.JSON_DIR = path.join(tmp, 'json');

const ID = 'XX01_950037_20240710_交付版';

describe('json/ の読み取り層', () => {
  let mod: typeof import('../src/files/valuesFile.js');

  const put = (id: string, body: string) =>
    fs.writeFileSync(path.join(tmp, 'json', `${id}.json`), body, 'utf8');

  beforeAll(async () => {
    mod = await import('../src/files/valuesFile.js');
    fs.mkdirSync(path.join(tmp, 'json'), { recursive: true });
    put(ID, JSON.stringify({ fund: { code: '950037' } }));
    put('XX01_950037_20240710_全体版', '{broken');
    put('XX01_950037_20240710_大', `{"x":"${'a'.repeat(5 * 1024 * 1024)}"}`);
    put('XX01_950037_20240710_配列', '[1,2]');
  });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('ID の json を読んで found: true で返す', async () => {
    expect(await mod.readTemplateValues(ID)).toEqual({
      found: true,
      values: { fund: { code: '950037' } },
    });
  });

  it('無ければ found: false と空の values', async () => {
    expect(await mod.readTemplateValues('XX01_999999_20240710_交付版')).toEqual({
      found: false,
      values: {},
    });
  });

  it('3 区切りの ID・.. ・区切り文字を含む ID は読まずに validation', async () => {
    for (const bad of ['XX01_950037_交付版', '../x', 'a/b', 'a\b', 'XX01_..']) {
      await expect(mod.readTemplateValues(bad)).rejects.toMatchObject({ kind: 'validation' });
    }
  });

  it('上限を超えるファイルは読まずに validation', async () => {
    await expect(mod.readTemplateValues('XX01_950037_20240710_大')).rejects.toMatchObject({
      kind: 'validation',
    });
  });

  it('壊れた JSON と object でない JSON は validation', async () => {
    await expect(mod.readTemplateValues('XX01_950037_20240710_全体版')).rejects.toMatchObject({
      kind: 'validation',
    });
    await expect(mod.readTemplateValues('XX01_950037_20240710_配列')).rejects.toMatchObject({
      kind: 'validation',
    });
  });

  it('ENOENT 以外の I/O 失敗は「無い」と取り違えずそのまま投げる', async () => {
    const eacces = Object.assign(new Error('denied'), { code: 'EACCES' });
    const spy = vi.spyOn(fsp, 'stat').mockRejectedValueOnce(eacces);
    await expect(mod.readTemplateValues(ID)).rejects.toBe(eacces);
    spy.mockRestore();
  });
});
