// =============================================================================
// cssRebase.ts — リクエスト CSS の相対 url() を、CSS を埋め込む先の基準へ付け替える
// =============================================================================
// テンプレの CSS は `css/<テンプレ>.css` に置かれ、CSS 自身から見た相対パス(`url(fonts/x.woff2)`)で
// 書かれる。ところが PDF・プレビューでは、その CSS を文書の `<style>` へ埋め込むため、相対
// URL は文書の位置を基準に解決されてしまう。埋め込む瞬間に付け替えて、「`<link>` で読んだときと
// 同じ実体」に届くようにする。
//
// `rebaseCssForDoc` は文書を `doc/<文書>.html` に置く論理配置(`resolveDocAssetPath`)向けで、
// `url(fonts/x)` を `url("../css/fonts/x")` にする。`doc/` と `css/` が同じ深さの兄弟なので
// 2 回掛けても形は変わらないが、呼び出しは「リクエスト CSS が文書へ入る入口で 1 回」に限り、
// その場所は import のガードテストで固定している
// (`server/test/requestCss.guard.test.ts`・`web/test/cssRebase.guard.test.ts`)。
//
// 走査は検査・配置と同じ `collectCssUrlSpans` を使う。別の正規表現で拾い直すと「検査は見たが
// 付け替えは見ていない」形の食い違いが生まれる。引用符文字列(`image-set("…")`・`content`)は
// 付け替えない — 本文の文字列を壊さないため、相対参照は `url()` で書く契約にしている。

import { type CssUrlSpan, collectCssUrlSpans, isSelfContainedUrl } from './cssExternalRefs.js';
import { resolveDocAssetPath } from './htmlExternalRefs.js';

/**
 * 論理配置でリクエスト CSS が置かれているとみなす位置。付け替えの基準になるのは置き場
 * (`css/`)だけで、ファイル名は解決に関与しない。web も CSS の参照元として同じ値を使う
 * (定数を 2 か所に書かない)。
 */
export const DOC_CSS_PATH = 'css/template.css';

/**
 * `css/<テンプレ>.css` の位置にある CSS の相対 `url()` を、`doc/` に置いた文書から見た相対
 * (`url("../css/fonts/x")`・`url("../images/x")`)へ書き換える。付け替えられない値
 * (絶対 URL・`data:`・`#`・`/` 始まり・ルートの外や `doc/` 配下を指す形)は原文のまま残す。
 */
export function rebaseCssForDoc(css: string): string {
  return rewriteCssUrls(css, (pathPart) => {
    const rel = resolveDocAssetPath(pathPart, DOC_CSS_PATH);
    return rel === undefined ? undefined : `../${rel}`;
  });
}

/** `url()` を後ろから順に書き換える。`resolve` は値のパス部分を新しいパスへ写す(対象外は undefined)。 */
function rewriteCssUrls(css: string, resolve: (pathPart: string) => string | undefined): string {
  return rewriteCssUrlSpans(css, (span) => {
    const rewritten = rewriteUrlValue(span.value, resolve);
    return rewritten === undefined ? undefined : `url("${rewritten}")`;
  });
}

/**
 * `text` の範囲 `spans`(位置順で重ならないもの)を後ろから順に `f` の結果へ置き換える
 * (undefined を返した範囲は残す)。後ろから置き換えるので、先行する範囲の位置がずれない。
 */
export function replaceSpansFromEnd<S extends { start: number; end: number }>(
  text: string,
  spans: readonly S[],
  f: (span: S) => string | undefined,
): string {
  let out = text;
  for (let k = spans.length - 1; k >= 0; k--) {
    const span = spans[k];
    const next = f(span);
    if (next === undefined) continue;
    out = `${out.slice(0, span.start)}${next}${out.slice(span.end)}`;
  }
  return out;
}

/**
 * CSS の `url()` 式(`collectCssUrlSpans` の範囲)を、`f` が返す文字列へ置き換える(undefined は
 * 原文のまま)。走査は検査・配置と同じ `collectCssUrlSpans` 1 本で、別の正規表現で拾い直さない。
 */
export function rewriteCssUrlSpans(
  css: string,
  f: (span: CssUrlSpan) => string | undefined,
): string {
  return replaceSpansFromEnd(css, collectCssUrlSpans(css), f);
}

/** 1 つの URL 値を付け替える。対象外なら `undefined`。 */
function rewriteUrlValue(
  value: string,
  resolve: (pathPart: string) => string | undefined,
): string | undefined {
  const v = value.trim();
  if (v === '' || v.startsWith('#') || v.startsWith('/') || v.startsWith('\\')) return undefined;
  if (!isSelfContainedUrl(v) || /^data:/i.test(v)) return undefined;
  const cut = v.search(/[?#]/);
  const pathPart = cut < 0 ? v : v.slice(0, cut);
  const suffix = cut < 0 ? '' : v.slice(cut);
  const resolved = resolve(pathPart);
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
