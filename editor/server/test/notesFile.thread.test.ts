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
      id: `legacy:${KEY}`,
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

  it('複数 pathKey を持つ旧形式ファイルでは各パーツが異なる ID になる', async () => {
    // 固定値 `legacy` 単体へ戻す退行が起きると、ここが同じ ID になって検出できる
    // (`repositories/noteRepo.ts` の `locate` はファイル内の全 pathKey を横断して ID 一致を
    // 探すため、ID が衝突すると編集・削除が別パーツへ誤爆する。実害は noteRepo.test.ts の
    // describe('旧形式ファイル(複数 pathKey)での id 衝突を防ぐ') で確認する)。
    const KEY2 = '.page#1/cover#2';
    const files = await importNotesFile();
    await writeRaw({
      [KEY]: { content: 'パーツ1', updatedAt: 'x', updatedBy: 'u' },
      [KEY2]: { content: 'パーツ2', updatedAt: 'x', updatedBy: 'u' },
    });
    const map = await files.readNotes(TPL);
    expect(map[KEY][0].id).not.toBe(map[KEY2][0].id);
    expect(map[KEY][0].id).toBe(`legacy:${KEY}`);
    expect(map[KEY2][0].id).toBe(`legacy:${KEY2}`);
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
  it('3 フィールドを持たない投稿は open / null / note として読む', async () => {
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
    expect(notes[KEY][0]).toMatchObject({ status: 'open', replyTo: null, kind: 'note' });
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
    expect(notes[KEY][0]).toMatchObject({ status: 'open', replyTo: null, kind: 'note' });
  });

  it('旧形式(1 パーツ 1 件)の変換分も 3 フィールドを持つ', async () => {
    const files = await importNotesFile();
    const dir = path.join(tmpRoot, 'notes');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, `${TPL}.json`),
      JSON.stringify({
        [KEY]: { content: '旧形式', updatedAt: '2026-09-01T00:00:00.000Z', updatedBy: 'e' },
      }),
    );
    const notes = await files.readNotes(TPL);
    expect(notes[KEY][0]).toMatchObject({
      id: `legacy:${KEY}`,
      status: 'open',
      replyTo: null,
      kind: 'note',
    });
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
