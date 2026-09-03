// =============================================================================
// tabMemory.store.test.ts — タブごとの「直前に見ていた画面」の記憶
// =============================================================================
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it } from 'vitest';
import { useTabMemoryStore } from '@/stores/tabMemory';

describe('useTabMemoryStore', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('記憶が無いタブは undefined(呼び手がタブの既定画面へ送る)', () => {
    const store = useTabMemoryStore();
    expect(store.pathFor('edit')).toBeUndefined();
  });

  it('編集画面を見ていたら「編集」タブの直前画面として fullPath を覚える', () => {
    const store = useTabMemoryStore();
    store.remember({ name: 'editor', query: {}, fullPath: '/edit/t1' });
    expect(store.pathFor('edit')).toBe('/edit/t1');
    // 一覧へ戻ればそれが最新
    store.remember({ name: 'edit', query: {}, fullPath: '/edit' });
    expect(store.pathFor('edit')).toBe('/edit');
  });

  it('作成経路(?created=1)の編集画面は「テンプレート作成」タブの直前画面になる', () => {
    const store = useTabMemoryStore();
    store.remember({ name: 'editor', query: { created: '1' }, fullPath: '/edit/t2?created=1' });
    expect(store.pathFor('create')).toBe('/edit/t2?created=1');
    expect(store.pathFor('edit')).toBeUndefined();
  });

  it('clear() で全タブの記憶を捨てる(ログアウト時の後始末)', () => {
    const store = useTabMemoryStore();
    store.remember({ name: 'editor', query: {}, fullPath: '/edit/t1' });
    store.remember({ name: 'compare', query: {}, fullPath: '/compare' });
    store.clear();
    expect(Object.keys(store.paths)).toHaveLength(0);
    expect(store.pathFor('edit')).toBeUndefined();
  });

  it('タブを持たない画面は何も覚えない', () => {
    const store = useTabMemoryStore();
    store.remember({ name: 'admin', query: {}, fullPath: '/admin' });
    expect(Object.keys(store.paths)).toHaveLength(0);
  });
});
