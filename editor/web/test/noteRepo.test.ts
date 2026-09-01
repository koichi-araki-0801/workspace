import {
  isOk,
  MAX_NOTE_CONTENT_CHARS,
  MAX_NOTE_ENTRIES_PER_PART,
  MAX_NOTE_PATH_KEY_CHARS,
  MAX_NOTES_PER_TEMPLATE,
  type PartNoteEntry,
} from '@editor/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { localNoteRepo } from '@/api/local/noteRepo';
import { K } from '@/api/local/store';

beforeEach(() => localStorage.clear());

const KEY = '.page#1/cover#1';
const KOUFU = 'AM01_510037_20240710_交付版';
const ZENTAI = 'AM01_510037_20240710_全体版';
const LONE = 'AM01_510037_20240710_kr';

async function add(templateId: string, content: string): Promise<string> {
  const res = await localNoteRepo.addNote(templateId, KEY, content);
  if (!isOk(res)) throw new Error('追加に失敗');
  return res.value.id;
}

describe('localNoteRepo', () => {
  it('投稿を積み、作成順に返す', async () => {
    await add(KOUFU, '1 件目');
    await add(KOUFU, '2 件目');
    const list = await localNoteRepo.listNotes(KOUFU);
    expect(isOk(list) && list.value.map((e) => e.content)).toEqual(['1 件目', '2 件目']);
  });

  it('交付版と全体版で 1 本のスレッドを共有する', async () => {
    await add(KOUFU, '交付版');
    await add(ZENTAI, '全体版');
    const list = await localNoteRepo.listNotes(KOUFU);
    expect(isOk(list) && list.value.map((e) => e.templateId)).toEqual([KOUFU, ZENTAI]);
  });

  it('ペア対象外の版種は自版のみを返す', async () => {
    await add(KOUFU, '交付版');
    await add(LONE, '旧版種');
    const list = await localNoteRepo.listNotes(LONE);
    expect(isOk(list) && list.value.map((e) => e.content)).toEqual(['旧版種']);
  });

  it('投稿を編集できる(誰の投稿でも編集できる)', async () => {
    const id = await add(KOUFU, '初版');
    await localNoteRepo.updateNote(KOUFU, id, '改訂');
    const list = await localNoteRepo.listNotes(KOUFU);
    expect(isOk(list) && list.value[0].content).toBe('改訂');
    expect(isOk(list) && list.value[0].updatedAt).not.toBeNull();
  });

  it('投稿を削除できる', async () => {
    const id = await add(KOUFU, '消す');
    await localNoteRepo.deleteNote(KOUFU, id);
    const list = await localNoteRepo.listNotes(KOUFU);
    expect(isOk(list) && list.value).toEqual([]);
  });

  it('空文字の本文は追加できない(削除は deleteNote で明示する)', async () => {
    const res = await localNoteRepo.addNote(KOUFU, KEY, '');
    expect(isOk(res)).toBe(false);
  });

  it('作成日時が同じでも投稿順を保つ(安定ソートで挿入順に委ねる)', async () => {
    // createdAt を時刻固定で意図的に衝突させ、id も `crypto.randomUUID()` を差し替えて
    // 辞書順と挿入順がわざと食い違うようにする(z1 → m2 → a3 の順で発行するが、辞書順は
    // a3 < m2 < z1 で逆順)。id を tiebreak に使う実装が復活すると結果が辞書順
    // (3 件目, 2 件目, 1 件目)へ入れ替わり、このテストが落ちる(乱数任せだと約 5/6 でしか
    // 検出できないため固定する)。
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-01T00:00:00.000Z'));
    const ids = ['z1', 'm2', 'a3'];
    vi.spyOn(crypto, 'randomUUID').mockImplementation(
      () => ids.shift() as unknown as ReturnType<typeof crypto.randomUUID>,
    );
    try {
      await add(KOUFU, '1 件目');
      await add(KOUFU, '2 件目');
      await add(KOUFU, '3 件目');
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
    const list = await localNoteRepo.listNotes(KOUFU);
    expect(isOk(list) && list.value.map((e) => e.content)).toEqual(['1 件目', '2 件目', '3 件目']);
  });
});

describe('資源上限(REST と同じ 4 定数を local でも強制する)', () => {
  // REST 側は Zod 契約(`AddNoteRequest`/`UpdateNoteRequest`)と server 実装
  // (`files/notesFile.ts`)がこれらを強制するが、local はチェックが無く 201 件目や 64KiB 超の
  // 本文がそのまま通っていた(offline/デモビルドだけ本物が拒否する操作を許してしまう)。

  it('本文が上限を超える追加は拒否する', async () => {
    const res = await localNoteRepo.addNote(KOUFU, KEY, 'x'.repeat(MAX_NOTE_CONTENT_CHARS + 1));
    expect(isOk(res)).toBe(false);
  });

  it('本文が上限を超える編集は拒否する', async () => {
    const id = await add(KOUFU, '初版');
    const res = await localNoteRepo.updateNote(KOUFU, id, 'x'.repeat(MAX_NOTE_CONTENT_CHARS + 1));
    expect(isOk(res)).toBe(false);
  });

  it('パーツキーが上限を超える追加は拒否する', async () => {
    const longKey = 'x'.repeat(MAX_NOTE_PATH_KEY_CHARS + 1);
    const res = await localNoteRepo.addNote(KOUFU, longKey, '本文');
    expect(isOk(res)).toBe(false);
  });

  it('1 パーツの投稿数が上限に達したら追加を拒否し、編集・削除は通す(上限は詰みを作らない)', async () => {
    // 1000 回 addNote を呼ぶ代わりに、上限ちょうどの状態を localStorage へ直接書いて再現する。
    const entries: PartNoteEntry[] = Array.from({ length: MAX_NOTE_ENTRIES_PER_PART }, (_, i) => ({
      id: `e${i}`,
      templateId: KOUFU,
      pathKey: KEY,
      content: `メモ${i}`,
      createdAt: `2026-09-01T00:00:${String(i % 60).padStart(2, '0')}.000Z`,
      createdBy: 'u',
      updatedAt: null,
      updatedBy: null,
    }));
    localStorage.setItem(K.notes, JSON.stringify({ [KOUFU]: { [KEY]: entries } }));

    const addRes = await localNoteRepo.addNote(KOUFU, KEY, 'あふれる');
    expect(isOk(addRes)).toBe(false);

    const updateRes = await localNoteRepo.updateNote(KOUFU, 'e0', '更新');
    expect(isOk(updateRes) && updateRes.value.content).toBe('更新');

    const deleteRes = await localNoteRepo.deleteNote(KOUFU, 'e1');
    expect(isOk(deleteRes)).toBe(true);
  });

  it('pathKey が上限件数に達したテンプレートへの新規キー追加を拒否する(既存キーへの追加は通す)', async () => {
    // 1000 パーツぶんの状態を localStorage へ直接書いて再現する(ループで 1000 回 API を
    // 呼ぶと遅く、意図も読み取りにくい)。
    const tpl: Record<string, PartNoteEntry[]> = {};
    for (let i = 0; i < MAX_NOTES_PER_TEMPLATE; i++) {
      tpl[`p${i}`] = [
        {
          id: `id${i}`,
          templateId: KOUFU,
          pathKey: `p${i}`,
          content: 'x',
          createdAt: '2026-09-01T00:00:00.000Z',
          createdBy: 'u',
          updatedAt: null,
          updatedBy: null,
        },
      ];
    }
    localStorage.setItem(K.notes, JSON.stringify({ [KOUFU]: tpl }));

    const newKeyRes = await localNoteRepo.addNote(KOUFU, '新規パーツ', '本文');
    expect(isOk(newKeyRes)).toBe(false);

    const existingKeyRes = await localNoteRepo.addNote(KOUFU, 'p0', '追記');
    expect(isOk(existingKeyRes)).toBe(true);
  });
});
