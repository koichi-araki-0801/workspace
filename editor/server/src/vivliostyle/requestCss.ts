// =============================================================================
// requestCss.ts — build 入口でリクエスト CSS を文書基準へ付け替える(入口 1 回だけ)
// =============================================================================
// リクエストの `css` は `css/<テンプレ>.css` の位置に置かれた CSS として解釈する(外部 API の
// 契約。OpenAPI の説明と設計正典に明記)。文書は作業フォルダの `doc/` に置かれ、CSS はそこへ
// `<style>` として埋め込むので、埋め込む前に相対 `url()` を `doc/` から見た形(`../css/…`)へ
// 直す。付け替えた CSS と原文の CSS が経路ごとに混ざらないよう、呼ぶのは `build.ts` の 3 入口
// (`/api/build`・`/build/merge`・`/api/preview`)の先頭だけ — 配線は `test/requestCss.guard.test.ts`
// が固定する。
// HTML の `<style>`・`style` 属性は付け替えない(ブラウザが `doc/` 基準で普通に解く)。

import { rebaseCssForDoc } from '@editor/shared';

/** リクエスト CSS を付け替える。未指定は空文字(以降の処理は `css ?? ''` と同じ扱い)。 */
export function rebaseRequestCss(css: string | undefined): string {
  return css ? rebaseCssForDoc(css) : '';
}
