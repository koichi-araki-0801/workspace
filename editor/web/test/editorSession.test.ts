import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it } from 'vitest';
import { useEditorSessionStore } from '@/stores/editorSession';

describe('useEditorSessionStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
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
});
