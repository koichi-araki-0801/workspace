// =============================================================================
// pageSplit.ts — 改ページの位置の判定(canvas・比較・承認・承認の確定で共有)
// =============================================================================
// 役割: どこでページが切れるかを決める唯一の置き場。テンプレは `.page` で包まず、内容の根
// (canvas では GrapesJS の wrapper、静的な文書では body)の直下に空の `<div class="pagebreak">`
// を置いて改ページを表す。根の直下のパーツの inline `style` に書いた改ページ指定も数える。
// 呼び出し側ごとに数え方が違うと、ページ数・パーツの番号・メモのキーが画面ごとに食い違うため、
// 判定はここに集める。承認の確定を検査するサーバも画面と同じページ・キーで数えるので shared に
// 置く。警告用の判定(CSS の規則・数えない区切り)は web の `pageBreaks.ts` に残し、web はそこから
// ここの名前も再 export する。
//
// ページの切れ方はプレビュー・PDF の組版エンジン(Vivliostyle)に合わせる。e2e
// (`editor/e2e/page_breaks.spec.ts`)で同じ形を実際に組ませて突き合わせている。要点は次のとおり。
// - 区切りは中身の無い要素として 1 ページを占める。先頭の区切り・連続した区切り・inline の
//   `break-after` の直後の区切りは白紙のページを作る。最後の要素の後ろの改ページは消える。
// - style 属性の `page-break-*` を Vivliostyle は効かせない(CSS の規則に書けば効く)。`break-*` の
//   `always` も効かない。
// - `left` / `right` は、横書きで 1 ページ目を右とし、左右が交互に来る前提で白紙を挟む。あふれた
//   ページは数えないので、あふれのある文書では左右がずれうる(紙のページはプレビューが正)。
//
// CSS の解析と computed style は判定に使わず、DOM だけで決める。computed style は canvas でしか
// 取れず(静的な文書・Worker・サーバには無い)、全要素を読むので重い。テンプレの CSS が区切りを
// どう描くか(`display:none` など)にも判定を左右させない。
//
// Worker とサーバ(linkedom)には `Node` グローバルが無いので、`instanceof` や `Node.ELEMENT_NODE`
// は使わず、`tagName` / `getAttribute` / `classList` / `children` だけを読む(`htmlDiff.ts` の
// `isElement` と同じ作法)。
/// <reference lib="dom" />
/// <reference lib="dom.iterable" />

import { MARKER_ATTRS } from '../../security/editingMarkers.js';
import { b64decodeSafe } from '../base64Utf8.js';

/** 改ページの区切りを表すクラス。 */
export const PAGEBREAK_CLASS = 'pagebreak';

/** 赤入れで削除を表すために生 DOM へ差し込んだ要素の印。文書(モデル・保存)には載らない。 */
export const REDLINE_ATTR = 'data-redline';

/** 本文の `<style>` の置き場の要素(canvas の view だけに付く)の印。モデルにも保存出力にも無い。 */
export const BODY_STYLE_VIEW_ATTR = 'data-body-style';

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
export function parseDecls(text: string): Array<[string, string]> {
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

/** 固めた範囲の包み(`div.jinja-frozen-body`)か。 */
export function isFrozenBody(el: Element): boolean {
  return el.tagName.toLowerCase() === 'div' && el.classList.contains(MARKER_ATTRS.frozenBodyClass);
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

/** チップの属性(`data-jinja` / `data-opaque`)が運ぶ原文。読めない base64 は空として扱う。 */
export function chipSource(el: Element, attr: string): string {
  return b64decodeSafe(el.getAttribute(attr) ?? '');
}

/**
 * 保存・描画した文書で要素として残らないチップか。`{% set %}` などの文と Jinja コメントは描画で
 * 消え、出力(`{{ }}`)は地の文になる(どれも `data-jinja` を持つ)。原文を運ぶ `rawtext` の
 * チップは、原文が `<style>` なら数えない要素に、`{% raw %}` なら地の文に戻るので数えず、
 * `<textarea>` などほかの要素ならパーツに数える。`script` / `math` のチップは描画後も要素なので
 * パーツに数える。
 *
 * 出力(`|safe` など)や `{% raw %}` の中身は描画で要素になりうるが、canvas では数えない(承認・比較は
 * 描画した文書を数えるので番号がずれうる)。そうなりうるチップは web の `pageBreaks.ts` の
 * `isElementizingChip` で拾って警告する。
 */
function isVanishingChip(el: Element): boolean {
  if (!el.classList.contains(MARKER_ATTRS.chipClass)) return false;
  if (el.hasAttribute(MARKER_ATTRS.jinja)) return true;
  if (el.getAttribute(MARKER_ATTRS.opaqueKind) !== 'rawtext') return false;
  return !RAWTEXT_PART_SOURCE_RE.test(chipSource(el, MARKER_ATTRS.opaque));
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
