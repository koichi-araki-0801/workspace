// =============================================================================
// filledFiles.test.ts — 値入り HTML(filled/)の読み取り層の単体テスト
// =============================================================================
// `templateFiles.ts` の filled 版が templates 版と同じ規約(名前検査の内蔵・ENOENT は空文字・
// 一覧は拡張子で絞る)で動くことを固定する。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-filled-files-'));
process.env.DATA_ROOT = tmp;
process.env.FILLED_DIR = path.join(tmp, 'filled');

const ID = 'AM01_510037_20240710_交付版';

describe('filled/ の読み取り層', () => {
  let mod: typeof import('../src/files/templateFiles.js');

  beforeAll(async () => {
    mod = await import('../src/files/templateFiles.js');
    fs.mkdirSync(path.join(tmp, 'filled'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'filled', `${ID}.html`), '<p>値入り</p>', 'utf8');
    fs.writeFileSync(path.join(tmp, 'filled', 'memo.txt'), 'x', 'utf8');
  });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('filledPath は filledDir と連結し、規約外の名前は例外にする', () => {
    expect(mod.filledPath(`${ID}.html`)).toBe(path.join(tmp, 'filled', `${ID}.html`));
    expect(() => mod.filledPath('../x.html')).toThrow();
  });

  it('listFilledFiles は *.html だけを返す', async () => {
    expect(await mod.listFilledFiles()).toEqual([`${ID}.html`]);
  });

  it('readFilledHtml は本文を返し、無いファイルと規約外の名前は空文字にする', async () => {
    expect(await mod.readFilledHtml(`${ID}.html`)).toBe('<p>値入り</p>');
    expect(await mod.readFilledHtml('AM01_999999_20240710_交付版.html')).toBe('');
    expect(await mod.readFilledHtml('../x.html')).toBe('');
  });

  it('filledExists / filledMtime は有無を返す', async () => {
    expect(await mod.filledExists(`${ID}.html`)).toBe(true);
    expect(await mod.filledExists('AM01_999999_20240710_交付版.html')).toBe(false);
    expect(await mod.filledMtime(`${ID}.html`)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(await mod.filledMtime('../x.html')).toBeNull();
  });
});
