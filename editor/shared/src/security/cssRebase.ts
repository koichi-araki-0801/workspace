// =============================================================================
// cssRebase.ts — リクエスト CSS の相対 url() を css/ 基準の配信ルート相対へ付け替える
// =============================================================================
// ファンド CSS は `css/<fund>.css` に置かれ、CSS 自身から見た相対パス(`url(fonts/x.woff2)`)で
// 書かれる。ところが PDF・プレビューでは、その CSS を文書の `<style>` へ埋め込むため、相対
// URL は配信ルート直下を基準に解決されてしまう。埋め込む瞬間に `css/` 基準へ付け替えて、
// 「`<link>` で読んだときと同じ実体」に届くようにする。
//
// ⚠ この関数は冪等ではない(`fonts/x` → `css/fonts/x` → `css/css/fonts/x`)。著者が `css/` と
// 書いたのかを区別できないので、冪等化はしない。呼び出しは「リクエスト CSS が文書へ入る
// 入口で 1 回」に限り、その場所は import のガードテストで固定している
// (`server/test/requestCss.guard.test.ts`・`web/test/cssRebase.guard.test.ts`)。
//
// 走査は検査・配置と同じ `collectCssUrlSpans` を使う。別の正規表現で拾い直すと「検査は見たが
// 付け替えは見ていない」形の食い違いが生まれる。引用符文字列(`image-set("…")`・`content`)は
// 付け替えない — 本文の文字列を壊さないため、相対参照は `url()` で書く契約にしている。

import { collectCssUrlSpans, isSelfContainedUrl } from './cssExternalRefs.js';
import { resolveServedAssetPath } from './htmlExternalRefs.js';

/** リクエスト CSS が置かれているとみなす配信ルート相対のディレクトリ。 */
export const REQUEST_CSS_BASE = 'css';

/**
 * `css` の中の相対 `url()` を、`baseDir` に置かれた CSS から見た相対として解決し直し、
 * 配信ルート相対の `url("…")` へ書き換える。付け替えられない値(絶対 URL・`data:`・`#`・
 * `/` 始まり・ルートの外へ出る形)は原文のまま残す。
 */
export function rebaseCssUrls(css: string, baseDir: string): string {
  let out = css;
  // 後ろから置換して、先行する範囲のオフセットを保つ。
  for (const span of [...collectCssUrlSpans(css)].reverse()) {
    const rebased = rebaseUrlValue(span.value, baseDir);
    if (rebased === undefined) continue;
    out = `${out.slice(0, span.start)}url("${rebased}")${out.slice(span.end)}`;
  }
  return out;
}

/** 1 つの URL 値を付け替える。対象外なら `undefined`。 */
function rebaseUrlValue(value: string, baseDir: string): string | undefined {
  const v = value.trim();
  if (v === '' || v.startsWith('#') || v.startsWith('/') || v.startsWith('\\')) return undefined;
  if (!isSelfContainedUrl(v) || /^data:/i.test(v)) return undefined;
  const cut = v.search(/[?#]/);
  const pathPart = cut < 0 ? v : v.slice(0, cut);
  const suffix = cut < 0 ? '' : v.slice(cut);
  const resolved = resolveServedAssetPath(`${baseDir}/${pathPart}`);
  if (resolved === undefined) return undefined;
  try {
    // 値はエスケープ解決後の字面なので、`"` `\` 改行や `</style` を含みうる。各セグメントと
    // クエリ・断片を百分率符号化して、引用形の中で CSS・HTML のどちらとしても無害にする。
    const encodedPath = resolved.split('/').map(encodeURIComponent).join('/');
    return encodedPath + encodeURI(suffix).replace(/"/g, '%22');
  } catch {
    // 孤立サロゲートなど符号化できない値は触らない(原文のまま = 従来どおりの解決)。
    return undefined;
  }
}
