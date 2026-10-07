// =============================================================================
// cssCarry.test.ts — 入れ子の @font-face を原文のまま取り出す
// =============================================================================
// GrapesJS は `@media` / `@supports` の中の `@font-face` を崩すので、その規則だけを外側の前置きで
// 包み直して取り出す。文字列・コメントの中の `@font-face` や括弧には騙されない。
import { describe, expect, it } from 'vitest';
import { splitNestedFontFaces } from '@/lib/cssCarry';

describe('splitNestedFontFaces', () => {
  it('入れ子の @font-face が無ければそのまま返す', () => {
    const css = '@font-face{font-family:T}.a{x:1}@media print{.b{y:2}}';
    expect(splitNestedFontFaces(css)).toEqual({ rest: css, carried: [] });
  });

  it('@media の中の @font-face だけを外側の前置きで包み直して取り出し、ほかの規則は残す', () => {
    expect(
      splitNestedFontFaces(
        '@media print{@font-face{font-family:F;src:url(fonts/f.woff2)}.p{color:red}}.a{x:1}',
      ),
    ).toEqual({
      rest: '@media print{.p{color:red}}.a{x:1}',
      carried: ['@media print{@font-face{font-family:F;src:url(fonts/f.woff2)}}'],
    });
  });

  it('@supports と、入れ子の前置きの並びも原文のまま包み直す', () => {
    expect(
      splitNestedFontFaces('@media print{@supports (display:grid){@font-face{font-family:G}}}'),
    ).toEqual({
      rest: '@media print{@supports (display:grid){}}',
      carried: ['@media print{@supports (display:grid){@font-face{font-family:G}}}'],
    });
  });

  it('複数あれば出現順に取り出す', () => {
    const r = splitNestedFontFaces(
      '@media print{@font-face{font-family:A}}.x{}@supports (a:b){@font-face{font-family:B}}',
    );
    expect(r.carried).toEqual([
      '@media print{@font-face{font-family:A}}',
      '@supports (a:b){@font-face{font-family:B}}',
    ]);
    expect(r.rest).toBe('@media print{}.x{}@supports (a:b){}');
  });

  it('文字列・コメントの中の @font-face と括弧には騙されない', () => {
    const css = '@media print{.a{content:"@font-face{"}/* @font-face{} */}';
    expect(splitNestedFontFaces(css)).toEqual({ rest: css, carried: [] });
  });

  it('前置きの手前のコメントは残し、エスケープした at-rule 名も読む', () => {
    expect(splitNestedFontFaces('@\\6d edia print{/* c */@font-face{font-family:F}}')).toEqual({
      rest: '@\\6d edia print{/* c */}',
      carried: ['@\\6d edia print{@font-face{font-family:F}}'],
    });
  });

  it('@media / @supports 以外に包まれた @font-face と、セレクタの中の @font-face は取り出さない', () => {
    for (const css of ['@layer x{@font-face{font-family:L}}', '.a{@font-face{font-family:N}}']) {
      expect(splitNestedFontFaces(css)).toEqual({ rest: css, carried: [] });
    }
  });

  it('閉じていない @font-face は取り出さない(範囲が決まらない)', () => {
    const css = '@media print{@font-face{font-family:F';
    expect(splitNestedFontFaces(css)).toEqual({ rest: css, carried: [] });
  });

  it('@font-face が閉じていれば、外側が閉じていなくても取り出す', () => {
    expect(splitNestedFontFaces('@media print{@font-face{font-family:F}')).toEqual({
      rest: '@media print{',
      carried: ['@media print{@font-face{font-family:F}}'],
    });
  });

  it('前置きと @font-face の間に別の宣言がある文の @ は at-rule の頭として扱わない', () => {
    const css = '@media print{.a{b:c}x @font-face{font-family:F}}';
    expect(splitNestedFontFaces(css)).toEqual({ rest: css, carried: [] });
  });
});
