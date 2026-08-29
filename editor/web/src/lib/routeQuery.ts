// =============================================================================
// routeQuery.ts — URL クエリ値の正規化
// =============================================================================
// 役割: `route.query` の値は同名パラメータが 2 つ以上あると配列になり、null にもなる。
// そのまま文字列として扱うと `router.push(配列)` のような形で例外になるため、読む側は
// 必ずここを通す。

import type { LocationQueryValue } from 'vue-router';

/** 配列(複数値)になり得る query 値から最初の文字列だけを採る。 */
export function firstQueryString(
  v: LocationQueryValue | LocationQueryValue[] | undefined,
): string | undefined {
  const raw = Array.isArray(v) ? v[0] : v;
  return raw == null ? undefined : raw;
}

/**
 * ログイン後の着地先として使える `redirect` クエリ値だけを返す。アプリ内の絶対パス
 * (`/` 始まり)に限り、`//host` や `https://host` のような別オリジンへ出られる形は捨てる。
 */
export function safeRedirectPath(
  v: LocationQueryValue | LocationQueryValue[] | undefined,
): string | undefined {
  const s = firstQueryString(v);
  if (!s?.startsWith('/') || s.startsWith('//')) return undefined;
  return s;
}
