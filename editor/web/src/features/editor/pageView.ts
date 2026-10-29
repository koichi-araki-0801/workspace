// =============================================================================
// pageView.ts — 編集 canvas の「1 ページだけ表示」純粋ロジック
// =============================================================================
// 役割: `useGrapes.ts` のページ送り(1 ページ表示)から DOM/GrapesJS 非依存の判定だけを
// 切り出したもの。ページの印付け・可視制御 CSS の生成・index クランプを純粋関数にして
// vitest で全分岐を直接検証できるようにする(実レイアウトに依存しない)。どこでページが
// 切れるかは `@/lib/pageBreaks` の `splitPages` が決め、ここはその結果を画面へ写すだけ。

import { inlineBreak, type PageSplit, pageBreakOn, rootBlocks } from '@/lib/pageBreaks';
import {
  BAND_DASH,
  BAND_FONT_SIZE,
  BAND_TEXT_COLOR,
  BLANK_BAND_HEIGHT,
  BLANK_PAGE_LABEL,
  PV_BLANK_ATTR,
} from './pagebreakCanvas';

/** 生 DOM へ付ける現在ページ判定用のマーカー属性。Component モデルには載せない。 */
export const PV_ATTR = 'data-pv-idx';

/**
 * 根の直下の要素へ、属するページの番号を `PV_ATTR` として付ける(古い印は先に消す)。固めた範囲の
 * 包み(`display: contents`)には付けず、中身へ付ける(`rootBlocks`)。包みは箱を作らないので、
 * 中身を隠せばページごとに隠れる。
 *
 * - パーツ: `split.pages` のページ番号。
 * - 区切り(`div.pagebreak`): 置かれたページの番号(`split.breakPages`)。区切りはそのページの
 *   末尾にあるので、1 ページ表示ではページの末尾に帯が見える。白紙のページは帯だけが見える。
 *   区切りだけの白紙のページの先頭の区切りには、白紙の印(`PV_BLANK_ATTR`)も付ける。
 * - 数えない要素(`<style>`・本文の `<style>` の置き場・赤入れの削除要素): 隣の要素のページ。
 *   印の無い要素は可視制御の対象から外れて全ページに出続けるので、すべての要素に付ける。
 *   区切りか inline の `break-after` を持つパーツの後ろ(または先頭)にあれば次のパーツか区切りの
 *   ページ、そうでなければ直前のパーツのページ(比較の `htmlBlockDiff.ts` の `splitTopLevel` と
 *   同じ)。赤入れで消えたパーツは元の位置に置かれるので、元のページで見える。
 */
export function markPages(root: HTMLElement, split: PageSplit<HTMLElement>): void {
  for (const el of Array.from(root.querySelectorAll(`[${PV_ATTR}]`))) {
    el.removeAttribute(PV_ATTR);
  }
  for (const el of Array.from(root.querySelectorAll(`[${PV_BLANK_ATTR}]`))) {
    el.removeAttribute(PV_BLANK_ATTR);
  }
  // 区切りだけの白紙のページは、その先頭の区切りを白紙のページの帯として描く
  // (`pagebreakCanvas.ts`)。
  split.pages.forEach((page, p) => {
    if (page.length > 0) return;
    pageBreakOn(split, p)?.setAttribute(PV_BLANK_ATTR, '');
  });
  const pageOf = new Map<Element, number>();
  split.pages.forEach((page, i) => {
    for (const part of page) pageOf.set(part, i);
  });
  split.breakEls.forEach((el, i) => {
    pageOf.set(el, split.breakPages[i]);
  });
  const breaks = new Set<Element>(split.breakEls);
  let last = 0;
  // 直前に数えたものが改ページの後ろを持たないパーツか(false なら、まだ何も無いか改ページの後ろ)。
  let afterPart = false;
  let pending: Element[] = [];
  const mark = (el: Element, i: number) => el.setAttribute(PV_ATTR, String(i));
  for (const el of rootBlocks(Array.from(root.children))) {
    const page = pageOf.get(el);
    if (page !== undefined) {
      for (const p of pending) mark(p, page);
      pending = [];
      mark(el, page);
      last = page;
      afterPart = !breaks.has(el) && !inlineBreak(el, 'after');
    } else if (afterPart) {
      mark(el, last);
    } else {
      pending.push(el);
    }
  }
  for (const p of pending) mark(p, last);
}

/**
 * 要素の無い白紙のページを表示しているときに wrapper の先頭に出す帯。見た目の値は
 * `pagebreakCanvas.ts` の区切りの帯と共有する。
 */
const ELEMENTLESS_PAGE_CSS =
  `[data-gjs-type=wrapper]::before { content: '${BLANK_PAGE_LABEL}'; display: block; ` +
  `height: ${BLANK_BAND_HEIGHT}; line-height: ${BLANK_BAND_HEIGHT}; text-align: center; ` +
  `color: ${BAND_TEXT_COLOR}; font-size: ${BAND_FONT_SIZE}; ` +
  `border-top: ${BAND_DASH}; border-bottom: ${BAND_DASH}; }`;

/**
 * 他ページを隠す page-view `<style>` の textContent を作る。`canvas` head に注入する 2 枚目の
 * style(load 時の A4/jinja スタイルとは別)へ流し込み、ページ送りのたびに書き換える。
 *
 * - 1 ページ表示でページが 2 枚以上のときだけ、現在 index 以外の印の要素を `display:none` にする。
 *   現在ページの要素には何も当てない(パーツが `flex` などの `display` を持つため上書きしない)。
 *   要素の無い白紙のページ(`elementless`)を表示しているときは、描く要素が無いので wrapper の
 *   `::before` に白紙のページの帯を出す。
 * - 全ページ表示(`!singleMode`)または 1 ページ以下のときは空文字 = 従来の連続スクロール。
 *
 * セレクタを wrapper(`[data-gjs-type=wrapper]`)の中に絞るのは詳細度のため。区切りの帯の規則
 * (`[data-gjs-type=wrapper] > div.pagebreak` の `!important`)より詳細度を高くしないと、隠した
 * ページの帯が見えてしまう。子結合子にしないのは、固めた範囲の包みの中身にも印が付くため。印は
 * `markPages` がページの単位の要素にだけ付けるので、子孫結合子でも他の要素には当たらない。
 */
export function pageViewCss(
  index: number,
  count: number,
  singleMode: boolean,
  elementless: boolean,
): string {
  if (!singleMode || count <= 1) return '';
  const hide = `[data-gjs-type=wrapper] [${PV_ATTR}]:not([${PV_ATTR}="${index}"]) { display: none !important; }`;
  return elementless ? `${hide}\n${ELEMENTLESS_PAGE_CSS}` : hide;
}

/** ページ index を `[0, count-1]` に収める(count=0 / 負数 / 超過を 0 起点で安全化)。 */
export function clampPageIndex(index: number, count: number): number {
  return Math.min(Math.max(index, 0), Math.max(count - 1, 0));
}
