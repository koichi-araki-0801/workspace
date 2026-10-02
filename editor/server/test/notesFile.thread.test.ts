// =============================================================================
// notesFile.thread.test.ts — 追記型スレッドのファイル形式と配列でない値の読み捨て
// =============================================================================
// メモは `dataRoot/notes/<templateId>.json` に `pathKey → 投稿配列` で持つ。配列でない値は
// 読み捨てること(表示用・書き込み用のどちらの読み取りでも)を主張する。
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
const KEY2 = '.page#1/cover#2';
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
          status: 'open',
          replyTo: null,
          kind: 'note',
        },
      ],
    });
    const map = await files.readNotes(TPL);
    expect(map[KEY]).toHaveLength(1);
    expect(map[KEY][0]).toMatchObject({ id: 'e1', content: '一件目' });
  });
});

describe('配列でない値の読み捨て', () => {
  const stored = {
    id: 'e1',
    content: '新形式',
    createdAt: '2026-09-01T00:00:00.000Z',
    createdBy: 'u',
    updatedAt: null,
    updatedBy: null,
  };

  it('配列でない値(1 パーツ 1 件の形・null・文字列)は読み捨て、配列の投稿は残す', async () => {
    const files = await importNotesFile();
    await writeRaw({
      [KEY]: { content: '旧メモ', updatedAt: 'x', updatedBy: 'u' },
      [KEY2]: [stored],
      '.page#2/x#1': null,
      '.page#3/x#1': '文字列',
    });
    const map = await files.readNotes(TPL);
    expect(Object.keys(map)).toEqual([KEY2]);
    expect(map[KEY2][0]).toMatchObject({ id: 'e1', content: '新形式' });
  });

  it('書き込み用の読み取り(readNotesStrict)も同じく読み捨てる', async () => {
    const files = await importNotesFile();
    await writeRaw({ [KEY]: { content: '旧メモ' }, [KEY2]: [stored] });
    expect(Object.keys(await files.readNotesStrict(TPL))).toEqual([KEY2]);
  });
});

describe('壊れた投稿要素の耐性', () => {
  it('id/content が欠けた要素は静かに落とし、locate を TypeError で落とさない', async () => {
    const files = await importNotesFile();
    await writeRaw({
      [KEY]: [
        {
          id: 'ok1',
          content: '正常',
          createdAt: 'x',
          createdBy: 'u',
          updatedAt: null,
          updatedBy: null,
        },
        null,
        { content: 'id 欠如' },
        { id: 'no-content' },
      ],
    });
    const map = await files.readNotes(TPL);
    expect(map[KEY]).toHaveLength(1);
    expect(map[KEY][0]).toMatchObject({ id: 'ok1', content: '正常' });
  });
});

describe('コメント属性の既定値補完', () => {
  it('2 フィールドを持たない投稿は open / null として読む', async () => {
    const files = await importNotesFile();
    const dir = path.join(tmpRoot, 'notes');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, `${TPL}.json`),
      JSON.stringify({
        [KEY]: [
          {
            id: 'e1',
            content: '旧い投稿',
            createdAt: '2026-09-01T00:00:00.000Z',
            createdBy: 'editor1',
            updatedAt: null,
            updatedBy: null,
          },
        ],
      }),
    );
    const notes = await files.readNotes(TPL);
    expect(notes[KEY][0]).toMatchObject({ status: 'open', replyTo: null });
    expect(notes[KEY][0]).not.toHaveProperty('kind');
  });

  it('列挙の外の値は既定値へ戻す(壊れた値で画面を落とさない)', async () => {
    const files = await importNotesFile();
    const dir = path.join(tmpRoot, 'notes');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, `${TPL}.json`),
      JSON.stringify({
        [KEY]: [
          {
            id: 'e1',
            content: 'x',
            createdAt: '',
            createdBy: '',
            updatedAt: null,
            updatedBy: null,
            status: 'closed',
            replyTo: 42,
            kind: 'todo',
          },
        ],
      }),
    );
    const notes = await files.readNotes(TPL);
    expect(notes[KEY][0]).toMatchObject({ status: 'open', replyTo: null });
    expect(notes[KEY][0]).not.toHaveProperty('kind');
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
      status: 'open' as const,
      replyTo: null,
      kind: 'note' as const,
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
