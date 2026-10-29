// =============================================================================
// urlNormalize.ts — URL パーサが解析前に外す文字の除去(HTML・CSS の外部参照検出で共有)
// =============================================================================
/** URL パーサが前後で捨てる符号位置の上限(C0 制御文字と空白)。 */
const URL_EDGE_MAX_CODE = 0x20;
/** URL パーサが位置を問わず消す符号位置(TAB / LF / CR)。 */
const URL_STRIPPED_CODES = new Set([0x09, 0x0a, 0x0d]);

/**
 * WHATWG URL パーサが解析の前に外す文字を外す。前後の U+0020 以下(C0 制御文字と空白)を捨て、
 * TAB / LF / CR を位置を問わず消す。判定はこの後の値でしないとブラウザと読みが割れる —
 * CSS のエスケープで書いた `url("\1 http://…")` や `"ht\9 tp://…"` は、外す前だと scheme の形を
 * しないので相対参照に見えるが、ブラウザは `http://…` を取りに行く。
 * JS の `trim` は使わない。C0 制御文字を外さず、逆に URL パーサが外さない NBSP などを外す。
 * 制御文字を正規表現のソースに直に書かないよう、符号位置で走査する。
 */
export function stripUrlIgnoredChars(url: string): string {
  let start = 0;
  let end = url.length;
  while (start < end && url.charCodeAt(start) <= URL_EDGE_MAX_CODE) start++;
  while (end > start && url.charCodeAt(end - 1) <= URL_EDGE_MAX_CODE) end--;
  let out = '';
  for (let i = start; i < end; i++) {
    if (!URL_STRIPPED_CODES.has(url.charCodeAt(i))) out += url[i];
  }
  return out;
}
