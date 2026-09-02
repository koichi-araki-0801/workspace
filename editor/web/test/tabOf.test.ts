// =============================================================================
// tabOf.test.ts — ルート → 上部ナビのタブ名の写像
// =============================================================================
import { describe, expect, it } from 'vitest';
import { tabOf } from '@/features/layout/tabOf';

describe('tabOf', () => {
  it('タブ画面そのものは自分の名前に写す', () => {
    expect(tabOf({ name: 'edit', query: {} })).toBe('edit');
    expect(tabOf({ name: 'create', query: {} })).toBe('create');
    expect(tabOf({ name: 'reviews', query: {} })).toBe('reviews');
    expect(tabOf({ name: 'merge', query: {} })).toBe('merge');
    expect(tabOf({ name: 'compare', query: {} })).toBe('compare');
    expect(tabOf({ name: 'history', query: {} })).toBe('history');
  });

  it('編集・プレビュー画面は query なしなら「編集」、?created=1 なら「テンプレート作成」', () => {
    expect(tabOf({ name: 'editor', query: {} })).toBe('edit');
    expect(tabOf({ name: 'preview', query: {} })).toBe('edit');
    expect(tabOf({ name: 'editor', query: { created: '1' } })).toBe('create');
    expect(tabOf({ name: 'preview', query: { created: '1' } })).toBe('create');
    // '1' 以外の値は作成経路ではない(経路判定は厳密一致)
    expect(tabOf({ name: 'editor', query: { created: 'true' } })).toBe('edit');
  });

  it('精査画面は「承認」に属する', () => {
    expect(tabOf({ name: 'review-detail', query: {} })).toBe('reviews');
  });

  it('タブを持たない画面は null', () => {
    expect(tabOf({ name: 'admin', query: {} })).toBeNull();
    expect(tabOf({ name: 'login', query: {} })).toBeNull();
    expect(tabOf({ name: undefined, query: {} })).toBeNull();
    expect(tabOf({ name: Symbol('x'), query: {} })).toBeNull();
  });
});
