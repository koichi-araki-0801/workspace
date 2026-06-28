import { describe, expect, it } from 'vitest';
import { clampPage, fractionToPage, pageToFraction } from '@/components/pageNav';

// ページ送り UI(`PageNav.vue` / `PageRail.vue`)の純粋ロジックを DOM 非依存で検証する。
// すべて 1 起点。端・超過・小数・NaN・空(count<=0)の各分岐を直接叩く。

describe('clampPage', () => {
  it('範囲内はそのまま(小数は四捨五入)', () => {
    expect(clampPage(3, 400)).toBe(3);
    expect(clampPage(3.7, 400)).toBe(4);
    expect(clampPage(3.2, 400)).toBe(3);
  });

  it('1 未満は 1、超過は count に丸める', () => {
    expect(clampPage(0, 400)).toBe(1);
    expect(clampPage(-5, 400)).toBe(1);
    expect(clampPage(401, 400)).toBe(400);
  });

  it('count<=0 は 1(常に最低 1 ページ扱い)', () => {
    expect(clampPage(3, 0)).toBe(1);
    expect(clampPage(3, -2)).toBe(1);
  });

  it('NaN / Infinity(空入力や parse 失敗)は 1 へ安全化する', () => {
    expect(clampPage(Number.NaN, 400)).toBe(1);
    expect(clampPage(Number('abc'), 400)).toBe(1);
    expect(clampPage(Number.POSITIVE_INFINITY, 400)).toBe(1);
  });
});

describe('fractionToPage', () => {
  it('比率 0..1 を均等区間でページへ写像する', () => {
    expect(fractionToPage(0, 10)).toBe(1);
    expect(fractionToPage(0.05, 10)).toBe(1);
    expect(fractionToPage(0.15, 10)).toBe(2);
    expect(fractionToPage(0.95, 10)).toBe(10);
  });

  it('上端 1 は count、範囲外は端へクランプ', () => {
    expect(fractionToPage(1, 10)).toBe(10);
    expect(fractionToPage(1.5, 10)).toBe(10);
    expect(fractionToPage(-0.2, 10)).toBe(1);
  });

  it('count<=0 は 1', () => {
    expect(fractionToPage(0.5, 0)).toBe(1);
  });
});

describe('pageToFraction', () => {
  it('ページ区間の中央比率を返す(fractionToPage の逆)', () => {
    expect(pageToFraction(1, 10)).toBeCloseTo(0.05);
    expect(pageToFraction(10, 10)).toBeCloseTo(0.95);
  });

  it('範囲外ページは clamp してから中央比率にする', () => {
    expect(pageToFraction(0, 10)).toBeCloseTo(0.05);
    expect(pageToFraction(99, 10)).toBeCloseTo(0.95);
  });

  it('round-trip: 中央比率を fractionToPage に戻すと同じページ', () => {
    for (const p of [1, 2, 5, 9, 10]) {
      expect(fractionToPage(pageToFraction(p, 10), 10)).toBe(p);
    }
  });

  it('count<=0 は 0', () => {
    expect(pageToFraction(3, 0)).toBe(0);
  });
});
