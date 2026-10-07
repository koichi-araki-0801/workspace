// =============================================================================
// pageWarnings.ts — 編集画面のページ・パーツが承認タブ・プレビューとずれうる理由の警告文
// =============================================================================
// 編集画面は根の直下の `div.pagebreak` でページを分ける(`@/lib/pageBreaks`)。それ以外の改ページ
// 指定は印刷では効くのに画面のページに出ず、逆に CSS に `.pagebreak` の指定が無ければ画面の区切り
// が PDF では改ページにならない。要素の style 属性に書いた `page-break-*` は、画面でも印刷でも
// 改ページにならない(Vivliostyle が効かせない)。CSS の規則に書いた改ページ指定は数えない。
// 本文の直下の `|safe` などの差し込みは描画で要素になり、承認タブとパーツの番号がずれうる。
// アンカーの属性に差し込みのあるパーツは、承認タブとキーが一致しない。旧形式のキーのメモ・修正
// 履歴はどのパーツにも当たらない。どれも開くことは止めず、資産の警告(`@/lib/assetWarnings`)の
// 後ろに並べて知らせる。
//
// 警告文は `<div class="pagebreak">` の字面を含むので、Vue のテンプレートへ直書きせず補間で出す
// (資産の警告と同じ置き場で、同じくテキストとして挿す)。

import { pagebreakCssDefined } from '@/lib/pageBreaks';

/** 警告の材料。数はどれも件数で、0 なら出さない。 */
export interface PageWarningFacts {
  /** 数えていない改ページ指定の数(`findUncountedBreaks`)。 */
  uncounted: number;
  /** 印刷では効かない inline の改ページ指定を持つ要素の数(`findIgnoredInlineBreaks`)。 */
  ignoredInline: number;
  /** 数えた区切りの数(`splitPages` の `breakEls`)。 */
  counted: number;
  /** テンプレの CSS か本文の `<style>` に `.pagebreak` の改ページ指定があるか。 */
  cssDefined: boolean;
  /** 数えない CSS の規則の改ページ指定の例のセレクタ(`cssRuleBreakSelector`)。無ければ null。 */
  cssRuleBreak: string | null;
  /** 根の直下の、描画で要素になりうるチップの数(`findElementizingChips`)。 */
  elementizingChips: number;
  /** アンカーの属性の原文に Jinja を持つ根の直下のパーツの数(`jinjaAnchoredParts`)。 */
  jinjaAnchors: number;
  /** 読み込んだメモと修正履歴のうち旧形式のキーの件数(`legacyPartKeyCount`)。 */
  legacyKeys: number;
}

/** 数えていない改ページ指定があるときの警告。 */
export const UNCOUNTED_BREAK_WARNING = (n: number): string =>
  `改ページとして数えていない指定が ${n} か所あります` +
  '（ページの一番外側にない <div class="pagebreak"> や、入れ子の要素の改ページ指定）。' +
  '編集画面のページ数がプレビューとずれることがあります';

/** 印刷では効かない inline の改ページ指定があるときの警告。 */
export const IGNORED_INLINE_BREAK_WARNING = (n: number): string =>
  `印刷では改ページされない指定が ${n} か所あります` +
  '（要素に直接書いた page-break-before/after や break-before/after: always）。' +
  '区切り（<div class="pagebreak">）を使ってください';

/** CSS の規則に、編集画面のページに数えない改ページ指定があるときの警告。 */
export const CSS_RULE_BREAK_WARNING = (selector: string): string =>
  `書式に、区切り（.pagebreak）以外の改ページの指定があります（例: ${selector}）。` +
  '編集画面のページ数には数えないので、本当のページ数はプレビューで確かめてください。';

/** 区切りはあるのに CSS に `.pagebreak` の改ページ指定が無いときの警告。 */
export const PAGEBREAK_CSS_WARNING =
  'テンプレの CSS に .pagebreak の改ページ指定がありません。' +
  'PDF は編集画面の区切りどおりに改ページされません';

/** 本文の直下に、描画で要素になりうる差し込みがあるときの警告。 */
export const ELEMENTIZING_CHIP_WARNING =
  '本文の直下に、描画すると要素になる差し込み（|safe など）があります。' +
  '承認タブとパーツの番号がずれることがあるので、パーツ（div など）の中へ入れてください。';

/** アンカーの属性に差し込みのあるパーツがあるときの警告。 */
export const JINJA_ANCHOR_WARNING =
  'パーツの名前（data-part-id・id・class）に差し込みがあります。' +
  'このパーツのメモは承認タブで別のパーツ扱いになるので、data-part-id を固定の値で付けてください。';

/** 旧形式のキーのメモ・修正履歴があるときの警告。 */
export const LEGACY_KEY_WARNING = (n: number): string =>
  `古い形式のキーのメモ・修正履歴が ${n} 件あり、どのパーツにも表示していません`;

/**
 * 警告欄に足す文を、数えていない指定 → 印刷で効かない inline の指定 → CSS の規則の改ページ指定 →
 * CSS の欠け → 要素になる差し込み → アンカーの差し込み → 旧形式のキーの順で返す。区切りが 1 つも
 * 無いテンプレは CSS の指定が要らないので、CSS の欠けの警告を出さない。
 */
export function pageWarnings(f: PageWarningFacts): string[] {
  const out: string[] = [];
  if (f.uncounted > 0) out.push(UNCOUNTED_BREAK_WARNING(f.uncounted));
  if (f.ignoredInline > 0) out.push(IGNORED_INLINE_BREAK_WARNING(f.ignoredInline));
  if (f.cssRuleBreak !== null) out.push(CSS_RULE_BREAK_WARNING(f.cssRuleBreak));
  if (f.counted > 0 && !f.cssDefined) out.push(PAGEBREAK_CSS_WARNING);
  if (f.elementizingChips > 0) out.push(ELEMENTIZING_CHIP_WARNING);
  if (f.jinjaAnchors > 0) out.push(JINJA_ANCHOR_WARNING);
  if (f.legacyKeys > 0) out.push(LEGACY_KEY_WARNING(f.legacyKeys));
  return out;
}

/**
 * テンプレの CSS と本文の `<style>` のどちらかに `.pagebreak` の改ページ指定があるか。本文の
 * `<style>` も印刷に効くので、片方にあれば警告しない。
 */
export function pagebreakCssDefinedIn(templateCss: string, bodyStyles: readonly string[]): boolean {
  return pagebreakCssDefined(templateCss) || bodyStyles.some((css) => pagebreakCssDefined(css));
}
