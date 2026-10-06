// =============================================================================
// pageMatch.test.ts — ページ対応(ずらし)指定の純粋ロジック
// =============================================================================
// 比較結果画面のページ対応は「行 r の offset」で保持しており、直接指定はその offset を
// 逆算して置く。数百ページ規模では番号を手入力するため、入力文字列の解釈(空・非数値・
// 範囲外)も同じ関数群で安全化する。ここは DOM 非依存の分岐だけを直接叩く。
import { describe, expect, it } from 'vitest';
import {
  alignWarningText,
  directOffset,
  layoutRows,
  parsePageIndex,
} from '@/features/compare/pageMatch';

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

describe('layoutRows', () => {
  it('ずらしていなければ max(ページ数) 行で、警告は無い', () => {
    const r = layoutRows([0, 0, 0], [0, 0, 0], 3, 3);
    expect(r.rowCount).toBe(3);
    expect(r.missing).toEqual({ before: [], after: [] });
    expect(r.duplicated).toEqual({ before: [], after: [] });
  });

  it('比較先を連動で 1 つ前へ: 末尾であふれたページの行を足し、二重のページを報告する', () => {
    const r = layoutRows([0, 0, 0, 0, 0], [0, 0, -1, -1, -1], 5, 5);
    expect(r.rowCount).toBe(6);
    expect(r.afterOff[5] + 5).toBe(4);
    expect(r.duplicated.after).toEqual([1]);
    expect(r.missing).toEqual({ before: [], after: [] });
  });

  it('比較先を連動で 1 つ後ろへ: 飛ばしたページを missing で返し、行は足さない', () => {
    const r = layoutRows([0, 0, 0, 0, 0], [0, 0, 1, 1, 1], 5, 5);
    expect(r.rowCount).toBe(5);
    expect(r.missing.after).toEqual([2]);
  });

  it('ずらしを戻して再計算すると、足した行は基準の行数へ戻る', () => {
    const grown = layoutRows([0, 0, 0, 0, 0], [0, 0, -1, -1, -1], 5, 5);
    expect(grown.rowCount).toBe(6);
    const back = layoutRows(grown.beforeOff, [0, 0, 0, 0, 0, 0], 5, 5);
    expect(back.rowCount).toBe(5);
    expect(back.beforeOff).toHaveLength(5);
    expect(back.afterOff).toHaveLength(5);
  });

  it('対応なし(directOffset(null))の行は行を増やさない', () => {
    const r = layoutRows([0, 0, 0], [0, directOffset(null, 1), 0], 3, 3);
    expect(r.rowCount).toBe(3);
    expect(r.missing.after).toEqual([1]);
  });

  it('ページ数が違う(3 と 5)ときも両側の全ページが載る', () => {
    const r = layoutRows([0], [0], 3, 5);
    expect(r.rowCount).toBe(5);
    expect(r.missing).toEqual({ before: [], after: [] });
  });

  it('配列より後ろの行は最後の offset を引き継ぐ', () => {
    const r = layoutRows([0], [-1], 3, 3);
    expect(r.rowCount).toBe(4);
    expect(r.afterOff).toEqual([-1, -1, -1, -1]);
    expect(r.missing).toEqual({ before: [], after: [] });
  });

  it('報告の再現: 比較元を行 1 から 1 つ前へずらし、行 1 の比較先を対応なしにしても P2 が出る', () => {
    const r = layoutRows([0, -1, -1], [0, directOffset(null, 1), 0], 3, 3);
    const shown = r.beforeOff.map((o, row) => row + o);
    expect(shown).toContain(2);
    expect(r.missing.before).toEqual([]);
  });

  it('ページ数 0 でも 1 行は残る', () => {
    const r = layoutRows([], [], 0, 0);
    expect(r.rowCount).toBe(1);
    expect(r.missing).toEqual({ before: [], after: [] });
  });
});

describe('alignWarningText', () => {
  const layout = (missing: [number[], number[]], duplicated: [number[], number[]]) => ({
    beforeOff: [],
    afterOff: [],
    rowCount: 0,
    missing: { before: missing[0], after: missing[1] },
    duplicated: { before: duplicated[0], after: duplicated[1] },
  });

  it('問題が無ければ null', () => {
    expect(alignWarningText(layout([[], []], [[], []]))).toBeNull();
  });

  it('出ないページは 1 起点で、側を「、」ページを「・」でつなぐ', () => {
    expect(alignWarningText(layout([[2], [6, 7]], [[], []]))).toBe(
      'どの行にも表示されていないページがあります: 比較元 3、比較先 7・8',
    );
  });

  it('該当の無い側は書かない', () => {
    expect(alignWarningText(layout([[], [6, 7]], [[], []]))).toBe(
      'どの行にも表示されていないページがあります: 比較先 7・8',
    );
  });

  it('二重のページの文言', () => {
    expect(alignWarningText(layout([[], []], [[], [1]]))).toBe(
      '2 つ以上の行に表示されているページがあります: 比較先 2',
    );
  });

  it('両方あるときは " / " で 1 行につなぐ', () => {
    expect(alignWarningText(layout([[2], []], [[], [1]]))).toBe(
      'どの行にも表示されていないページがあります: 比較元 3 / 2 つ以上の行に表示されているページがあります: 比較先 2',
    );
  });

  it('1 側 10 件を超えたら「ほか N ページ」に縮める', () => {
    const pages = Array.from({ length: 13 }, (_, i) => i);
    expect(alignWarningText(layout([pages, []], [[], []]))).toBe(
      'どの行にも表示されていないページがあります: 比較元 1・2・3・4・5・6・7・8・9・10 ほか 3 ページ',
    );
  });
});
