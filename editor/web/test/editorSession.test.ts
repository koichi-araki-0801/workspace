import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setUndoUserScope, undoStacksKey } from '@/lib/storageKeys';
import { type EditorSnapshot, useEditorSessionStore } from '@/stores/editorSession';

/** localStorage の Undo 永続ミラーを読む(テスト用)。 */
function readUndoMap(): Record<string, { past: EditorSnapshot[]; future: EditorSnapshot[] }> {
  return JSON.parse(localStorage.getItem(undoStacksKey()) ?? '{}');
}

describe('useEditorSessionStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
  });

  it('ensure() creates an empty session and returns the same instance on re-ensure', () => {
    const store = useEditorSessionStore();
    const a = store.ensure('t1');
    expect(a).toEqual({ partHistory: {}, seq: 0, undoPast: [], undoFuture: [] });

    // 同一 templateId を再度 ensure すると、同じセッション(参照)が返る
    // (= 編集⇄プレビュー往復で履歴が維持される)。
    a.seq = 3;
    a.undoPast.push({ html: '<p>x</p>', css: '.c{}' });
    const again = store.ensure('t1');
    expect(again).toBe(a);
    expect(again.seq).toBe(3);
    expect(again.undoPast).toHaveLength(1);
  });

  it('keeps sessions isolated per templateId', () => {
    const store = useEditorSessionStore();
    store.ensure('t1').seq = 1;
    const t2 = store.ensure('t2');
    expect(t2.seq).toBe(0);
  });

  it('clear() drops the session so the next ensure() starts fresh', () => {
    const store = useEditorSessionStore();
    const s = store.ensure('t1');
    s.seq = 5;
    s.undoPast.push({ html: 'h', css: 'c' });
    store.clear('t1');
    const fresh = store.ensure('t1');
    expect(fresh).not.toBe(s);
    expect(fresh).toEqual({ partHistory: {}, seq: 0, undoPast: [], undoFuture: [] });
  });

  it('clear() on an unknown templateId is a no-op', () => {
    const store = useEditorSessionStore();
    expect(() => store.clear('missing')).not.toThrow();
  });

  it('persist() mirrors Undo/Redo to localStorage and ensure() hydrates it back', () => {
    const store = useEditorSessionStore();
    const s = store.ensure('t1');
    s.undoPast.push({ html: '<p>a</p>', css: '.a{}' });
    s.undoFuture.push({ html: '<p>b</p>', css: '.b{}' });
    store.persist('t1');

    const map = readUndoMap();
    expect(map.t1.past).toHaveLength(1);
    expect(map.t1.future).toHaveLength(1);

    // 新しい Pinia(= リロード相当)でも ensure が永続ミラーから復元する。
    setActivePinia(createPinia());
    const reloaded = useEditorSessionStore();
    const r = reloaded.ensure('t1');
    expect(r.undoPast[0]).toEqual({ html: '<p>a</p>', css: '.a{}' });
    expect(r.undoFuture[0]).toEqual({ html: '<p>b</p>', css: '.b{}' });
  });

  it('persist() caps the mirrored undo depth to 20 (in-memory stays full)', () => {
    const store = useEditorSessionStore();
    const s = store.ensure('t1');
    for (let i = 0; i < 30; i++) s.undoPast.push({ html: `h${i}`, css: '' });
    store.persist('t1');

    expect(s.undoPast).toHaveLength(30); // in-memory は丸めない
    const map = readUndoMap();
    expect(map.t1.past).toHaveLength(20); // 永続ミラーは直近 20 件
    expect(map.t1.past[19]).toEqual({ html: 'h29', css: '' }); // 末尾=最新を残す
  });

  it('persist() keeps the newest redo entries (future tail = next redo target)', () => {
    const store = useEditorSessionStore();
    const s = store.ensure('t1');
    for (let i = 0; i < 30; i++) s.undoFuture.push({ html: `f${i}`, css: '' });
    store.persist('t1');

    const map = readUndoMap();
    expect(map.t1.future).toHaveLength(20);
    // `useSnapshotHistory` の redo は future の末尾から取り出すため、末尾側を残す。
    expect(map.t1.future[19]).toEqual({ html: 'f29', css: '' });
  });

  it('clear() also removes the persisted undo mirror', () => {
    const store = useEditorSessionStore();
    const s = store.ensure('t1');
    s.undoPast.push({ html: 'h', css: 'c' });
    store.persist('t1');
    expect(readUndoMap().t1).toBeDefined();

    store.clear('t1');
    expect(readUndoMap().t1).toBeUndefined();
  });

  it('reset() は Undo スタックを in-place で空にし、ミラーも空にする', () => {
    // 別タブが残した下書きを破棄して確定版から開いたときの後始末。`useSnapshotHistory` が
    // 配列を参照で握っているため、差し替えではなく in-place で空にする必要がある。
    const store = useEditorSessionStore();
    const s = store.ensure('t1');
    const past = s.undoPast;
    const future = s.undoFuture;
    past.push({ html: '<p>stale</p>', css: '.a{}' });
    future.push({ html: '<p>redo</p>', css: '.b{}' });
    s.partHistory = { k1: [] };
    s.seq = 7;
    store.persist('t1');
    expect(readUndoMap().t1.past).toHaveLength(1);

    store.reset('t1');
    // 先に取った参照そのものが空になっている(配列を差し替えていない)。
    expect(past).toEqual([]);
    expect(future).toEqual([]);
    expect(store.ensure('t1').undoPast).toBe(past);
    // 修正履歴と採番は残す(Undo だけを捨てる)。
    expect(s.partHistory).toEqual({ k1: [] });
    expect(s.seq).toBe(7);
    // ミラーも空になっている(リロードで再び hydrate されない)。
    expect(readUndoMap().t1).toEqual({ past: [], future: [] });
  });

  it('persist() never throws when localStorage.setItem fails (best-effort)', () => {
    const store = useEditorSessionStore();
    const s = store.ensure('t1');
    s.undoPast.push({ html: 'h', css: 'c' });
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new DOMException('quota', 'QuotaExceededError');
    };
    try {
      expect(() => store.persist('t1')).not.toThrow();
    } finally {
      Storage.prototype.setItem = original;
    }
  });
});

// 共有端末では Undo ミラーが localStorage に残る。ユーザーを跨いで復元されると、前の
// 利用者の編集内容が次の利用者の画面へ出るため、キーは利用者ごとに分ける。
describe('Undo ミラーのユーザー分離', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    setUndoUserScope(null);
  });

  it('local は単一利用者前提の固定スコープを使う', () => {
    setUndoUserScope('alice');
    expect(undoStacksKey()).toBe('editor:session:undo:local');
  });

  it('rest はログイン ID ごとに別キーで、他ユーザーの内容へ到達しない', () => {
    vi.stubEnv('VITE_API_MODE', 'rest');
    setUndoUserScope('alice');
    const keyA = undoStacksKey();
    const s = useEditorSessionStore().ensure('t1');
    s.undoPast.push({ html: '<p>alice</p>', css: '' });
    useEditorSessionStore().persist('t1');
    expect(localStorage.getItem(keyA)).toContain('alice');

    setUndoUserScope('bob');
    expect(undoStacksKey()).not.toBe(keyA);
    // 別ユーザーでの再マウント(= 新しい Pinia)でも A の内容は hydrate されない。
    setActivePinia(createPinia());
    expect(useEditorSessionStore().ensure('t1').undoPast).toEqual([]);
  });

  it('rest で未ログインなら anonymous スコープへ隔離する', () => {
    vi.stubEnv('VITE_API_MODE', 'rest');
    setUndoUserScope(null);
    expect(undoStacksKey()).toBe('editor:session:undo:anonymous');
  });
});
