// =============================================================================
// pageBreaks.ts — 改ページの位置の判定(canvas・比較・承認・ページ線・警告で共有)
// =============================================================================
// 役割: どこでページが切れるかを決める唯一の置き場。テンプレは `.page` で包まず、内容の根
// (canvas では GrapesJS の wrapper、静的な文書では body)の直下に空の `<div class="pagebreak">`
// を置いて改ページを表す。根の直下のパーツの inline `style` に書いた改ページ指定も数える。
// 呼び出し側ごとに数え方が違うと、ページ数・パーツの番号・メモのキーが画面ごとに食い違うため、
// 判定はここに集める。
//
// ページの切れ方はプレビュー・PDF の組版エンジン(Vivliostyle)に合わせる。e2e
// (`editor/e2e/page_breaks.spec.ts`)で同じ形を実際に組ませて突き合わせている。要点は次のとおり。
// - 区切りは中身の無い要素として 1 ページを占める。先頭の区切り・連続した区切り・inline の
//   `break-after` の直後の区切りは白紙のページを作る。最後の要素の後ろの改ページは消える。
// - style 属性の `page-break-*` を Vivliostyle は効かせない(CSS の規則に書けば効く)。`break-*` の
//   `always` も効かない。どちらも警告で知らせる(`findIgnoredInlineBreaks`)。
// - `left` / `right` は、横書きで 1 ページ目を右とし、左右が交互に来る前提で白紙を挟む。あふれた
//   ページは数えないので、あふれのある文書では左右がずれうる(紙のページはプレビューが正)。
//
// CSS の解析と computed style は判定に使わず、DOM だけで決める。computed style は canvas でしか
// 取れず(静的な文書・Worker には無い)、全要素を読むので重い。テンプレの CSS が区切りをどう
// 描くか(`display:none` など)にも判定を左右させない。`pagebreakCssDefined` と
// `cssRuleBreakSelector` は警告用で、判定には使わない。
//
// Worker(linkedom)には `Node` グローバルが無いので、`instanceof` や `Node.ELEMENT_NODE` は
// 使わず、`tagName` / `getAttribute` / `classList` / `children` だけを読む
// (`features/compare/htmlBlockDiff.ts` の `isElement` と同じ作法)。

import { splitCssRules } from '@editor/shared';
import { BODY_STYLE_VIEW_ATTR } from './bodyStyleAttr';
import {
  b64decodeSafe,
  DATA_JINJA,
  DATA_OPAQUE,
  DATA_OPAQUE_KIND,
  FROZEN_BODY_CLASS,
  JINJA_CHIP_CLASS,
} from './jinjaAttrs';
import { REDLINE_ATTR } from './redlineAttr';

/** 改ページの区切りを表すクラス。 */
export const PAGEBREAK_CLASS = 'pagebreak';

/** 改ページの種類。`left` / `right` は次のページを左(右)のページにする。 */
type BreakKind = 'page' | 'left' | 'right';

/**
 * `break-before` / `break-after` の値を改ページの種類にする(改ページしない値は null)。
 * `column` / `region` は段組み・領域の無い本文の直下では改ページになる。`always` は
 * Vivliostyle が受け付けない。`recto` / `verso` は横書きでは右 / 左。
 */
function breakKind(v: string | undefined): BreakKind | null {
  switch (v) {
    case 'page':
    case 'column':
    case 'region':
      return 'page';
    case 'left':
    case 'verso':
      return 'left';
    case 'right':
    case 'recto':
      return 'right';
    default:
      return null;
  }
}

/** `break-before` / `break-after` の値のうち改ページを意味するもの。 */
export function isBreakValue(v: string | undefined): boolean {
  return breakKind(v) !== null;
}

/** 旧来の別名 `page-break-before` / `page-break-after` の値のうち改ページを意味するもの。 */
function isLegacyBreakValue(v: string | undefined): boolean {
  return v === 'always' || v === 'left' || v === 'right';
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
 * 要素の inline `style` の、その端の改ページの種類(無ければ null)。同じ端の宣言が複数あれば
 * 最後のものを採る。`page-break-*` は読まない: Vivliostyle は style 属性の `page-break-*` を
 * 改ページにも、`break-*` の打ち消しにも使わない。
 */
function inlineBreakKind(el: Element, edge: 'before' | 'after'): BreakKind | null {
  const style = el.getAttribute('style');
  if (!style) return null;
  let kind: BreakKind | null = null;
  for (const [prop, value] of parseDecls(style)) {
    if (prop === `break-${edge}`) kind = breakKind(value);
  }
  return kind;
}

/** 要素の inline `style` が、その端で改ページを指定しているか(`break-before` / `break-after`)。 */
export function inlineBreak(el: Element, edge: 'before' | 'after'): boolean {
  return inlineBreakKind(el, edge) !== null;
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

/** 固めた範囲の包み(`div.jinja-frozen-body`)か。 */
function isFrozenBody(el: Element): boolean {
  return el.tagName.toLowerCase() === 'div' && el.classList.contains(FROZEN_BODY_CLASS);
}

/**
 * 根の直下の要素の並び。固めた範囲の包み(`div.jinja-frozen-body`)は、その中身で置き換える
 * (入れ子の包みも同じ)。包みは canvas で `display: contents` の表示用の要素で、保存・描画した
 * 文書(承認タブ・比較が読む)には無く、中身が根の直下に並ぶ。包みのまま数えると、本文全体を
 * 固めた文書が 1 ページ・1 パーツになり、中の区切りはどれも数えない区切りになる。
 */
export function rootBlocks<T extends Element>(children: Iterable<T>): T[] {
  const out: T[] = [];
  for (const el of children) {
    if (isFrozenBody(el)) {
      out.push(...rootBlocks(Array.from(el.children) as T[]));
    } else {
      out.push(el);
    }
  }
  return out;
}

/** 描画後も要素として残る `rawtext` のチップの原文(`<style>` 以外の要素)。 */
const RAWTEXT_PART_SOURCE_RE = /^<(?!style[\s>/])[a-z]/i;

/** 出力のチップが `|safe` を通すか(値が HTML のまま出る)。 */
const SAFE_FILTER_RE = /\|\s*safe\b/;

/** `hasVisibleElementMarkup` の走査用(`lastIndex` を設定してから使う)。 */
const ANY_LT_RE = /</g;
const RAWTEXT_OPEN_RE = /<(style|script)(?=[\s>/])/y;
const STYLE_CLOSE_RE = /<\/style[^>]*>/g;
const SCRIPT_CLOSE_RE = /<\/script[^>]*>/g;

/**
 * 保存・描画した文書で要素として残らないチップか。`{% set %}` などの文と Jinja コメントは描画で
 * 消え、出力(`{{ }}`)は地の文になる(どれも `data-jinja` を持つ)。原文を運ぶ `rawtext` の
 * チップは、原文が `<style>` なら数えない要素に、`{% raw %}` なら地の文に戻るので数えず、
 * `<textarea>` などほかの要素ならパーツに数える。`script` / `math` のチップは描画後も要素なので
 * パーツに数える。
 *
 * 出力(`|safe` など)や `{% raw %}` の中身は描画で要素になりうるが、canvas では数えない(承認・比較は
 * 描画した文書を数えるので番号がずれうる)。そうなりうるチップは `isElementizingChip` で拾って
 * 警告する。
 */
function isVanishingChip(el: Element): boolean {
  if (!el.classList.contains(JINJA_CHIP_CLASS)) return false;
  if (el.hasAttribute(DATA_JINJA)) return true;
  if (el.getAttribute(DATA_OPAQUE_KIND) !== 'rawtext') return false;
  return !RAWTEXT_PART_SOURCE_RE.test(chipSource(el, DATA_OPAQUE));
}

/** チップの属性(`data-jinja` / `data-opaque`)が運ぶ原文。読めない base64 は空として扱う。 */
function chipSource(el: Element, attr: string): string {
  return b64decodeSafe(el.getAttribute(attr) ?? '');
}

/**
 * 描画すると要素になりうるチップか。値の出力(`{{ }}`)で `|safe` を通すものは値が HTML のまま
 * 出て、`{% raw %}` のチップで中身に `<style>` `<script>` 以外の `<` を含むものは中身が文字どおり
 * 出る。どちらも canvas では数えないチップ(`isVanishingChip`)なので、根の直下にあると承認・比較と
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
 * 原文は描画で見えない要素にしかならない(`isVanishingChip` が `<style>` だけの原文を数えないのと
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

/**
 * 根の直下の要素のうち、ページ分けとパーツの番号に数えるもの(パーツと区切り)。固めた範囲の包みは
 * 中身へ展開する(`rootBlocks`)。`<style>` は見えない要素で、数えると後ろのパーツの番号がずれる。
 * canvas では本文の `<style>` が置き場の要素(`[data-body-style]`)に
 * 差し替わっているので、それも除く。赤入れの削除要素(`[data-redline]`)は生 DOM だけの表示物で
 * 文書に無い。描画で要素として残らないチップ(`isVanishingChip`)も除く。canvas・承認タブ・比較が
 * 同じ集合を `splitPages` へ渡すよう、除く規則はここ 1 か所に置く。
 */
export function pageItems<T extends Element>(children: Iterable<T>): T[] {
  return rootBlocks(children).filter(
    (el) =>
      el.tagName.toLowerCase() !== 'style' &&
      !el.hasAttribute(REDLINE_ATTR) &&
      !el.hasAttribute(BODY_STYLE_VIEW_ATTR) &&
      !isVanishingChip(el),
  );
}

export interface PageSplit<T extends Element> {
  /**
   * ページごとのパーツ(区切りの要素は含まない)。必ず 1 ページ以上(要素が 0 個なら [[]])。
   * 白紙のページ(区切りだけのページ、左右合わせで挟んだページ)は空の配列。
   */
  pages: T[][];
  /** 数えた区切りの要素(根の直下の `div.pagebreak`)。先頭・末尾・連続のものも含む(帯を出すため)。 */
  breakEls: T[];
  /**
   * `breakEls` の各区切りが置かれるページの番号(同じ順)。区切りは置かれたページの末尾にあり、
   * その後ろで改ページする。白紙のページの区切りは、その白紙のページに置かれる。
   */
  breakPages: number[];
}

/**
 * 根の直下の要素の並び(呼び出し側が赤入れの要素などを除いたもの)をページに分ける。
 *
 * 要素(パーツと区切り)を順に今のページへ置き、隣り合う 2 つの要素の境目に改ページの要求
 * (前の要素の `after`、後ろの要素の `before`)があれば新しいページを始める。区切りは `after` に
 * 改ページを持つ中身の無い要素として置く(テンプレの CSS の `.pagebreak{break-after:page}` と同じ)。
 * 同じ境目の要求は 1 回で、要求の間に要素が区切りしか無ければ白紙のページになる。最初の要素の
 * `before` と最後の要素の `after` は改ページしない。
 *
 * 左右の指定は、後ろの要素の `before` を前の要素の `after` より優先し、`page` より左右の指定を
 * 優先する。新しいページが指定と逆の側なら、白紙のページを 1 枚挟む。最初の要素の左右の指定は
 * 1 ページ目の側を決める(白紙を挟まない)。
 */
export function splitPages<T extends Element>(blocks: readonly T[]): PageSplit<T> {
  const pages: T[][] = [[]];
  const breakEls: T[] = [];
  const breakPages: number[] = [];
  let firstSide: 'left' | 'right' = 'right';
  const sideOf = (i: number) => (i % 2 === 0 ? firstSide : firstSide === 'left' ? 'right' : 'left');
  let after: BreakKind | null = null;
  blocks.forEach((el, n) => {
    const sep = isPagebreakEl(el);
    const before = inlineBreakKind(el, 'before');
    if (n === 0) {
      if (before === 'left' || before === 'right') firstSide = before;
    } else {
      const sided = [before, after].find((k) => k === 'left' || k === 'right');
      const kind = sided ?? before ?? after;
      if (kind) {
        pages.push([]);
        if (kind !== 'page' && sideOf(pages.length - 1) !== kind) pages.push([]);
      }
    }
    const cur = pages.length - 1;
    if (sep) {
      breakEls.push(el);
      breakPages.push(cur);
    } else {
      pages[cur].push(el);
    }
    after = inlineBreakKind(el, 'after') ?? (sep ? 'page' : null);
  });
  return { pages, breakEls, breakPages };
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
 * 型セレクタは大文字小文字を区別しないが、クラス名は区別する。
 */
const PAGEBREAK_SELECTOR_RE = new RegExp(`^(?:[Dd][Ii][Vv])?\\.${PAGEBREAK_CLASS}$`);
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
