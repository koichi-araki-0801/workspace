import { describe, expect, it } from 'vitest';
import {
  LEGACY_KEY_WARNING,
  PAGEBREAK_CSS_WARNING,
  pagebreakCssDefinedIn,
  pageWarnings,
  UNCOUNTED_BREAK_WARNING,
} from '@/features/editor/pageWarnings';

// 編集画面の警告欄に足す改ページの警告(設計 16.7 節)。文言と並び、出さない条件を固定する。

const UNCOUNTED_2 =
  '改ページとして数えていない指定が 2 か所あります（ページの一番外側にない ' +
  '<div class="pagebreak"> や、入れ子の要素の改ページ指定）。' +
  '編集画面のページ数がプレビューとずれることがあります';
const CSS_MISSING =
  'テンプレの CSS に .pagebreak の改ページ指定がありません。PDF は編集画面の区切りどおりに' +
  '改ページされません';
const LEGACY_1 = '古い形式のキーのメモ・修正履歴が 1 件あり、どのパーツにも表示していません';

describe('pageWarnings', () => {
  it('3 つの条件がそろえば設計どおりの 3 文をこの順で返す', () => {
    const out = pageWarnings({ uncounted: 2, counted: 3, cssDefined: false, legacyKeys: 1 });
    expect(out).toEqual([UNCOUNTED_2, CSS_MISSING, LEGACY_1]);
  });

  it('文言の定数は件数を差し込む前の形を持つ', () => {
    expect(UNCOUNTED_BREAK_WARNING(5)).toContain('5 か所');
    expect(PAGEBREAK_CSS_WARNING).toBe(CSS_MISSING);
    expect(LEGACY_KEY_WARNING(4)).toContain('4 件');
  });

  it('数えていない指定が 0 なら 1 文目を出さない', () => {
    expect(pageWarnings({ uncounted: 0, counted: 3, cssDefined: false, legacyKeys: 1 })).toEqual([
      CSS_MISSING,
      LEGACY_1,
    ]);
  });

  it('数えた区切りが 0 なら CSS の警告を出さない(区切りの無いテンプレ)', () => {
    expect(pageWarnings({ uncounted: 2, counted: 0, cssDefined: false, legacyKeys: 1 })).toEqual([
      UNCOUNTED_2,
      LEGACY_1,
    ]);
  });

  it('CSS に指定があれば 2 文目を出さない', () => {
    expect(pageWarnings({ uncounted: 2, counted: 3, cssDefined: true, legacyKeys: 1 })).toEqual([
      UNCOUNTED_2,
      LEGACY_1,
    ]);
  });

  it('古い形式のキーが 0 なら 3 文目を出さない', () => {
    expect(pageWarnings({ uncounted: 2, counted: 3, cssDefined: false, legacyKeys: 0 })).toEqual([
      UNCOUNTED_2,
      CSS_MISSING,
    ]);
  });

  it('何も無ければ空', () => {
    expect(pageWarnings({ uncounted: 0, counted: 0, cssDefined: false, legacyKeys: 0 })).toEqual(
      [],
    );
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
