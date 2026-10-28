// =============================================================================
// htmlBlockDiff.ts — 版の比較・承認画面の差分表示(着色の srcdoc と CSS の検査)
// =============================================================================
// 役割: 差分の計算そのもの(`buildHtmlDiff` など)は、承認の確定を検査するサーバも画面と同じ
// 実装を使うよう shared の `htmlDiff.ts` に置く。ここはそれを既定のパーサ(`DOMParser`)付きで
// 呼べる形と同じ名前の再 export に加え、画面だけが使うものを持つ: 着色済みの断片を srcdoc に
// 包む `buildDiffDoc`(推測できないレイヤ名を毎回作る)と、CSSOM で読む `hasPrintOnlyRules`
// (サーバには CSSOM が無い)。

import {
  buildHtmlDiff as buildSharedHtmlDiff,
  buildHtmlDiffAligned as buildSharedHtmlDiffAligned,
  HL_ADDED,
  HL_CHANGED,
  HL_COARSE,
  HL_DEL,
  HL_INS,
  HL_REMOVED,
  type HtmlDiff,
  type PagePair,
} from '@editor/shared';
import { defaultHtmlParser, type HtmlParser } from '@/lib/htmlParser';
import { randomHex } from '@/lib/newId';
import { styleTag } from '@/lib/sanitizeCss';

export {
  type BlockStatus,
  collapse,
  createLcsBudget,
  type DiffOp,
  diffTokens,
  HL_ADDED,
  HL_CHANGED,
  HL_COARSE,
  HL_DEL,
  HL_INS,
  HL_REMOVED,
  type HtmlDiff,
  type LcsBudget,
  MAX_LCS_CELLS,
  MAX_LCS_DIM,
  MAX_LCS_TOTAL_CELLS,
  MAX_TOP_LEVEL_BLOCKS,
  type PagePair,
  tokenize,
} from '@editor/shared';

// 版比較(`CompareResultView`)と承認プレビュー(`ReviewDetail`)が共有する、iframe 内の
// ハイライト CSS とドキュメント組み立て。着色ルール(`.cmp-*`)は両画面で同一で、body の
// padding だけ画面ごとに変えるため引数化する(二重管理を避ける)。
/**
 * 装飾はすべて `!important` で書く — `buildDiffDoc` のカスケードレイヤによる守りは
 * **重要宣言でしか優先順位が逆転しない**ため、通常宣言のままだと申請者 CSS に負ける。
 *
 * `visibility` は入れるが **`display` は入れない**。`display:block!important` を足すと
 * `<td class="cmp-changed">` のような正当なマークアップの表レイアウトを壊す
 * (守りが本体を壊す形)。したがって申請者が `display:none` で変更箇所ごと隠す余地は残る —
 * これは装飾の優先度では閉じられないので、承認画面の注記(印刷時のみ効く規則がある旨)と
 * PDF プレビューでの確認で受ける。
 */
export function diffHighlightCss(bodyPadding: number): string {
  return `
  body{margin:0;padding:${bodyPadding}px;background:#fff;}
  .${HL_CHANGED}{background:rgba(220,38,38,.06)!important;box-shadow:inset 3px 0 0 #dc2626!important;visibility:visible!important;}
  .${HL_ADDED}{background:rgba(22,163,74,.08)!important;box-shadow:inset 3px 0 0 #16a34a!important;visibility:visible!important;}
  .${HL_REMOVED}{background:rgba(217,119,6,.08)!important;box-shadow:inset 3px 0 0 #d97706!important;visibility:visible!important;}
  .${HL_INS}{background:rgba(22,163,74,.18)!important;color:#15803d!important;text-decoration:underline!important;border-radius:2px;visibility:visible!important;}
  .${HL_DEL}{background:rgba(220,38,38,.14)!important;color:#b91c1c!important;text-decoration:underline!important;border-radius:2px;visibility:visible!important;}
  .${HL_COARSE}{outline:1px dashed currentColor!important;outline-offset:1px;}
`;
}

/**
 * 着色済みマークアップが粗いフォールバック(`HL_COARSE`)を含むか。承認画面は `DiffBlock` を
 * presentation 用の行(`ReviewPartRow`)へ写す際にフラグ列を落とすため、表示側は着色結果の
 * 字面から判定する(比較画面は `DiffPage.coarse` を直接使える)。本文テキストに同じ字面が
 * 含まれると誤検知しうるが、出るのは注記 1 行だけなので実害はない。
 */
export function hasCoarseDiff(...htmls: string[]): boolean {
  return htmls.some(
    (h) => h.includes(`${HL_DEL} ${HL_COARSE}`) || h.includes(`${HL_INS} ${HL_COARSE}`),
  );
}

/**
 * 差分装飾を置く CSS カスケードレイヤの名前を 1 文書ぶん作る。**推測不能**であることが要件。
 *
 * 申請者は自分の CSS に任意のレイヤを書けるので、名前が既知だと
 * `@layer diff { html body .cmp-ins { background:none !important } }` のように**同じレイヤへ
 * 相乗りして**より高い詳細度で上書きできてしまう(同一レイヤ・同一重要度の中では詳細度と
 * ソース順で決まり、レイヤの守りが働かない)。名前を知られなければこの経路が消える。
 */
function diffLayerName(): string {
  return `d${randomHex(8)}`;
}

/**
 * 断片 HTML を、版ファンド CSS + ハイライト CSS 付きの完結した srcdoc ドキュメントに包む。
 * `css` は他ユーザが書いたテンプレ由来なので `<style>` の脱出を潰してから埋める。
 *
 * `fragment` 側の能動コンテンツは**除去しない**(テンプレの JS は正当なコンテンツで、
 * 承認者は実行結果を見て承認する)。隔離は表示先 iframe の `sandbox="allow-scripts"`
 * (same-origin なし)が担う。ここで潰すのは「`</style>` で CSS 文脈を抜けて親の srcdoc
 * 構造そのものを書き換える」形だけで、これは sandbox の内側でも成立してしまう
 * (ハイライト表示を偽装して差分を隠せる)ため別途必要である。
 *
 * ── 差分装飾を申請者 CSS から守る ──
 * `</style>` 脱出を潰しても、**通常のカスケード**で差分の視覚表現は消せた。申請者 CSS の
 * `.cmp-ins{background:none!important}` が宣言順で勝ち、承認者のペインから着色と左帯が
 * 消えてしまう(= 変更箇所が無いように見える)。
 *
 * 解は CSS カスケードレイヤの**重要宣言では優先順位が逆転する**性質:
 *  - 通常宣言 … 後のレイヤが勝つ / 非レイヤ が レイヤ より強い
 *  - **重要宣言 … 先のレイヤが勝つ / 非レイヤ が 最弱**
 * よって差分装飾を「最初に宣言したレイヤ」に置き `!important` を付ければ、申請者が
 * `!important` を書いても(レイヤ内・レイヤ外どちらでも)上書きできない。
 *
 * 順序が要件そのものなので、レイヤ宣言だけを**申請者 CSS より前**の `<style>` で行う。
 * 後ろに置くと申請者が自分の CSS の先頭で宣言したレイヤの方が先になり、逆転が向こうへ効く。
 * 名前は `diffLayerName` で毎回変える(同名レイヤへの相乗りを塞ぐ)。
 */
export function buildDiffDoc(fragment: string, css: string, highlightCss: string): string {
  const layer = diffLayerName();
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8" /><style>@layer ${layer};</style>${styleTag(css)}${styleTag(`@layer ${layer}{${highlightCss}}`)}</head><body>${fragment}</body></html>`;
}

/**
 * 申請者 CSS に「**印刷時にだけ効く**規則」が含まれるか。承認画面へ注記を出すのに使う。
 *
 * なぜ要るか: 承認者が見る差分ペインは screen メディアだが、成果物(PDF)は print メディアで
 * 組まれる。`.x{display:none}` + `@media print{.x{display:block}}` と書けば「承認者には
 * 見えず PDF にだけ出る」内容を作れる。装飾の優先度(`buildDiffDoc` のカスケードレイヤ)は
 * これを閉じられない — 隠されているのはこちらの装飾ではなく**本文**だからである。
 *
 * 判定は**正規表現ではなく CSSOM** で行う。CSS はエスケープを許すので
 * `@\6d edia print` のような字面を正規表現は取りこぼすが、実ブラウザのパーサは同じ規則として
 * 解く(Chromium で `CSSMediaRule:print` になることを実測済み。同じ理由で
 * `shared/src/security/cssExternalRefs.ts` もトークナイザで判定している)。
 * 入れ子のグループ規則(`@supports` / `@layer` の中の `@media`)まで降りる。
 *
 * これは**注記であって関門ではない**。取りこぼしても承認は止まらず、承認者は PDF
 * プレビュー(vivliostyle = print 相当)で実際の見えを確認できる。
 */
export function hasPrintOnlyRules(css: string): boolean {
  if (!css.trim()) return false;
  // `media="not all"` を付けて**この文書には一切適用させず**、規則の解析結果だけを読む。
  // 切り離した document(`createHTMLDocument`)では stylesheet が結び付かず `sheet` が
  // null になるため、生きた document へ一時的に挿す以外に CSSOM を得る手が無い。
  const el = document.createElement('style');
  el.media = 'not all';
  el.textContent = css;
  document.head.appendChild(el);
  try {
    return el.sheet ? printOnlyInRules(el.sheet.cssRules) : false;
  } finally {
    el.remove();
  }
}

/** メディアクエリが「print には効くが screen には効かない」= 承認者の見えと乖離するか。 */
function divergesFromScreen(mediaText: string): boolean {
  const t = mediaText.toLowerCase();
  if (!/\bprint\b/.test(t)) return false;
  // `screen, print` や `all` は承認者の画面にも効くので乖離しない。
  return !/\bscreen\b/.test(t) && !/\ball\b/.test(t);
}

function printOnlyInRules(rules: CSSRuleList): boolean {
  for (const rule of Array.from(rules)) {
    const media = (rule as CSSMediaRule).media?.mediaText;
    if (media !== undefined && divergesFromScreen(media)) return true;
    // `@supports` / `@layer` の内側にも `@media` は書ける。
    const nested = (rule as CSSGroupingRule).cssRules;
    if (nested && printOnlyInRules(nested)) return true;
  }
  return false;
}

/**
 * shared の `buildHtmlDiff` を既定のパーサ(`DOMParser`)で呼ぶ。`_cssBefore`/`_cssAfter` は
 * 改ページの判定に使わない(改ページは `<body>` 直下の `div.pagebreak` と inline の指定だけで
 * 決める)。引数は Worker の契約と呼び出し側を動かさないために残している。
 */
export function buildHtmlDiff(
  beforeHtml: string,
  afterHtml: string,
  _cssBefore?: string,
  _cssAfter?: string,
  parse: HtmlParser = defaultHtmlParser,
): HtmlDiff {
  return buildSharedHtmlDiff(beforeHtml, afterHtml, parse);
}

/**
 * shared の `buildHtmlDiffAligned`(ページの対応付けを `pairs` で指定する版)を既定のパーサで呼ぶ。
 * `_cssBefore`/`_cssAfter` は `buildHtmlDiff` と同じく改ページの判定に使わない。
 */
export function buildHtmlDiffAligned(
  beforeHtml: string,
  afterHtml: string,
  _cssBefore: string | undefined,
  _cssAfter: string | undefined,
  pairs: PagePair[],
  parse: HtmlParser = defaultHtmlParser,
): HtmlDiff {
  return buildSharedHtmlDiffAligned(beforeHtml, afterHtml, pairs, parse);
}
