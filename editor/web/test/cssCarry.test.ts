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

  it('空白・改行・コメントをはさんでも取り出し、残りの空白は原文のまま保つ', () => {
    expect(
      splitNestedFontFaces('@media print {\n  /* a */ \n\t@font-face{font-family:F}\n  .p{x:1}\n}'),
    ).toEqual({
      rest: '@media print {\n  /* a */ \n\t\n  .p{x:1}\n}',
      carried: ['@media print {@font-face{font-family:F}}'],
    });
  });

  it('同じ @media の中の @font-face 2 つは、出現順に個別に包み直す', () => {
    expect(
      splitNestedFontFaces(
        '@media print{@font-face{font-family:A}.m{x:1}@font-face{font-family:B}}.z{}',
      ),
    ).toEqual({
      rest: '@media print{.m{x:1}}.z{}',
      carried: [
        '@media print{@font-face{font-family:A}}',
        '@media print{@font-face{font-family:B}}',
      ],
    });
  });

  it('@MEDIA / @SUPPORTS / @FONT-FACE は大文字でも取り出す', () => {
    expect(splitNestedFontFaces('@MEDIA print{@FONT-FACE{font-family:F}}')).toEqual({
      rest: '@MEDIA print{}',
      carried: ['@MEDIA print{@FONT-FACE{font-family:F}}'],
    });
  });
});

// 文頭の判定のたびにコメントの添字を頭から数え直すと、コメントと at-rule が多い入力で二乗になる。
// 絶対時間の上限は負荷の高い CI で誤って落ちるので、入力 n と 4n の所要時間の比で主張する。線形なら
// 比は約 4(通常時の実測は 3.4〜4.1)、二乗なら理論上 16 で、旧実装の実測は約 38 だった。閾値 10 は、
// 線形の測定に負荷の揺れが 2.5 倍まで乗っても超えず、二乗は 16 を下回る揺れが乗らない限り超える。
// 測定は 3 回の最小値を採り、挙動の確認(expect)は測定と分けて先に行う。
describe('splitNestedFontFaces は入力サイズに対して線形', () => {
  const build = (n: number): string => '@media print{/* c */@font-face{font-family:F}}'.repeat(n);

  it('コメント付きの入れ子の @font-face を大量に並べても、すべて取り出す', () => {
    const r = splitNestedFontFaces(build(5000));
    expect(r.carried).toHaveLength(5000);
    expect(r.rest).toBe('@media print{/* c */}'.repeat(5000));
  });

  it('入力が 4 倍になっても所要時間は 10 倍を超えない', () => {
    const best = (n: number): number => {
      const css = build(n);
      let min = Number.POSITIVE_INFINITY;
      for (let k = 0; k < 3; k++) {
        const t0 = performance.now();
        splitNestedFontFaces(css);
        min = Math.min(min, performance.now() - t0);
      }
      return min;
    };
    best(2000);
    const small = best(10_000);
    const large = best(40_000);
    expect(large / Math.max(small, 1)).toBeLessThan(10);
  });
});
