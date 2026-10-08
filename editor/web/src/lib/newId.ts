// =============================================================================
// newId.ts — UUID 採番(履歴 1 件ごとの id)
// =============================================================================
// `crypto.randomUUID` は HTTPS か localhost でしか生えない。LAN 公開を HTTP で使う運用が
// あるので、無い場合は `getRandomValues`(非セキュアな文脈でも使える)で v4 を組み立てる。
// 出力は shared の `z.uuid()`(version 4 / variant 8-b)を通る形に揃える。

/** バイト列を小文字 hex(1 バイト 2 桁)にする。 */
function toHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

/** CSPRNG の `bytes` バイトを小文字 hex にする(推測不能な名前・id 用)。 */
export function randomHex(bytes: number): string {
  return toHex(crypto.getRandomValues(new Uint8Array(bytes)));
}

export function newId(): string {
  const c = globalThis.crypto;
  if (typeof c.randomUUID === 'function') return c.randomUUID();
  const b = c.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = toHex(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
