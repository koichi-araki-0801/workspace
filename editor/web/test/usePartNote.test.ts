import { err, type NoteRepository, ok, type PartNoteEntry, unexpected } from '@editor/shared';
import { describe, expect, it } from 'vitest';
import { ref } from 'vue';
import { usePartNote } from '@/features/editor/usePartNote';

const COVER = '.page#1/cover#1';
const SUMMARY = '.page#1/.summary#1';
const TPL = 'AM01_510037_20240710_交付版';

/** インメモリの fake NoteRepository(`store` を直接覗いて永続化を検証する)。 */
function makeRepo() {
  const store: PartNoteEntry[] = [];
  let seq = 0;
  const repo: NoteRepository = {
    listNotes: async () => ok([...store]),
    addNote: async (templateId, pathKey, content, opts = {}) => {
      const entry: PartNoteEntry = {
        id: `e${++seq}`,
        templateId,
        pathKey,
        content,
        createdAt: `2026-09-01T00:00:0${seq}.000Z`,
        createdBy: '編集者',
        updatedAt: null,
        updatedBy: null,
        status: 'open',
        replyTo: opts.replyTo ?? null,
        kind: opts.kind ?? 'note',
      };
      store.push(entry);
      return ok(entry);
    },
    updateNote: async (_templateId, entryId, patch) => {
      const i = store.findIndex((e) => e.id === entryId);
      store[i] = {
        ...store[i],
        ...(patch.content !== undefined
          ? { content: patch.content, updatedAt: 'x', updatedBy: '編集者' }
          : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
      };
      return ok(store[i]);
    },
    deleteNote: async (_templateId, entryId) => {
      const i = store.findIndex((e) => e.id === entryId);
      store.splice(i, 1);
      return ok(undefined);
    },
  };
  return { repo, store };
}

describe('usePartNote', () => {
  it('追加した投稿がスレッドとマーカーへ反映される', async () => {
    const { repo, store } = makeRepo();
    const key = ref<string | null>(COVER);
    const note = usePartNote(
      () => TPL,
      () => key.value,
      repo,
    );

    await note.reload();
    expect(note.entries.value).toEqual([]);

    await note.add('1 件目');
    expect(note.entries.value.map((e) => e.content)).toEqual(['1 件目']);
    expect([...note.notedKeys.value]).toEqual([COVER]);
    expect(store).toHaveLength(1);
  });

  it('選択を切り替えるとそのパーツのスレッドを見せる', async () => {
    const { repo } = makeRepo();
    const key = ref<string | null>(COVER);
    const note = usePartNote(
      () => TPL,
      () => key.value,
      repo,
    );
    await note.add('表紙のメモ');

    key.value = SUMMARY;
    expect(note.entries.value).toEqual([]);
    key.value = COVER;
    expect(note.entries.value.map((e) => e.content)).toEqual(['表紙のメモ']);
  });

  it('投稿を編集・削除できる', async () => {
    const { repo, store } = makeRepo();
    const note = usePartNote(
      () => TPL,
      () => COVER,
      repo,
    );
    await note.add('初版');
    await note.update(note.entries.value[0], '改訂');
    expect(note.entries.value[0].content).toBe('改訂');

    await note.remove(note.entries.value[0]);
    expect(note.entries.value).toEqual([]);
    expect(note.notedKeys.value.size).toBe(0);
    expect(store).toHaveLength(0);
  });

  it('ペア側の投稿は自分の版でなくその投稿の版へ書き戻す', async () => {
    const { repo } = makeRepo();
    const seen: string[] = [];
    const spy: NoteRepository = {
      ...repo,
      updateNote: async (templateId, entryId, content) => {
        seen.push(templateId);
        return repo.updateNote(templateId, entryId, content);
      },
    };
    const note = usePartNote(
      () => TPL,
      () => COVER,
      spy,
    );
    await note.add('交付版のメモ');
    const pairEntry = { ...note.entries.value[0], templateId: 'AM01_510037_20240710_全体版' };
    await note.update(pairEntry, '書き換え');
    expect(seen).toEqual(['AM01_510037_20240710_全体版']);
  });

  it('reload はリポジトリのエラーを飲み込む(スレッドは空のまま)', async () => {
    const repo: NoteRepository = {
      listNotes: async () => err(unexpected('boom')),
      addNote: async () => err(unexpected('boom')),
      updateNote: async () => err(unexpected('boom')),
      deleteNote: async () => err(unexpected('boom')),
    };
    const note = usePartNote(
      () => TPL,
      () => COVER,
      repo,
    );
    await note.reload();
    expect(note.entries.value).toEqual([]);
    expect(note.notedKeys.value.size).toBe(0);
  });

  it('選択キーが解決できないときは追加しない', async () => {
    const { repo, store } = makeRepo();
    const note = usePartNote(
      () => TPL,
      () => null,
      repo,
    );
    await note.add('無視される');
    expect(store).toHaveLength(0);
    expect(note.canNote.value).toBe(false);
    expect(note.entries.value).toEqual([]);
  });

  it('版インスタンス未選択の reload は空のまま(repo を呼ばない)', async () => {
    const { repo } = makeRepo();
    const note = usePartNote(
      () => '',
      () => COVER,
      repo,
    );
    await note.reload();
    expect(note.entries.value).toEqual([]);
  });

  it('空文字の本文は編集を送らない', async () => {
    const { repo, store } = makeRepo();
    const note = usePartNote(
      () => TPL,
      () => COVER,
      repo,
    );
    await note.add('初版');
    await note.update(note.entries.value[0], '   ');
    expect(store[0].content).toBe('初版');
  });

  it('add/reply/setStatus/update/remove はリポジトリのエラーを飲み込み、reload しない', async () => {
    const parent: PartNoteEntry = {
      id: 'p1',
      templateId: TPL,
      pathKey: COVER,
      content: '親',
      createdAt: '2026-09-01T00:00:00.000Z',
      createdBy: '編集者',
      updatedAt: null,
      updatedBy: null,
      status: 'open',
      replyTo: null,
      kind: 'note',
    };
    const errRepo: NoteRepository = {
      listNotes: async () => err(unexpected('boom')),
      addNote: async () => err(unexpected('boom')),
      updateNote: async () => err(unexpected('boom')),
      deleteNote: async () => err(unexpected('boom')),
    };
    const note = usePartNote(
      () => TPL,
      () => COVER,
      errRepo,
    );
    await expect(note.add('本文')).resolves.toBeUndefined();
    await expect(note.reply(parent, '返信')).resolves.toBeUndefined();
    await expect(note.setStatus(parent, 'resolved')).resolves.toBeUndefined();
    await expect(note.update(parent, '編集')).resolves.toBeUndefined();
    await expect(note.remove(parent)).resolves.toBeUndefined();
    expect(note.entries.value).toEqual([]);
  });

  it('reply は選択パーツの親へ返信を積み、setStatus は親の状態を切り替える', async () => {
    const { repo, store } = makeRepo();
    const key = ref<string | null>(COVER);
    const note = usePartNote(
      () => TPL,
      () => key.value,
      repo,
    );
    await note.add('親', { kind: 'question' });
    const parent = note.entries.value[0];
    expect(parent.kind).toBe('question');

    await note.reply(parent, '返信');
    expect(note.entries.value.map((e) => e.replyTo)).toEqual([null, parent.id]);

    await note.setStatus(parent, 'resolved');
    expect(store.find((e) => e.id === parent.id)?.status).toBe('resolved');
  });

  it('本文が空の返信は送らない', async () => {
    const { repo, store } = makeRepo();
    const note = usePartNote(
      () => TPL,
      () => COVER,
      repo,
    );
    await note.add('親');
    await note.reply(note.entries.value[0], '   ');
    expect(store).toHaveLength(1);
  });
});
