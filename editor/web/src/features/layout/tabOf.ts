// =============================================================================
// tabOf.ts — ルートから点灯すべき上部ナビのタブ名への写像
// =============================================================================
import type { LocationQuery, RouteRecordName } from 'vue-router';

/** 上部ナビのタブ名(`MainLayout.vue` の `tabs` と同じ集合)。 */
export type TabName = 'edit' | 'create' | 'reviews' | 'merge' | 'compare' | 'history';

const TAB_NAMES: ReadonlySet<string> = new Set<TabName>([
  'edit',
  'create',
  'reviews',
  'merge',
  'compare',
  'history',
]);

/** 写像に必要なルート情報の最小形(`RouteLocationNormalized` が構造的に満たす)。 */
export interface TabRouteLike {
  name?: RouteRecordName | null;
  query: LocationQuery;
}

/**
 * ルートを上部ナビのタブへ写す。編集・プレビュー画面は作成経路(`?created=1`)なら
 * 「テンプレート作成」、でなければ「編集」に属する。経路判定の根拠は 2 系統の原則どおり
 * `route.query.created === '1'` だけで、ここはそれを表示上のタブ点灯へ写すだけ(値の差込や
 * ハイライトの出し分けには関与しない — 設計正典「編集 2 系統」)。精査画面は「承認」に属する。
 * タブを持たない画面(管理者・ログインなど)は null。
 * タブ点灯とタブ復帰の記録キー(`stores/tabMemory.ts`)の両方がこの関数を使い、判定を
 * 2 か所に書かない。
 */
export function tabOf(route: TabRouteLike): TabName | null {
  const name = typeof route.name === 'string' ? route.name : null;
  if (name === 'editor' || name === 'preview') {
    return route.query.created === '1' ? 'create' : 'edit';
  }
  if (name === 'review-detail') return 'reviews';
  return name !== null && TAB_NAMES.has(name) ? (name as TabName) : null;
}
