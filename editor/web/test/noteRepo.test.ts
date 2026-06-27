import { isOk } from '@editor/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { localNoteRepo } from '@/api/local/noteRepo';

beforeEach(() => localStorage.clear());

const KEY = '.page#1/cover#1';
const T1 = 'AM01_510037_20240710_全体版';
const T2 = 'AM01_510037_20240710_要約版';

describe('localNoteRepo round-trip', () => {
  it('saves and lists a note scoped to its version instance', async () => {
    await localNoteRepo.saveNote(T1, KEY, 'メモA');

    const list = await localNoteRepo.listNotes(T1);
    expect(isOk(list)).toBe(true);
    if (isOk(list)) {
      expect(list.value).toHaveLength(1);
      expect(list.value[0]).toMatchObject({ templateId: T1, pathKey: KEY, content: 'メモA' });
    }
  });

  it('does not leak notes across version instances', async () => {
    await localNoteRepo.saveNote(T1, KEY, 'メモA');
    // 同じファンドでも別の版種(templateId)には引き継がない。
    const other = await localNoteRepo.listNotes(T2);
    expect(isOk(other) && other.value).toEqual([]);
  });

  it('empty content deletes the note (空＝削除)', async () => {
    await localNoteRepo.saveNote(T1, KEY, 'メモA');
    await localNoteRepo.saveNote(T1, KEY, '   ');
    const list = await localNoteRepo.listNotes(T1);
    expect(isOk(list) && list.value).toEqual([]);
  });

  it('overwrites an existing note in place', async () => {
    await localNoteRepo.saveNote(T1, KEY, 'v1');
    await localNoteRepo.saveNote(T1, KEY, 'v2');
    const list = await localNoteRepo.listNotes(T1);
    if (isOk(list)) {
      expect(list.value).toHaveLength(1);
      expect(list.value[0].content).toBe('v2');
    }
  });
});
