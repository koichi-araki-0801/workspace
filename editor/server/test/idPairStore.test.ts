// =============================================================================
// idPairStore.test.ts — `<dir>/<id>.{html,css}` ストアの検査・読み分け・破棄
// =============================================================================
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createIdPairStore } from '../src/files/idPairStore.js';

const ID = 'acme_fund1_full';
let root: string;
let dir: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'editor-idpair-'));
  dir = path.join(root, 'store');
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('createIdPairStore', () => {
  it('write → read → mtime → listIds → remove', async () => {
    const store = createIdPairStore(() => dir);
    await store.write(ID, '<p>h</p>', 'p{}');
    expect(await store.read(ID)).toEqual({ html: '<p>h</p>', css: 'p{}', cssFound: true });
    expect(await store.mtime(ID)).toMatch(/^\d{4}-/);
    expect(await store.listIds()).toEqual([ID]);
    await store.remove(ID);
    expect(await store.read(ID)).toBeNull();
    expect(await store.mtime(ID)).toBeNull();
    expect(await store.listIds()).toEqual([]);
    await store.remove(ID);
  });

  it('CSS だけ無いときは空文字・cssFound false、HTML が無ければ null', async () => {
    const store = createIdPairStore(() => dir);
    await store.write(ID, 'h', 'c');
    await fs.rm(path.join(dir, `${ID}.css`));
    expect(await store.read(ID)).toEqual({ html: 'h', css: '', cssFound: false });
    await fs.rm(path.join(dir, `${ID}.html`));
    expect(await store.read(ID)).toBeNull();
  });

  it('規約外の id: 読み取り系は無し扱い、write/remove は例外でディレクトリも作らない', async () => {
    const store = createIdPairStore(() => dir);
    expect(await store.read('../x')).toBeNull();
    expect(await store.mtime('../x')).toBeNull();
    await expect(store.write('../x', 'h', 'c')).rejects.toThrow();
    await expect(store.remove('../x')).rejects.toThrow();
    await expect(fs.stat(dir)).rejects.toThrow();
  });

  it('listIds: ディレクトリが無ければ空、規約外の名前と .html 以外は捨てる', async () => {
    const store = createIdPairStore(() => dir);
    expect(await store.listIds()).toEqual([]);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${ID}.html`), 'h');
    await fs.writeFile(path.join(dir, `${ID}.css`), 'c');
    await fs.writeFile(path.join(dir, 'bad name.html'), 'h');
    expect(await store.listIds()).toEqual([ID]);
  });

  it('dir は呼び出しごとに評価する', async () => {
    let cur = path.join(root, 'one');
    const store = createIdPairStore(() => cur);
    await store.write(ID, 'h', 'c');
    cur = path.join(root, 'two');
    expect(await store.read(ID)).toBeNull();
  });
});
