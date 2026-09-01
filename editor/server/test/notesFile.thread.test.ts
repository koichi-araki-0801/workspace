// =============================================================================
// notesFile.thread.test.ts — 追記型スレッドのファイル形式と旧形式からの遅延変換
// =============================================================================
// メモは `dataRoot/notes/<templateId>.json` に `pathKey → 投稿配列` で持つ。旧形式
// (`pathKey → メモ 1 件`)のファイルが残っていても読めること、変換後の投稿 ID が読むたびに
// 変わらないこと(編集・削除の宛先が安定すること)を主張する。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tmpRoot: string;

async function importNotesFile(): Promise<typeof import('../src/files/notesFile.js')> {
  vi.stubEnv('DATA_ROOT', tmpRoot);
  vi.resetModules();
  return import('../src/files/notesFile.js');
}

const TPL = 'AM01_510037_20240710_交付版';
const KEY = '.page#1/cover#1';
const notesPath = (): string => path.join(tmpRoot, 'notes', `${TPL}.json`);

async function writeRaw(body: unknown): Promise<void> {
  await fs.mkdir(path.join(tmpRoot, 'notes'), { recursive: true });
  await fs.writeFile(notesPath(), JSON.stringify(body), 'utf8');
}

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'editor-notes-thread-'));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('新形式の read/write', () => {
  it('投稿配列を書いて読み戻せる', async () => {
    const files = await importNotesFile();
    await files.writeNotes(TPL, {
      [KEY]: [
        {
          id: 'e1',
          content: '一件目',
          createdAt: '2026-09-01T00:00:00.000Z',
          createdBy: 'editor1',
          updatedAt: null,
          updatedBy: null,
        },
      ],
    });
    const map = await files.readNotes(TPL);
    expect(map[KEY]).toHaveLength(1);
    expect(map[KEY][0]).toMatchObject({ id: 'e1', content: '一件目' });
  });
});

describe('旧形式の遅延変換', () => {
  it('旧形式(1 パーツ 1 件)を投稿 1 件として読む', async () => {
    const files = await importNotesFile();
    await writeRaw({
      [KEY]: {
        templateId: TPL,
        pathKey: KEY,
        content: '旧メモ',
        updatedAt: '2026-08-01T00:00:00.000Z',
        updatedBy: '旧編集者',
      },
    });
    const map = await files.readNotes(TPL);
    expect(map[KEY]).toHaveLength(1);
    expect(map[KEY][0]).toMatchObject({
      id: 'legacy',
      content: '旧メモ',
      createdAt: '2026-08-01T00:00:00.000Z',
      createdBy: '旧編集者',
    });
  });

  it('変換後の ID は読むたびに変わらない(編集・削除の宛先が安定する)', async () => {
    const files = await importNotesFile();
    await writeRaw({ [KEY]: { content: '旧メモ', updatedAt: 'x', updatedBy: 'u' } });
    const a = await files.readNotes(TPL);
    const b = await files.readNotes(TPL);
    expect(a[KEY][0].id).toBe(b[KEY][0].id);
  });
});

describe('1 パーツあたりの投稿数上限', () => {
  it('上限に達した配列を判定できる', async () => {
    const files = await importNotesFile();
    const full = Array.from({ length: 200 }, (_, i) => ({
      id: `e${i}`,
      content: 'x',
      createdAt: '2026-09-01T00:00:00.000Z',
      createdBy: 'u',
      updatedAt: null,
      updatedBy: null,
    }));
    expect(files.entriesAtCapacity(full)).toBe(true);
    expect(files.entriesAtCapacity(full.slice(0, 199))).toBe(false);
  });
});

describe('書き込みの入力に degrade を使わない', () => {
  it('読めない実体では readNotesStrict が例外になる', async () => {
    const files = await importNotesFile();
    await fs.mkdir(path.join(tmpRoot, 'notes'), { recursive: true });
    await fs.writeFile(notesPath(), '{ broken', 'utf8');
    await expect(files.readNotes(TPL)).resolves.toEqual({});
    await expect(files.readNotesStrict(TPL)).rejects.toMatchObject({ kind: 'validation' });
  });
});
