// =============================================================================
// fsHelpers.test.ts — 「無ければ既定値」の範囲(ENOENT だけ倒す / stat 系は全て倒す)
// =============================================================================
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fileExists, readOrMissing, statMtime } from '../src/files/fsHelpers.js';

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'editor-fsh-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('fsHelpers', () => {
  it('statMtime: あれば ISO 文字列、無ければ null', async () => {
    const p = path.join(dir, 'a.txt');
    await fs.writeFile(p, 'x');
    expect(await statMtime(p)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(await statMtime(path.join(dir, 'none'))).toBeNull();
  });

  it('fileExists: あれば true、無ければ false', async () => {
    const p = path.join(dir, 'a.txt');
    await fs.writeFile(p, 'x');
    expect(await fileExists(p)).toBe(true);
    expect(await fileExists(path.join(dir, 'none'))).toBe(false);
  });

  it('readOrMissing: 読めれば本文、ENOENT だけ fallback', async () => {
    const p = path.join(dir, 'a.txt');
    await fs.writeFile(p, '本文');
    expect(await readOrMissing(p, '')).toBe('本文');
    expect(await readOrMissing(path.join(dir, 'none'), '')).toBe('');
    expect(await readOrMissing(path.join(dir, 'none'), null)).toBeNull();
  });

  it('readOrMissing: ENOENT 以外(ディレクトリを読む EISDIR 等)は投げる', async () => {
    await expect(readOrMissing(dir, '')).rejects.toThrow();
  });
});
