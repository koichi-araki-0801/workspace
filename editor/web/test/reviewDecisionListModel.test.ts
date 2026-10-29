// =============================================================================
// reviewDecisionListModel.test.ts — 右欄「変更と判定」の表示窓と理由の検査(純関数)
// =============================================================================
import { MAX_PART_REJECT_REASON_CHARS } from '@editor/shared';
import { describe, expect, it } from 'vitest';
import {
  clampWindow,
  growDown,
  growUp,
  initialWindow,
  REJECT_REASON_MAX,
  ROW_HEIGHT_ESTIMATE,
  ROW_STEP,
  ROW_WINDOW_MAX,
  reasonLength,
  rejectReasonProblem,
  scrollDelta,
  windowAround,
} from '@/features/reviews/reviewDecisionList';

describe('reviewDecisionList', () => {
  it('定数は brief の値', () => {
    expect([ROW_STEP, ROW_WINDOW_MAX, ROW_HEIGHT_ESTIMATE]).toEqual([50, 150, 96]);
  });

  it('初めは先頭の 50 行。全件が少なければ全件', () => {
    expect(initialWindow(1000)).toEqual({ start: 0, end: 50 });
    expect(initialWindow(7)).toEqual({ start: 0, end: 7 });
    expect(initialWindow(0)).toEqual({ start: 0, end: 0 });
  });

  it('下へ広げると 50 行足し、150 行を超えた分を上から外す', () => {
    expect(growDown({ start: 0, end: 50 }, 1000)).toEqual({
      next: { start: 0, end: 100 },
      droppedTop: 0,
    });
    expect(growDown({ start: 0, end: 150 }, 1000)).toEqual({
      next: { start: 50, end: 200 },
      droppedTop: 50,
    });
    // 末尾で止まる
    expect(growDown({ start: 0, end: 120 }, 130)).toEqual({
      next: { start: 0, end: 130 },
      droppedTop: 0,
    });
    expect(growDown({ start: 0, end: 130 }, 130).next).toEqual({ start: 0, end: 130 });
    // 境界: 150 件は上から外さず、151 件は 1 行だけ外す
    expect(growDown({ start: 0, end: 100 }, 150)).toEqual({
      next: { start: 0, end: 150 },
      droppedTop: 0,
    });
    expect(growDown({ start: 0, end: 150 }, 151)).toEqual({
      next: { start: 1, end: 151 },
      droppedTop: 1,
    });
  });

  it('上へ広げると 50 行戻し、150 行を超えた分を下から外す。先頭で止まる', () => {
    expect(growUp({ start: 100, end: 250 })).toEqual({
      next: { start: 50, end: 200 },
      addedTop: 50,
    });
    expect(growUp({ start: 20, end: 100 })).toEqual({
      next: { start: 0, end: 100 },
      addedTop: 20,
    });
    expect(growUp({ start: 0, end: 50 })).toEqual({
      next: { start: 0, end: 50 },
      addedTop: 0,
    });
  });

  it('windowAround は [i-50, i+50) を全件の範囲に収める', () => {
    expect(windowAround(799, 1000)).toEqual({ start: 749, end: 849 });
    expect(windowAround(3, 1000)).toEqual({ start: 0, end: 53 });
    expect(windowAround(990, 1000)).toEqual({ start: 940, end: 1000 });
  });

  it('clampWindow は全件の変化に窓を合わせる', () => {
    expect(clampWindow({ start: 0, end: 0 }, 80)).toEqual({ start: 0, end: 50 });
    expect(clampWindow({ start: 100, end: 200 }, 120)).toEqual({ start: 70, end: 120 });
    expect(clampWindow({ start: 0, end: 50 }, 10)).toEqual({ start: 0, end: 10 });
    expect(clampWindow({ start: 50, end: 150 }, 1000)).toEqual({ start: 50, end: 150 });
    expect(clampWindow({ start: 50, end: 150 }, 0)).toEqual({ start: 0, end: 0 });
  });

  it('scrollDelta は実際の高さの合計 − 見込み高 × 行数', () => {
    // 行が見込みより高い: 上へ足すと内容が下へ押されるので、その分だけ scrollTop を足す
    expect(scrollDelta([120, 120, 120])).toBe(3 * 120 - 3 * 96);
    // 行が見込みより低い: 負になる
    expect(scrollDelta([40, 60])).toBe(100 - 192);
    expect(scrollDelta([])).toBe(0);
    expect(scrollDelta([10, 20], 5)).toBe(20);
    // 小数の高さの端数を落とさない(50 行 × 0.5px が 25px のずれになった)
    expect(scrollDelta(Array(50).fill(92.5))).toBe(50 * 92.5 - 50 * 96);
  });

  it('却下の理由は空白だけなら empty、2000 単位を超えたら tooLong', () => {
    expect(REJECT_REASON_MAX).toBe(2000);
    expect(REJECT_REASON_MAX).toBe(MAX_PART_REJECT_REASON_CHARS);
    expect(rejectReasonProblem('')).toBe('empty');
    expect(rejectReasonProblem(' \n ')).toBe('empty');
    expect(rejectReasonProblem('あ'.repeat(2000))).toBeNull();
    expect(rejectReasonProblem('あ'.repeat(2001))).toBe('tooLong');
    // 画面は前後の空白を除いて送るので、長さも除いたあとで数える(サーバが受ける長さと同じ)
    expect(rejectReasonProblem(`  ${'あ'.repeat(2000)}\n`)).toBeNull();
    expect(reasonLength(`  ${'あ'.repeat(3)}\n`)).toBe(3);
    // サロゲートペアは 2 単位で数える(コードポイントでは数えない)
    expect(rejectReasonProblem('😀'.repeat(1001))).toBe('tooLong');
  });
});
