// =============================================================================
// pageBreaks.ts — 改ページの警告と、ページ分けの結果の読み方(canvas・比較・承認・ページ線で共有)
// =============================================================================
// 役割: どこでページが切れるかの判定(`splitPages` / `pageItems` / `inlineBreak` など)は、承認の
// 確定を検査するサーバも画面と同じ数え方をするよう shared の `pageSplit.ts` に置き、ここは同じ
// 名前で再 export する(web の import 先を変えない)。ここに残すのは web だけが使うもの:
// 分けた結果の読み方(`pageHead` など)と、印刷で効くのに画面のページに出ない指定の警告
// (`findIgnoredInlineBreaks` / `pagebreakCssDefined` / `cssRuleBreakSelector` など)。
//
// - style 属性の `page-break-*` を Vivliostyle は効かせない(CSS の規則に書けば効く)。`break-*` の
//   `always` も効かない。どちらも警告で知らせる(`findIgnoredInlineBreaks`)。
// - `pagebreakCssDefined` と `cssRuleBreakSelector` は警告用で、判定には使わない。
//
// Worker(linkedom)には `Node` グローバルが無いので、`instanceof` や `Node.ELEMENT_NODE` は
// 使わず、`tagName` / `getAttribute` / `classList` / `children` だけを読む
// (shared の `htmlDiff.ts` の `isElement` と同じ作法)。

import {
  chipSource,
  inlineBreak,
  isBreakValue,
  isFrozenBody,
  isPagebreakEl,
  PAGEBREAK_CLASS,
  type PageSplit,
  parseDecls,
  rootBlocks,
  splitCssRules,
} from '@editor/shared';
import { DATA_JINJA, DATA_OPAQUE, DATA_OPAQUE_KIND, JINJA_CHIP_CLASS } from './jinjaAttrs';
import { REDLINE_ATTR } from './redlineAttr';

export {
  inlineBreak,
  isBreakValue,
  isPagebreakEl,
  PAGEBREAK_CLASS,
  type PageSplit,
  pageItems,
  rootBlocks,
  splitPages,
} from '@editor/shared';

/** 旧来の別名 `page-break-before` / `page-break-after` の値のうち改ページを意味するもの。 */
function isLegacyBreakValue(v: string | undefined): boolean {
  return v === 'always' || v === 'left' || v === 'right';
}

/**
 * 要素の inline `style` の、その端の印刷では効かない改ページ指定のプロパティ名
 * (`page-break-*` の改ページの値と `break-*: always`)。同じプロパティが複数あれば最後の値で
 * 判じる(style 属性と同じく後勝ち)。同じ端が `break-*` で改ページしているかは見ない。
 */
export function ignoredInlineBreakProps(el: Element, edge: 'before' | 'after'): string[] {
  const style = el.getAttribute('style');
  if (!style) return [];
  const last = new Map(parseDecls(style));
  const out: string[] = [];
  if (isLegacyBreakValue(last.get(`page-break-${edge}`))) out.push(`page-break-${edge}`);
  if (last.get(`break-${edge}`) === 'always') out.push(`break-${edge}`);
  return out;
}

/**
 * 要素の inline `style` に、印刷では効かない改ページ指定があり、同じ端が `break-*` で改ページして
 * いないか。
 */
function hasIgnoredInlineBreak(el: Element): boolean {
  return (['before', 'after'] as const).some(
    (edge) => !inlineBreak(el, edge) && ignoredInlineBreakProps(el, edge).length > 0,
  );
}

/** 出力のチップが `|safe` を通すか(値が HTML のまま出る)。 */
const SAFE_FILTER_RE = /\|\s*safe\b/;

/** `hasVisibleElementMarkup` の走査用(`lastIndex` を設定してから使う)。 */
const ANY_LT_RE = /</g;
const RAWTEXT_OPEN_RE = /<(style|script)(?=[\s>/])/y;
const STYLE_CLOSE_RE = /<\/style[^>]*>/g;
const SCRIPT_CLOSE_RE = /<\/script[^>]*>/g;

/**
 * 描画すると要素になりうるチップか。値の出力(`{{ }}`)で `|safe` を通すものは値が HTML のまま
 * 出て、`{% raw %}` のチップで中身に `<style>` `<script>` 以外の `<` を含むものは中身が文字どおり
 * 出る。どちらも canvas では数えないチップ(shared の `pageSplit.ts` の `isVanishingChip`)なので、根の直下にあると承認・比較と
 * パーツの番号がずれうる。テストから直接検証するために公開する。
 */
export function isElementizingChip(el: Element): boolean {
  if (!el.classList.contains(JINJA_CHIP_CLASS)) return false;
  if (el.hasAttribute(DATA_JINJA)) {
    const src = chipSource(el, DATA_JINJA);
    return src.startsWith('{{') && SAFE_FILTER_RE.test(src);
  }
  if (el.getAttribute(DATA_OPAQUE_KIND) !== 'rawtext') return false;
  const src = chipSource(el, DATA_OPAQUE);
  return src.startsWith('{%') && hasVisibleElementMarkup(src);
}

/**
 * 原文から `<style>…</style>` と `<script>…</script>` を除いた残りに `<` があるか。この 2 つだけの
 * 原文は描画で見えない要素にしかならない(`pageSplit.ts` の `isVanishingChip` が `<style>` だけの原文を数えないのと
 * 同じ)。閉じの無い開きは残り全部を飲む。
 */
function hasVisibleElementMarkup(src: string): boolean {
  const lower = src.toLowerCase();
  let from = 0;
  for (;;) {
    ANY_LT_RE.lastIndex = from;
    const lt = ANY_LT_RE.exec(lower);
    if (!lt) return false;
    RAWTEXT_OPEN_RE.lastIndex = lt.index;
    const open = RAWTEXT_OPEN_RE.exec(lower);
    if (!open) return true;
    const close = open[1] === 'style' ? STYLE_CLOSE_RE : SCRIPT_CLOSE_RE;
    close.lastIndex = lt.index;
    const end = close.exec(lower);
    if (!end) return false;
    from = end.index + end[0].length;
  }
}

/** 根の直下(固めた範囲の包みは中身へ展開する)の、描画で要素になりうるチップ。警告用。 */
export function findElementizingChips(root: Element): Element[] {
  return rootBlocks(Array.from(root.children)).filter(isElementizingChip);
}

/** ページ `p` に置かれた区切り(無ければ undefined)。 */
export function pageBreakOn<T extends Element>(split: PageSplit<T>, p: number): T | undefined {
  const k = split.breakPages.indexOf(p);
  return k >= 0 ? split.breakEls[k] : undefined;
}

/**
 * ページ `i` の先頭の要素。パーツがあれば最初のパーツ、白紙のページならそのページの区切り、
 * 要素の無い白紙のページ(左右合わせで挟んだもの)なら次のページの先頭。区切りは置かれたページの
 * 末尾にあるので、パーツのあるページでは先頭にならない。ページへ送る・ページの境目に線を引く・
 * ページの末尾へ挿入する、の基準に使う。
 */
export function pageHead<T extends Element>(split: PageSplit<T>, i: number): T | undefined {
  for (let p = Math.max(i, 0); p < split.pages.length; p++) {
    const part = split.pages[p][0];
    if (part) return part;
    const brk = pageBreakOn(split, p);
    if (brk) return brk;
  }
  return undefined;
}

/**
 * ページ `i` が要素の無い白紙のページ(左右合わせで挟んだもの。パーツも区切りも置かれない)か。
 * canvas に描く要素が無いので、1 ページ表示の帯(`pageView.ts` の `pageViewCss`)とページ線
 * (`usePageGuides.ts`)が別に扱う。
 */
export function isElementlessPage<T extends Element>(split: PageSplit<T>, i: number): boolean {
  const page = split.pages[i];
  return page !== undefined && page.length === 0 && !pageBreakOn(split, i);
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
      // 固めた範囲の包みの中身は、包みと同じ深さとして見る(`rootBlocks` と同じ)。
      walk(el, isFrozenBody(el) ? nested : true);
    }
  };
  walk(root, false);
  return out;
}

/**
 * 印刷では効かない inline の改ページ指定(`page-break-*` の改ページの値と `break-*: always`)を
 * 持つ要素。深さは問わない(根の直下でも入れ子でも、印刷で改ページしないのは同じ)。区切りの
 * 代わりに書かれていることが多いので、警告で区切りへの置き換えを促す。赤入れの削除要素の配下は
 * 見ない。
 */
export function findIgnoredInlineBreaks(root: Element): Element[] {
  const out: Element[] = [];
  const walk = (parent: Element): void => {
    for (const el of Array.from(parent.children)) {
      if (el.hasAttribute(REDLINE_ATTR)) continue;
      if (hasIgnoredInlineBreak(el)) out.push(el);
      walk(el);
    }
  };
  walk(root);
  return out;
}

/**
 * 区切りを指すセレクタ。子孫・結合子つきのもの(`.x .pagebreak`)は根の直下と限らないので数えない。
 * ただし `body` / `html body` の子孫・子(`body div.pagebreak` など)は根の直下の区切りを必ず含むので
 * 数える(入れ子の区切りにも効く分は `findUncountedBreaks` の警告が拾う)。型セレクタは大文字小文字を
 * 区別しないが、クラス名は区別する。
 */
const PAGEBREAK_SELECTOR_RE = new RegExp(
  `^(?:(?:[Hh][Tt][Mm][Ll](?:\\s*>\\s*|\\s+))?[Bb][Oo][Dd][Yy](?:\\s*>\\s*|\\s+))?` +
    `(?:[Dd][Ii][Vv])?\\.${PAGEBREAK_CLASS}$`,
);
const BREAK_PROP_RE = /^break-(?:before|after)$/;
const LEGACY_BREAK_PROP_RE = /^page-break-(?:before|after)$/;

/**
 * 規則 1 つの頭（`{` の前。コメントを除く）・セレクタの並び（`,` で分ける）・宣言。`{` の無い
 * ものは null。判定の値の範囲は呼び出し側が持つ。
 */
function readRule(text: string): {
  head: string;
  selectors: string[];
  decls: Array<[string, string]>;
} | null {
  const open = text.indexOf('{');
  if (open < 0) return null;
  const head = text
    .slice(0, open)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .trim();
  return {
    head,
    selectors: head.split(',').map((s) => s.trim()),
    decls: parseDecls(text.slice(open + 1, text.lastIndexOf('}'))),
  };
}

/**
 * CSS に `.pagebreak` の改ページ指定があるか(区切りが印刷で効くかの警告用。判定には使わない)。
 * `@media print` などの入れ子の中も見る(`splitCssRules` が降りる)。CSS の規則では、style 属性と
 * 違って `page-break-*` も効く(値は `always` / `left` / `right`)。`break-*` は `always` が効かない。
 *
 * `breakDeclAccepts` との値の範囲の違いは意図したもの。こちらは「区切りの CSS があるか」を
 * 実際の印刷どおりに判定する。Vivliostyle は `break-*: always` を改ページにしないので数えない。
 */
export function pagebreakCssDefined(css: string): boolean {
  for (const rule of splitCssRules(css)) {
    const parsed = readRule(rule.text);
    if (!parsed?.selectors.some((s) => PAGEBREAK_SELECTOR_RE.test(s))) continue;
    const breaks = parsed.decls.some(
      ([prop, value]) =>
        (BREAK_PROP_RE.test(prop) && isBreakValue(value)) ||
        (LEGACY_BREAK_PROP_RE.test(prop) && isLegacyBreakValue(value)),
    );
    if (breaks) return true;
  }
  return false;
}

/**
 * 改ページの宣言の値が効くか。`break-*` は `break-*` の値と旧来の値(`always` など)、旧来の別名
 * `page-break-*` は旧来の値だけ(`page-break-before:column` は無効な値)。
 *
 * `pagebreakCssDefined` との値の範囲の違いは意図したもの。こちらは「区切り以外の改ページ指定」を
 * 知らせる警告なので、印刷で効かない `break-*: always` も数えて多めに知らせる側へ倒す。
 */
function breakDeclAccepts(prop: string, value: string): boolean {
  return isLegacyBreakValue(value) || (!prop.startsWith('page-') && isBreakValue(value));
}

/** 左右の改ページの値(`break-*`)。区切りの `break-after` にあると、区切りの数え方とずれる。 */
const SIDED_BREAK_VALUES = new Set(['left', 'right', 'recto', 'verso']);

/**
 * CSS の規則に書いた改ページ指定のうち、編集画面のページに数えないものの最初のセレクタ(警告に
 * 例として出す。無ければ null)。判定には使わない(ページ数・区切りの扱いは変えない)。
 *
 * - `.pagebreak` 以外のセレクタの改ページ指定(`h2{break-before:page}` など)。Vivliostyle は効かせる
 *   ので、その分だけ編集画面のページ数がプレビューより少なくなる。
 * - `.pagebreak` の前で改ページする指定と、後ろの左右の指定。区切りは常に「後ろで改ページする要素」
 *   として数えるので、切れ方がずれる。`.pagebreak{break-after:page}` は正規の指定で対象外。
 *
 * `@media screen` の中など印刷に効かない規則も対象にする(媒体の判定はせず、警告は安全側へ倒す)。
 * セレクタの並びは `,` で分ける(`:is(a, b)` の中の `,` でも分かれるが、例の表示にしか使わない)。
 */
export function cssRuleBreakSelector(sources: readonly string[]): string | null {
  for (const css of sources) {
    for (const rule of splitCssRules(css)) {
      const parsed = readRule(rule.text);
      if (!parsed || parsed.head.startsWith('@')) continue;
      const { decls } = parsed;
      const breaks = (edge: 'before' | 'after', accepts?: (v: string) => boolean) =>
        decls.some(
          ([prop, value]) =>
            (prop === `break-${edge}` || prop === `page-break-${edge}`) &&
            breakDeclAccepts(prop, value) &&
            (accepts?.(value) ?? true),
        );
      const before = breaks('before');
      const after = breaks('after');
      if (!before && !after) continue;
      const sidedAfter = breaks('after', (v) => SIDED_BREAK_VALUES.has(v));
      for (const sel of parsed.selectors) {
        if (!PAGEBREAK_SELECTOR_RE.test(sel) || before || sidedAfter) return sel;
      }
    }
  }
  return null;
}
