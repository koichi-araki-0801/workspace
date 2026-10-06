// =============================================================================
// reviewCompareDocs.ts — 精査画面の左右組版比較(PreviewPanel×2)へ渡す完全文書
// =============================================================================
// 精査画面の主役は「修正前｜修正後」を実際の帳票と同じ組版(vivliostyle)で並べる比較で、
// 本モジュールは compare サービスが返す本文 HTML + CSS を PreviewPanel が受け取れる
// 完全文書へ包み、変更ページへマーカーとアンカーを付ける。
//
// - マーカーは変更のあったページの各パーツ(body 直下の要素)に付ける。ページを包む要素は
//   作らず、区切り(`div.pagebreak`)と `<style>` には付けない。ページの分け方は `pageItems` +
//   `splitPages` が決める。
// - マーカーは既存の差分装飾と同じ「CSPRNG レイヤ名のカスケードレイヤ + !important」で
//   守る(申請者 CSS は同レイヤ名を当てられない限り上書きできない)。`display` は
//   上書きしない(表セルのレイアウトを壊す)。
// - ここで作る文書は**表示専用**で、申請へ保存されるバイト列(html/css/filledHtml)には
//   一切触れない。DOM 経由の再直列化はこの表示境界だけで行う。
// - 変更ページの粒度は `buildHtmlDiff` の `diff.pages` の index（0 始まり）。diff 側も同じ
//   `pageItems` + `splitPages` で数えるため、index と本文のページ順は対応する。

import { rebaseCssForDoc } from '@editor/shared';
import { pageItems, splitPages } from '@/lib/pageBreaks';

export interface CompareDocsInput {
  beforeHtml: string;
  afterHtml: string;
  cssBefore: string;
  cssAfter: string;
  /** 変更ページの index 集合(0 始まり。`buildHtmlDiff` の `diff.pages` の index 由来)。 */
  changedPageIndexes: ReadonlySet<number>;
  /**
   * diff 計算(`buildHtmlDiff`)が数えた before/after 各面の期待ページ数
   * (`HtmlDiff.beforePageCount`/`afterPageCount`)。省略時は下記の不一致検査をしない
   * (既存呼び出し元 = 呼び出しテストとの互換のため optional)。
   */
  beforeExpectedPageCount?: number;
  afterExpectedPageCount?: number;
  /** 黄マーカーを描くか。false でも位置ジャンプ用のアンカー id は付ける。 */
  marker: boolean;
}

export interface CompareDocs {
  beforeDoc: string;
  afterDoc: string;
  /** after 文書内の出現順の**変更ページのみ**のアンカー id(「次の変更箇所へ」の巡回に使う)。 */
  anchors: string[];
  /**
   * 全ページのアンカー id(index = ページ index、0 始まり)。承認タブのコメント一覧が
   * 「行クリックで該当ページへ」に使う(コメントは変更の有無に関わらず全パーツに付けられる
   * ため、変更ページだけの `anchors` では添字が合わない)。degrade でページ数不一致になった
   * 面は空配列。
   */
  pageAnchors: string[];
}

/**
 * body 直下を `splitPages` でページに分け、変更ページの各パーツへ印を、全ページの先頭の
 * パーツへアンカー id を付ける。
 */
function annotatePages(
  html: string,
  changedPageIndexes: ReadonlySet<number>,
  expectedPageCount?: number,
): { html: string; anchorByIndex: Map<number, string>; pageIds: string[] } {
  const anchorByIndex = new Map<number, string>();
  if (!html.trim()) return { html, anchorByIndex, pageIds: [] };
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const { pages } = splitPages(pageItems(doc.body.children));
  // diff 側が数えたページ数(`beforePageCount`/`afterPageCount`)と、この文書から数えたページ数が
  // 食い違う場合(CSS の page-break 欠落等)、index の対応が崩れ「無関係なページ」を変更ページ
  // として誤ってマークしてしまう。この面のマーク・アンカーは安全側(空)へ倒す。
  if (expectedPageCount !== undefined && pages.length !== expectedPageCount) {
    return { html, anchorByIndex, pageIds: [] };
  }
  const pageIds = pages.map((parts, i) => {
    const head = parts[0];
    if (!head) return '';
    // 既存 id は差分キーの一部でありうるため上書きしない(未設定のときだけ振る)。全ページに
    // 付ける(コメント一覧のページジャンプは変更の有無を問わない)。
    if (!head.id) head.id = `review-anchor-${i + 1}`;
    if (changedPageIndexes.has(i)) {
      for (const el of parts) el.setAttribute('data-review-marker', '');
      anchorByIndex.set(i, head.id);
    }
    return head.id;
  });
  return { html: doc.body.innerHTML, anchorByIndex, pageIds };
}

/** マーカー装飾。レイヤ名は文書ごとに CSPRNG で変え、申請者 CSS からの同名上書きを防ぐ。 */
function markerCss(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  const layer = `rvm${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
  return [
    `@layer ${layer};`,
    `@layer ${layer} {`,
    '[data-review-marker] {',
    '  background-color: #FFF3BF !important;',
    '  outline: 2px solid #E8B931 !important;',
    '  outline-offset: 1px !important;',
    '}',
    '}',
  ].join('\n');
}

/** 完全な HTML 文書を組み立てる。マーカー CSS は申請者 CSS より前に出す。 */
function wrapDoc(bodyHtml: string, css: string, marker: boolean): string {
  const markerBlock = marker ? `<style>${markerCss()}</style>` : '';
  // 申請者 CSS は css/ 基準で書かれているので、文書(`doc/`)基準へ 1 回だけ付け替えて埋め込む。
  // マーカーのレイヤ宣言は申請者 CSS より**前**に出す(重要宣言はレイヤ優先順位が逆転する
  // 性質を使うため、先に宣言した側が勝つ)。
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8">${markerBlock}<style>${rebaseCssForDoc(css)}</style></head><body>${bodyHtml}</body></html>`;
}

export function buildCompareDocs(input: CompareDocsInput): CompareDocs {
  const before = annotatePages(
    input.beforeHtml,
    input.changedPageIndexes,
    input.beforeExpectedPageCount,
  );
  const after = annotatePages(
    input.afterHtml,
    input.changedPageIndexes,
    input.afterExpectedPageCount,
  );
  // ページ index の昇順。after 優先、after に無い index は before から拾う。
  const indexes = [
    ...new Set([...after.anchorByIndex.keys(), ...before.anchorByIndex.keys()]),
  ].sort((a, b) => a - b);
  const anchors = indexes.map(
    (i) => after.anchorByIndex.get(i) ?? (before.anchorByIndex.get(i) as string),
  );
  // 変更ページが 1 つも解決できない文書はマーカー無しへ degrade（マークもジャンプも出ない）。
  const hasPages = after.anchorByIndex.size > 0 || before.anchorByIndex.size > 0;
  const markerEnabled = input.marker && hasPages;
  // 全ページのジャンプ先は各 index で after 優先、無ければ before から拾う。
  // 著者由来 id は保持される：同じ index で片側だけ著者 id のとき、after[i]
  // は before パネルでは解決されず何も起きない。previewHost のアンカー検査
  // /^[A-Za-z0-9_-]+$/ に合わない著者 id は無視される。after の行数を超える
  // index は before パネルだけが移動する。添字 = ページ index が契約なので、
  // 空要素を詰めない(詰めると以後のページ送りが全部ずれる。空 id は送信側が弾く)。
  const pageAnchors = Array.from(
    { length: Math.max(after.pageIds.length, before.pageIds.length) },
    (_, i) => after.pageIds[i] ?? before.pageIds[i] ?? '',
  );
  return {
    beforeDoc: wrapDoc(before.html, input.cssBefore, markerEnabled),
    afterDoc: wrapDoc(after.html, input.cssAfter, markerEnabled),
    anchors,
    pageAnchors,
  };
}
