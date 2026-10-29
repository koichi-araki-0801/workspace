import { describe, expect, it } from 'vitest';
import {
  CSS_RULE_BREAK_WARNING,
  ELEMENTIZING_CHIP_WARNING,
  IGNORED_INLINE_BREAK_WARNING,
  JINJA_ANCHOR_WARNING,
  LEGACY_KEY_WARNING,
  PAGEBREAK_CSS_WARNING,
  type PageWarningFacts,
  pagebreakCssDefinedIn,
  pageWarnings,
  UNCOUNTED_BREAK_WARNING,
} from '@/features/editor/pageWarnings';

// 編集画面の警告欄に足す改ページ・パーツの警告。文言と並び、出さない条件を固定する。

const UNCOUNTED_2 =
  '改ページとして数えていない指定が 2 か所あります（ページの一番外側にない ' +
  '<div class="pagebreak"> や、入れ子の要素の改ページ指定）。' +
  '編集画面のページ数がプレビューとずれることがあります';
const CSS_MISSING =
  'テンプレの CSS に .pagebreak の改ページ指定がありません。PDF は編集画面の区切りどおりに' +
  '改ページされません';
const IGNORED_3 =
  '印刷では改ページされない指定が 3 か所あります（要素に直接書いた page-break-before/after や ' +
  'break-before/after: always）。区切り（<div class="pagebreak">）を使ってください';
const LEGACY_1 = '古い形式のキーのメモ・修正履歴が 1 件あり、どのパーツにも表示していません';
const CSS_RULE_H2 =
  '書式に、区切り（.pagebreak）以外の改ページの指定があります（例: h2）。' +
  '編集画面のページ数には数えないので、本当のページ数はプレビューで確かめてください。';
const CHIPS =
  '本文の直下に、描画すると要素になる差し込み（|safe など）があります。' +
  '承認タブとパーツの番号がずれることがあるので、パーツ（div など）の中へ入れてください。';
const ANCHORS =
  'パーツの名前（data-part-id・id・class）に差し込みがあります。' +
  'このパーツのメモは承認タブで別のパーツ扱いになるので、data-part-id を固定の値で付けてください。';

const NONE: PageWarningFacts = {
  uncounted: 0,
  ignoredInline: 0,
  counted: 0,
  cssDefined: false,
  cssRuleBreak: null,
  elementizingChips: 0,
  jinjaAnchors: 0,
  legacyKeys: 0,
};
const facts = (over: Partial<PageWarningFacts>): PageWarningFacts => ({ ...NONE, ...over });

describe('pageWarnings', () => {
  it('すべての条件がそろえば 7 文をこの順で返す', () => {
    expect(
      pageWarnings({
        uncounted: 2,
        ignoredInline: 3,
        counted: 3,
        cssDefined: false,
        cssRuleBreak: 'h2',
        elementizingChips: 1,
        jinjaAnchors: 2,
        legacyKeys: 1,
      }),
    ).toEqual([UNCOUNTED_2, IGNORED_3, CSS_RULE_H2, CSS_MISSING, CHIPS, ANCHORS, LEGACY_1]);
  });

  it('既存の 3 条件だけなら従来の 3 文をこの順で返す', () => {
    expect(pageWarnings(facts({ uncounted: 2, counted: 3, legacyKeys: 1 }))).toEqual([
      UNCOUNTED_2,
      CSS_MISSING,
      LEGACY_1,
    ]);
  });

  it('印刷で効かない inline の改ページ指定だけなら 1 文', () => {
    expect(pageWarnings(facts({ ignoredInline: 3 }))).toEqual([IGNORED_3]);
  });

  it('文言の定数は件数・例を差し込む前の形を持つ', () => {
    expect(UNCOUNTED_BREAK_WARNING(5)).toContain('5 か所');
    expect(PAGEBREAK_CSS_WARNING).toBe(CSS_MISSING);
    expect(LEGACY_KEY_WARNING(4)).toContain('4 件');
    expect(IGNORED_INLINE_BREAK_WARNING(6)).toContain('6 か所');
    expect(CSS_RULE_BREAK_WARNING('h3.x')).toContain('（例: h3.x）');
    expect(ELEMENTIZING_CHIP_WARNING).toBe(CHIPS);
    expect(JINJA_ANCHOR_WARNING).toBe(ANCHORS);
  });

  it('数えた区切りが 0 なら CSS の欠けの警告を出さない(区切りの無いテンプレ)', () => {
    expect(pageWarnings(facts({ uncounted: 2, legacyKeys: 1 }))).toEqual([UNCOUNTED_2, LEGACY_1]);
  });

  it('CSS に指定があれば CSS の欠けの警告を出さない', () => {
    expect(pageWarnings(facts({ counted: 3, cssDefined: true }))).toEqual([]);
  });

  it('新しい 3 つの事実はそれぞれ単独でも 1 文ずつ出す', () => {
    expect(pageWarnings(facts({ cssRuleBreak: 'h2' }))).toEqual([CSS_RULE_H2]);
    expect(pageWarnings(facts({ elementizingChips: 3 }))).toEqual([CHIPS]);
    expect(pageWarnings(facts({ jinjaAnchors: 1 }))).toEqual([ANCHORS]);
  });

  it('何も無ければ空', () => {
    expect(pageWarnings(NONE)).toEqual([]);
  });
});

describe('pagebreakCssDefinedIn', () => {
  const RULE = '.pagebreak{page-break-after:always}';

  it('テンプレの CSS にあれば true', () => {
    expect(pagebreakCssDefinedIn(`body{margin:0}${RULE}`, [])).toBe(true);
  });

  it('本文の <style> のどれかにあれば true', () => {
    expect(pagebreakCssDefinedIn('body{margin:0}', ['p{color:red}', RULE])).toBe(true);
  });

  it('どちらにも無ければ false', () => {
    expect(pagebreakCssDefinedIn('body{margin:0}', ['p{color:red}'])).toBe(false);
    expect(pagebreakCssDefinedIn('', [])).toBe(false);
  });
});
