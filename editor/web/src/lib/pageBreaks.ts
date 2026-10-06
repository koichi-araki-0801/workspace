// =============================================================================
// pageBreaks.ts — 改ページの位置の判定(canvas・比較・承認・ページ線・警告で共有)
// =============================================================================
// 役割: どこでページが切れるかを決める唯一の置き場。テンプレは `.page` で包まず、内容の根
// (canvas では GrapesJS の wrapper、静的な文書では body)の直下に空の `<div class="pagebreak">`
// を置いて改ページを表す。根の直下のパーツの inline `style` に書いた改ページ指定も数える。
// 呼び出し側ごとに数え方が違うと、ページ数・パーツの番号・メモのキーが画面ごとに食い違うため、
// 判定はここに集める。
//
// CSS の解析と computed style は判定に使わず、DOM だけで決める。computed style は canvas でしか
// 取れず(静的な文書・Worker には無い)、全要素を読むので重い。テンプレの CSS が区切りをどう
// 描くか(`display:none` など)にも判定を左右させない。`pagebreakCssDefined` は印刷で区切りが
// 効くかの警告用で、判定には使わない。
//
// Worker(linkedom)には `Node` グローバルが無いので、`instanceof` や `Node.ELEMENT_NODE` は
// 使わず、`tagName` / `getAttribute` / `classList` / `children` だけを読む
// (`features/compare/htmlBlockDiff.ts` の `isElement` と同じ作法)。

import { splitCssRules } from '@editor/shared';
import { REDLINE_ATTR } from './redlineAttr';

/** 改ページの区切りを表すクラス。 */
export const PAGEBREAK_CLASS = 'pagebreak';

/** `break-*` / `page-break-*` の値のうち改ページを意味するもの。 */
export function isBreakValue(v: string | undefined): boolean {
  return (
    v === 'always' ||
    v === 'page' ||
    v === 'left' ||
    v === 'right' ||
    v === 'recto' ||
    v === 'verso'
  );
}

/**
 * 区切り(`<div class="pagebreak">`)か。数えるのは根の直下に置かれたものだけで、位置の判定は
 * 呼び出し側(`splitPages` に渡す並び)が受け持つ。クラス名は大文字小文字を区別する(HTML の
 * クラスセレクタと同じ)。
 */
export function isPagebreakEl(el: Element): boolean {
  return el.tagName.toLowerCase() === 'div' && el.classList.contains(PAGEBREAK_CLASS);
}

/** プロパティ名として読める形(カスタムプロパティとベンダ接頭辞を含む)。 */
const PROP_NAME_RE = /^-{0,2}[a-z][-a-z0-9]*$/;

/**
 * 宣言の並び(inline `style` か規則の本文)を `[プロパティ名, 値]` の列にする。コメントは CSS の
 * 字句と同じく空白として読む(中の `;` で宣言を割らず、値の途中なら値を 2 語に分ける)。
 * プロパティ名として読めない宣言は捨てる(ブラウザも無視するので、後勝ちの対象にしない)。値は
 * `!important` を外し、比較用に小文字へそろえる。
 */
function parseDecls(text: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const decl of text.replace(/\/\*[\s\S]*?(?:\*\/|$)/g, ' ').split(';')) {
    const colon = decl.indexOf(':');
    if (colon < 0) continue;
    const prop = decl.slice(0, colon).trim().toLowerCase();
    if (!PROP_NAME_RE.test(prop)) continue;
    const value = decl
      .slice(colon + 1)
      .replace(/!\s*important\s*$/i, '')
      .trim()
      .toLowerCase();
    out.push([prop, value]);
  }
  return out;
}

/**
 * 要素の inline `style` が、その端で改ページを指定しているか。`page-break-*` は `break-*` の
 * 別名なので、同じ端の宣言はどちらで書いても最後のものを採る(ブラウザのカスケードと同じ)。
 */
export function inlineBreak(el: Element, edge: 'before' | 'after'): boolean {
  const style = el.getAttribute('style');
  if (!style) return false;
  const props = new Set([`page-break-${edge}`, `break-${edge}`]);
  let on = false;
  for (const [prop, value] of parseDecls(style)) {
    if (props.has(prop)) on = isBreakValue(value);
  }
  return on;
}

/**
 * 根の直下の要素のうち、ページ分けとパーツの番号に数えるもの(パーツと区切り)。`<style>` は
 * 見えない要素で、数えると後ろのパーツの番号がずれ、`<style>` だけのページもできる。赤入れの
 * 削除要素(`[data-redline]`)は生 DOM だけの表示物で文書に無い。canvas・承認タブ・比較が
 * 同じ集合を `splitPages` へ渡すよう、除く規則はここ 1 か所に置く。
 */
export function pageItems<T extends Element>(children: Iterable<T>): T[] {
  return Array.from(children).filter(
    (el) => el.tagName.toLowerCase() !== 'style' && !el.hasAttribute(REDLINE_ATTR),
  );
}

export interface PageSplit<T extends Element> {
  /** ページごとのパーツ(区切りの要素は含まない)。必ず 1 ページ以上(パーツが 0 個なら [[]])。 */
  pages: T[][];
  /** 数えた区切りの要素(根の直下の `div.pagebreak`)。先頭・末尾・連続のものも含む(帯を出すため)。 */
  breakEls: T[];
}

/**
 * 根の直下の要素の並び(呼び出し側が赤入れの要素などを除いたもの)をページに分ける。改ページの
 * 要求(区切り・inline の `before` / `after`)は、次のパーツの手前で、今のページにパーツが
 * あるときだけ新しいページにする。連続した要求は 1 回にまとまり、先頭と末尾の要求は空の
 * ページを作らずに消える。
 */
export function splitPages<T extends Element>(blocks: readonly T[]): PageSplit<T> {
  const pages: T[][] = [];
  const breakEls: T[] = [];
  let cur: T[] = [];
  let pending = false;
  for (const el of blocks) {
    if (isPagebreakEl(el)) {
      breakEls.push(el);
      pending = true;
      continue;
    }
    if (inlineBreak(el, 'before')) pending = true;
    if (pending && cur.length > 0) {
      pages.push(cur);
      cur = [];
    }
    pending = inlineBreak(el, 'after');
    cur.push(el);
  }
  pages.push(cur);
  return { pages, breakEls };
}

/**
 * 数えていない区切り(根の直下でない `div.pagebreak`、根の直下でない要素の inline 改ページ)。
 * 印刷では効くのに画面のページには出ないので、警告で知らせるために集める。赤入れの削除要素
 * (`[data-redline]`)は生 DOM だけの表示物で文書に無いので、その配下は見ない。
 */
export function findUncountedBreaks(root: Element): Element[] {
  const out: Element[] = [];
  const walk = (parent: Element, nested: boolean): void => {
    for (const el of Array.from(parent.children)) {
      if (el.hasAttribute(REDLINE_ATTR)) continue;
      if (nested && (isPagebreakEl(el) || inlineBreak(el, 'before') || inlineBreak(el, 'after'))) {
        out.push(el);
      }
      walk(el, true);
    }
  };
  walk(root, false);
  return out;
}

/**
 * 区切りを指すセレクタ。子孫・結合子つきのもの(`.x .pagebreak`)は根の直下と限らないので数えない。
 * 型セレクタは大文字小文字を区別しないが、クラス名は区別する。
 */
const PAGEBREAK_SELECTOR_RE = new RegExp(`^(?:[Dd][Ii][Vv])?\\.${PAGEBREAK_CLASS}$`);
const BREAK_PROP_RE = /^(?:page-)?break-(?:before|after)$/;

/**
 * CSS に `.pagebreak` の改ページ指定があるか(区切りが印刷で効くかの警告用。判定には使わない)。
 * `@media print` などの入れ子の中も見る(`splitCssRules` が降りる)。
 */
export function pagebreakCssDefined(css: string): boolean {
  for (const rule of splitCssRules(css)) {
    const open = rule.text.indexOf('{');
    if (open < 0) continue;
    const selectors = rule.text
      .slice(0, open)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split(',')
      .map((s) => s.trim());
    if (!selectors.some((s) => PAGEBREAK_SELECTOR_RE.test(s))) continue;
    const body = rule.text.slice(open + 1, rule.text.lastIndexOf('}'));
    if (parseDecls(body).some(([prop, value]) => BREAK_PROP_RE.test(prop) && isBreakValue(value))) {
      return true;
    }
  }
  return false;
}
