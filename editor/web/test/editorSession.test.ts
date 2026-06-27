import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it } from 'vitest';
import { K } from '@/api/local/store';
import { type EditorSnapshot, useEditorSessionStore } from '@/stores/editorSession';

/** localStorage の Undo 永続ミラーを読む(テスト用)。 */
function readUndoMap(): Record<string, { past: EditorSnapshot[]; future: EditorSnapshot[] }> {
  return JSON.parse(localStorage.getItem(K.undoStacks) ?? '{}');
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

  it('clear() also removes the persisted undo mirror', () => {
    const store = useEditorSessionStore();
    const s = store.ensure('t1');
    s.undoPast.push({ html: 'h', css: 'c' });
    store.persist('t1');
    expect(readUndoMap().t1).toBeDefined();

    store.clear('t1');
    expect(readUndoMap().t1).toBeUndefined();
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
