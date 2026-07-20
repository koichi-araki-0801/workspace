// =============================================================================
// emit_passes.test.ts — EMIT_REPAIR_PASSES の列 (emit / scoring) の特性テスト
// =============================================================================
// `applyEmitRepairPasses` (emit 列) と `finalizeForScoring` (採点列) は同一テーブル
// `EMIT_REPAIR_PASSES` から生成される。パス列は順序依存 (前段の解消が後段を no-op に
// する / 後段が前段の前提に乗る) なので、名前列をインライン期待値で固定し、エントリの
// 挿入・並べ替え・stage 変更を意図的な変更としてレビューに乗せる。
// =============================================================================

import { describe, expect, it } from 'vitest';
import { EMIT_REPAIR_PASSES } from '../src/svg_export/index.js';

describe('EMIT_REPAIR_PASSES の列', () => {
  it('emit 列 (stage=emit/both) の名前と順序', () => {
    const emit = EMIT_REPAIR_PASSES.filter((p) => p.stage !== 'scoring').map((p) => p.name);
    expect(emit).toEqual([
      'visualViewBoxNudge',
      'finalCondenseToFit',
      'relaxNameCondense',
      'outsideLeaderAngularOrder',
      'reorderTopBandLeftCluster',
      'escapeUpperLeftTinyLeaders',
      'escapeTopBandSeamLeader.thorough',
      'reorderLeftStackWithCondense',
      'separateLeftColumnByHeight',
      'repairResidualLeaderDefects',
      'enforceFinalPieClearance',
      'verticalDeclipFallback',
      'lowerLeftDropFallback',
      'twoLineNameFallback',
      'relieveOutsideColumnOverlap',
      'pullOutsideOverflowTowardPie',
      'relaxStructuralCondense',
      'relieveLeaderNeighborContact',
      'relieveLeftStackSpacing',
      'relaxStructuralCondense.afterLeftStackShift',
      'unsqueezeCondensedByShiftTowardPie',
      'tidyTopRightEscapeeStack',
    ]);
  });

  it('採点列 (stage=both/scoring) の名前と順序', () => {
    const scoring = EMIT_REPAIR_PASSES.filter(
      (p) => p.stage === 'both' || p.stage === 'scoring',
    ).map((p) => p.name);
    expect(scoring).toEqual([
      'visualViewBoxNudge',
      'finalCondenseToFit',
      'relaxNameCondense',
      'outsideLeaderAngularOrder',
      'escapeUpperLeftTinyLeaders',
      'escapeTopBandSeamLeader.thorough',
      'stackTopRightLiftedLabels',
      'reorderLeftStackWithCondense',
      'separateLeftColumnByHeight',
    ]);
  });

  it('名前は一意 (デバッグ指定 PIE_CHART_STOP_AFTER_PASS の前提)', () => {
    const names = EMIT_REPAIR_PASSES.map((p) => p.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('scoringRun を持つのは stage=both のエントリのみ', () => {
    for (const p of EMIT_REPAIR_PASSES) {
      if (p.scoringRun) expect(p.stage, `${p.name} の stage`).toBe('both');
    }
  });
});
