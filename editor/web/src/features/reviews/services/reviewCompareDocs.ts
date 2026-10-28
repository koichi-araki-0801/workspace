// =============================================================================
// reviewCompareDocs.ts — 精査画面の左右組版比較(PreviewPanel×2)へ渡す完全文書
// =============================================================================
// 精査画面の主役は「修正前｜修正後」を実際の帳票と同じ組版(Vivliostyle)で並べる比較で、
// 本モジュールはcompareサービスが返す本文HTMLとCSSをPreviewPanelが受け取れる
// 完全文書へ包み、変更ページへアンカー、変更パーツへ見た目の印を付ける。
//
// - ページ移動用アンカーは変更ページへ付ける。見た目のマーカーは文字タブと同じ
//   `partKey`で指定された変更パーツだけへ付け、同じページの変更なしパーツには付けない。
// - `changed`は修正前・修正後の両側、`added`は修正後側、`removed`は修正前側だけを
//   マーカー対象とする。
// - マーカーはパーツ全体へ付ける。パーツ内部の文字単位の差分は
//   「文字の変更を一覧で見る」で確認する。
// - ページを包む要素は作らず、区切り(`div.pagebreak`)と`<style>`には印を付けない。
//   ページの分け方は`pageItems`と`splitPages`が決める。
// - マーカーはpreview-hostが解釈できるインラインの`!important`宣言で付ける。
//   申請者CSSに同じプロパティがあっても印を表示し、`display`は変更しないため、
//   表やセルのレイアウトを壊さない。
// - ここで作る文書は表示専用で、申請へ保存されるバイト列
//   (`html`、`css`、`filledHtml`)には一切触れない。
// - DOM経由の再直列化は、この表示境界だけで行う。
// - 変更ページの粒度は`buildHtmlDiff`の`diff.pages`のindex(0始まり)とする。
//   diff側も同じ`pageItems`と`splitPages`で数えるため、indexと本文のページ順は対応する。

import { rebaseCssForDoc } from '@editor/shared';
import { occurrenceKeys, rawKey } from '@/lib/blockKey';
import { pageHead, pageItems, splitPages } from '@/lib/pageBreaks';

interface CompareDocsInput {
  beforeHtml: string;
  afterHtml: string;
  beforeMarkerPartKeys: ReadonlySet<string>;
  afterMarkerPartKeys: ReadonlySet<string>;
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

interface CompareDocs {
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
/** preview-hostが解釈できるインライン重要宣言で、変更パーツへ見た目の印を付ける。 */
function applyMarkerStyle(element: HTMLElement): void {
  element.style.setProperty('background-color', '#FFF3BF', 'important');
  element.style.setProperty('outline', '2px solid #E8B931', 'important');
  element.style.setProperty('outline-offset', '1px', 'important');
}

/**
 * body直下を`splitPages`でページに分け、`markerPartKeys`に含まれるパーツだけへ印を付ける。
 * 全ページの先頭要素にはページ移動用のアンカーidを付け、変更ページのアンカーを
 * 「次の変更箇所へ」の巡回対象にする。
 *
 * 白紙ページでは区切り要素がページ先頭になるが、区切りはパーツとして数えず、
 * マーカーも付けない。
 */
function annotatePages(
  html: string,
  changedPageIndexes: ReadonlySet<number>,
  markerPartKeys: ReadonlySet<string>,
  marker: boolean,
  expectedPageCount?: number,
): { html: string; anchorByIndex: Map<number, string>; pageIds: string[] } {
  const anchorByIndex = new Map<number, string>();
  if (!html.trim()) return { html, anchorByIndex, pageIds: [] };
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const split = splitPages(pageItems(doc.body.children));
  const { pages } = split;
  // 差分側の`DiffBlock.partKey`と同じ規則で、文書全体のパーツへ通し番号を振る。
  const allParts = pages
    .flat()
    .filter((element): element is HTMLElement => element instanceof HTMLElement);
  const partKeys = occurrenceKeys(allParts.map(rawKey));
  const partKeyByElement = new Map(allParts.map((element, index) => [element, partKeys[index]]));

  // diff 側が数えたページ数(`beforePageCount`/`afterPageCount`)と、この文書から数えたページ数が
  // 食い違う場合(CSS の page-break 欠落等)、index の対応が崩れ「無関係なページ」を変更ページ
  // として誤ってマークしてしまう。この面のマーク・アンカーは安全側(空)へ倒す。
  if (expectedPageCount !== undefined && pages.length !== expectedPageCount) {
    return { html, anchorByIndex, pageIds: [] };
  }
  const pageIds = pages.map((parts, i) => {
    const head = pageHead(split, i);
    // 要素の無い本文(文字だけ)は先頭の要素が無い。添字をページに揃えたまま空文字を置き、
    // ジャンプ先にしない(`ReviewVisualCompare.vue` は空文字を送らない)。
    if (!head) return '';
    // 既存 id は差分キーの一部でありうるため上書きしない(未設定のときだけ振る)。全ページに
    // 付ける(コメント一覧のページジャンプは変更の有無を問わない)。
    if (!head.id) head.id = `review-anchor-${i + 1}`;

    if (changedPageIndexes.has(i)) {
      anchorByIndex.set(i, head.id);
    }

    for (const element of parts) {
      if (!(element instanceof HTMLElement)) continue;

      const partKey = partKeyByElement.get(element);
      if (!partKey || !markerPartKeys.has(partKey)) continue;

      element.setAttribute('data-review-marker', '');
      if (marker) applyMarkerStyle(element);
    }

    return head.id;
  });
  return { html: doc.body.innerHTML, anchorByIndex, pageIds };
}

/** 申請者CSSと、マーカー適用済みの本文を完全なHTML文書へ包む。 */
function wrapDoc(bodyHtml: string, css: string): string {
  // 申請者CSSはcss/基準で書かれているため、文書(`doc/`)基準へ1回だけ付け替える。
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><style>${rebaseCssForDoc(css)}</style></head><body>${bodyHtml}</body></html>`;
}

export function buildCompareDocs(input: CompareDocsInput): CompareDocs {
  const before = annotatePages(
    input.beforeHtml,
    input.changedPageIndexes,
    input.beforeMarkerPartKeys,
    input.marker,
    input.beforeExpectedPageCount,
  );
  const after = annotatePages(
    input.afterHtml,
    input.changedPageIndexes,
    input.afterMarkerPartKeys,
    input.marker,
    input.afterExpectedPageCount,
  );
  // ページ index の昇順。after 優先、after に無い index は before から拾う。
  const indexes = [
    ...new Set([...after.anchorByIndex.keys(), ...before.anchorByIndex.keys()]),
  ].sort((a, b) => a - b);
  const anchors = indexes.map(
    (i) => after.anchorByIndex.get(i) ?? (before.anchorByIndex.get(i) as string),
  );
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
    beforeDoc: wrapDoc(before.html, input.cssBefore),
    afterDoc: wrapDoc(after.html, input.cssAfter),
    anchors,
    pageAnchors,
  };
}
