// =============================================================================
// reviewCompareDocs.ts — 承認タブの紙面(PreviewPanel)へ渡す完全文書
// =============================================================================
// 本文は `buildReviewPaper`(shared の `reviewPaper.ts`)が判定・空き枠・番号の属性まで組んだもの
// で、ここではそれを申請者 CSS と一緒に完全文書へ包み、ページの先頭へアンカー id を振るだけを行う。
//
// - 見た目(番号札・枠・空き枠・文字の差分の色)は足さない。ホスト(`previewHost.ts` の
//   `decorate()`)が描画済みの要素へ描く。Vivliostyle は文書の `style` 属性を描画済みの要素へ写さない
//   ので、文書側に inline style や色の CSS を書いても申請者 CSS に負けうる(計画で決めたこと 19)。
//   文字の差分は `buildReviewPaper` の `highlight` が `.cmp-ins` / `.cmp-del` の class を付けるまで。
// - アンカーは承認タブのコメント一覧の「行から該当ページへ」(`gotoPage`)に使う。渡される index は
//   確定版の改ページで数えた論理ページなので、物理ページの番号(`goToPage`)では溢れた帳票でずれる。
//   論理ページの先頭要素へ移れば、ホストがその要素の物理ページを開く。
// - ここで作る文書は表示専用で、申請へ保存されるバイト列には触れない。

import { type ReviewPaper, rebaseCssForDoc } from '@editor/shared';
import { pageHead, pageItems, splitPages } from '@/lib/pageBreaks';
import { styleTag } from '@/lib/sanitizeCss';

export interface CompareDoc {
  doc: string;
  /**
   * 論理ページごとのアンカー id(添字 = ページ index、0 始まり)。要素の無いページは空文字
   * (送る側が弾く)。添字がずれないよう、空文字も詰めない。
   */
  pageAnchors: string[];
}

/**
 * 本文の各ページの先頭要素へアンカー id を振る。既存の id は申請者 CSS・テンプレ JS が参照
 * しうるので上書きしない(その id をそのままアンカーにする)。
 */
function annotatePages(html: string): { html: string; pageAnchors: string[] } {
  if (!html.trim()) return { html, pageAnchors: [] };
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const split = splitPages(pageItems(doc.body.children));
  const pageAnchors = split.pages.map((_, i) => {
    const head = pageHead(split, i);
    if (!head) return '';
    if (!head.id) head.id = `review-anchor-${i + 1}`;
    return head.id;
  });
  return { html: doc.body.innerHTML, pageAnchors };
}

/** 紙面の本文を申請者 CSS と一緒に完全文書へ包む。 */
export function buildCompareDoc(input: { paper: ReviewPaper; css: string }): CompareDoc {
  const { html, pageAnchors } = annotatePages(input.paper.html);
  // 申請者 CSS は css/ 基準で書かれているので文書(doc/)基準へ 1 回だけ付け替え、`</style>` で
  // 文書の構造を抜けられないように包む。
  const doc = `<!doctype html><html lang="ja"><head><meta charset="utf-8">${styleTag(rebaseCssForDoc(input.css))}</head><body>${html}</body></html>`;
  return { doc, pageAnchors };
}
