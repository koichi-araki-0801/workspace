import { err, type NoteRepository, ok, type PartNote, unexpected } from '@editor/shared';
import { describe, expect, it } from 'vitest';
import { ref } from 'vue';
import { usePartNote } from '@/features/editor/usePartNote';

/** インメモリの fake NoteRepository(`store` を直接覗いて永続化を検証する)。 */
function makeRepo() {
  const store: Record<string, Record<string, PartNote>> = {};
  const repo: NoteRepository = {
    listNotes: async (templateId) => ok(Object.values(store[templateId] ?? {})),
    saveNote: async (templateId, pathKey, content) => {
      if (!store[templateId]) store[templateId] = {};
      const m = store[templateId];
      if (content.trim() === '') delete m[pathKey];
      else m[pathKey] = { templateId, pathKey, content, updatedAt: 'x', updatedBy: '編集者' };
      return ok(undefined);
    },
  };
  return { repo, store };
}

const COVER = '.page#1/cover#1';
const SUMMARY = '.page#1/.summary#1';

describe('usePartNote', () => {
  it('reflects edits locally and persists on flush', async () => {
    const { repo, store } = makeRepo();
    const fc = ref('510037');
    const key = ref<string | null>(COVER);
    const note = usePartNote(
      () => fc.value,
      () => key.value,
      () => '編集者',
      repo,
    );

    await note.reload();
    expect(note.currentNote.value).toBe('');

    note.setCurrent('hello');
    // ローカル即時反映(マーカー/表示の駆動)。
    expect(note.currentNote.value).toBe('hello');
    expect([...note.notedKeys.value]).toEqual([COVER]);

    await note.flush();
    expect(store['510037'][COVER].content).toBe('hello');
  });

  it('switching selection shows that part’s note', async () => {
    const { repo } = makeRepo();
    const key = ref<string | null>(COVER);
    const note = usePartNote(
      () => '510037',
      () => key.value,
      () => '編集者',
      repo,
    );
    note.setCurrent('cover memo');
    expect(note.currentNote.value).toBe('cover memo');

    key.value = SUMMARY;
    expect(note.currentNote.value).toBe(''); // 別パーツのメモは未設定
    key.value = COVER;
    expect(note.currentNote.value).toBe('cover memo'); // 戻ると保持
  });

  it('reload picks up persisted notes for the current key', async () => {
    const { repo, store } = makeRepo();
    store['510037'] = {
      [COVER]: {
        templateId: '510037',
        pathKey: COVER,
        content: '既存',
        updatedAt: 'x',
        updatedBy: 'u',
      },
    };
    const note = usePartNote(
      () => '510037',
      () => COVER,
      () => '編集者',
      repo,
    );
    await note.reload();
    expect(note.currentNote.value).toBe('既存');
    expect([...note.notedKeys.value]).toEqual([COVER]);
  });

  it('empty content drops the note from notedKeys and persists deletion', async () => {
    const { repo, store } = makeRepo();
    const note = usePartNote(
      () => '510037',
      () => COVER,
      () => '編集者',
      repo,
    );
    note.setCurrent('temp');
    note.setCurrent('');
    expect(note.notedKeys.value.size).toBe(0);
    await note.flush();
    expect(store['510037']?.[COVER]).toBeUndefined();
  });

  it('reload tolerates a repository error (leaves notes empty)', async () => {
    const repo: NoteRepository = {
      listNotes: async () => err(unexpected('boom')),
      saveNote: async () => ok(undefined),
    };
    const note = usePartNote(
      () => '510037',
      () => COVER,
      () => '編集者',
      repo,
    );
    await note.reload();
    expect(note.currentNote.value).toBe('');
    expect(note.notedKeys.value.size).toBe(0);
  });

  it('no-ops when there is no resolvable key or fund', async () => {
    const { repo, store } = makeRepo();
    const note = usePartNote(
      () => '510037',
      () => null,
      () => '編集者',
      repo,
    );
    note.setCurrent('ignored');
    await note.flush();
    expect(store['510037']).toBeUndefined();
    expect(note.canNote.value).toBe(false);
  });
});
