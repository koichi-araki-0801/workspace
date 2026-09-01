import { isOk } from '@editor/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { localNoteRepo } from '@/api/local/noteRepo';

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
    // 時刻を固定して createdAt を意図的に衝突させる。id は乱数 UUID で挿入順と無関係な
    // ため、時刻だけの比較で挿入順(配列順)が保たれることを確認する回帰テスト。
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-01T00:00:00.000Z'));
    try {
      await add(KOUFU, '1 件目');
      await add(KOUFU, '2 件目');
      await add(KOUFU, '3 件目');
    } finally {
      vi.useRealTimers();
    }
    const list = await localNoteRepo.listNotes(KOUFU);
    expect(isOk(list) && list.value.map((e) => e.content)).toEqual(['1 件目', '2 件目', '3 件目']);
  });
});
