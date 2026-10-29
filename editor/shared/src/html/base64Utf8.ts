// =============================================================================
// base64Utf8.ts — UTF-8 文字列と base64 の相互変換(チップの原文を運ぶ属性用)
// =============================================================================
// 作成タブのチップは Jinja の原文を base64 で属性に載せる(`web/src/lib/fillJinja.ts` が書き、
// `web/src/lib/jinjaMask.ts` が戻す)。改ページの判定(`reviewDiff/pageSplit.ts`)もチップの
// 原文を読むので、web と server の両方から使えるようここに置く。`btoa` / `atob` /
// `TextEncoder` / `TextDecoder` はブラウザと Node のどちらにもある。
/// <reference lib="dom" />

/** UTF-8 の文字列を base64 にする。 */
export function b64encodeUtf8(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

// 不正な UTF-8 は置換文字へ化けると原文が変わるので、`fatal` で例外にして呼び元へ知らせる。
export function b64decodeUtf8(b: string): string {
  const bin = atob(b);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

/** 壊れた base64・不正な UTF-8 は読めない原文として空文字にする。 */
export function b64decodeSafe(s: string): string {
  try {
    return b64decodeUtf8(s);
  } catch {
    return '';
  }
}
