// =============================================================================
// routeHelpers.ts — ルート間で共有する小さな部品
// =============================================================================
import type { FastifyRequest } from 'fastify';

/**
 * 書き込み系の記録に残す操作者名。ローカルモード(`request.user` 未設定)は `system`。
 * 監査ログ用の `actorFromReq`(`logger.ts`)は未認証を `anonymous` とするので別物。
 */
export function actorOf(req: FastifyRequest): string {
  return req.user?.username ?? 'system';
}

/** クエリ文字列から `keys` の非空文字列だけを拾う。空文字・配列・欠落は `undefined`。 */
export function pickQuery<K extends string>(
  q: unknown,
  keys: readonly K[],
): Partial<Record<K, string>> {
  const src = (q ?? {}) as Record<string, unknown>;
  const out: Partial<Record<K, string>> = {};
  for (const k of keys) {
    const v = src[k];
    out[k] = typeof v === 'string' && v ? v : undefined;
  }
  return out;
}
