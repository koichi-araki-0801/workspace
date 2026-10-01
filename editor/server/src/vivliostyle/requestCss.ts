// =============================================================================
// requestCss.ts — build 入口でリクエスト CSS を css/ 基準へ付け替える(入口 1 回だけ)
// =============================================================================
// リクエストの `css` は `css/<fund>.css` の位置に置かれた CSS として解釈する(外部 API の契約。
// OpenAPI の説明と設計正典に明記)。文書へは `<style>` として埋め込むので、埋め込む前に相対
// `url()` を `css/` 基準へ直す。付け替えは冪等ではないため、呼ぶのは `build.ts` の 3 入口
// (`/api/build`・`/build/merge`・`/api/preview`)の先頭だけ — 配線は
// `test/requestCss.guard.test.ts` が固定する。HTML の `<style>`・`style` 属性は付け替えない。

import { REQUEST_CSS_BASE, rebaseCssUrls } from '@editor/shared';

/** リクエスト CSS を付け替える。未指定は空文字(以降の処理は `css ?? ''` と同じ扱い)。 */
export function rebaseRequestCss(css: string | undefined): string {
  return css ? rebaseCssUrls(css, REQUEST_CSS_BASE) : '';
}
