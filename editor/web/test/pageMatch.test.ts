// =============================================================================
// pageMatch.test.ts — ページ対応(ずらし)指定の純粋ロジック
// =============================================================================
// 比較結果画面のページ対応は「行 r の offset」で保持しており、直接指定はその offset を
// 逆算して置く。数百ページ規模では番号を手入力するため、入力文字列の解釈(空・非数値・
// 範囲外)も同じ関数群で安全化する。ここは DOM 非依存の分岐だけを直接叩く。
import { describe, expect, it } from 'vitest';
import { directOffset, parsePageIndex } from '@/features/compare/pageMatch';

describe('directOffset', () => {
  it('指定ページ index になる offset を返す(行 index との差)', () => {
    expect(directOffset(0, 0)).toBe(0);
    expect(directOffset(5, 3)).toBe(2);
    expect(directOffset(3, 5)).toBe(-2);
  });

  it('対応なし(null)は確実に範囲外(idx = -1)になる offset を返す', () => {
    for (const row of [0, 1, 7, 339]) {
      expect(row + directOffset(null, row)).toBe(-1);
    }
  });
});

describe('parsePageIndex', () => {
  it('1 起点の入力を 0 起点 index へ写す', () => {
    expect(parsePageIndex('1', 340)).toBe(0);
    expect(parsePageIndex('12', 340)).toBe(11);
    expect(parsePageIndex(' 340 ', 340)).toBe(339);
  });

  it('範囲外は端へクランプする(数百ページの打ち間違いを弾かず丸める)', () => {
    expect(parsePageIndex('0', 340)).toBe(0);
    expect(parsePageIndex('-8', 340)).toBe(0);
    expect(parsePageIndex('999', 340)).toBe(339);
  });

  it('空・非数値は null(無効 = 呼び出し側が元値へ戻す)', () => {
    expect(parsePageIndex('', 340)).toBeNull();
    expect(parsePageIndex('   ', 340)).toBeNull();
    expect(parsePageIndex('abc', 340)).toBeNull();
    expect(parsePageIndex('1e', 340)).toBeNull();
  });

  it('小数は四捨五入する(clampPage と同じ丸め)', () => {
    expect(parsePageIndex('3.2', 340)).toBe(2);
    expect(parsePageIndex('3.7', 340)).toBe(3);
  });

  it('ページ数 0 の側でも 0 起点 index は 0 へ収まる', () => {
    expect(parsePageIndex('5', 0)).toBe(0);
  });
});
