// =============================================================================
// inlineBundle.ts — バンドルを inline `<script>` へそのまま埋めてよいかの判定
// =============================================================================
// Jinja 描画ホスト(`render/renderHost.ts`)とビューアホスト(`vivliostyle/previewHost.ts`)が
// 同じ規則で判定するための共通部。

/**
 * バンドルをホストページの inline `<script>` に**そのまま**埋めてよいか。
 *
 * 判定のみで書き換えはしない(fail closed)。`</script` の `\/` 置換は minified バンドルでは
 * `a</b/…`(比較 + 正規表現リテラル)のような、置換すると構文が壊れる形が原理上ありうる。
 * 危険な字面を含む版が来たら呼び出し側は inline を諦めて `<script src>` 配信へ倒す。
 *
 *  - `</script` — raw text の終端。1 つでもあれば要素がそこで閉じる。
 *  - `<!--` の後、対応する `-->` より前に `<script` — script data の二重エスケープ状態に
 *    入り、こちらが付ける終了タグが終了タグとして扱われなくなる。
 */
export function bundleSafeToInline(bundle: string): boolean {
  const lower = bundle.toLowerCase();
  if (lower.includes('</script')) return false;
  for (let at = lower.indexOf('<!--'); at !== -1; at = lower.indexOf('<!--', at + 4)) {
    const close = lower.indexOf('-->', at + 4);
    const open = lower.indexOf('<script', at + 4);
    if (open !== -1 && (close === -1 || open < close)) return false;
  }
  return true;
}
