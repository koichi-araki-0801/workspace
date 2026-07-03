// =============================================================================
// seam_snapshot.test.ts — seamSnapshot/seamRestore の round-trip と分類表の整合
// =============================================================================
// seam 系パス (reorderTopBandLeftClusterByAngle / repairResidualLeaderDefects 等) の
// 「悪化したら全 revert」は seamSnapshot の保存フィールドが完全であることに依存する。
//   1. 分類表との一致: `index.ts` の `PLACEMENT_SEAM_POLICY` (Placement 全フィールドの
//      コンパイル時網羅表) で 'snapshot' に分類されたキー集合と、実際に seamSnapshot が
//      保存するキー集合が一致すること。Placement へのフィールド追加は tsc が分類を強制し、
//      分類と実装のズレは本テストが検知する。
//   2. round-trip: 保存対象フィールドを全て変異させても seamRestore で元値へ完全に戻り、
//      placement オブジェクトの参照 identity が保たれること (`Object.assign` 復元の前提)。
// =============================================================================

import { describe, expect, it } from 'vitest';
import {
  PLACEMENT_SEAM_POLICY,
  seamRestore,
  seamSnapshot,
} from '../src/svg_export/index.js';
import type { Placement } from '../src/types.js';

/** round-trip 検証用の最小 placement (snapshot 対象フィールドへ既知の値を入れる)。 */
function makePlacement(): Placement {
  return {
    x: 1.5,
    y: -0.25,
    anchor: 'start',
    baseline: 'bottom',
    lines: ['米ドル', '54.3%'],
    item: { name: '米ドル', value: 54.3 },
    leaderAnchor: { x: 0.9, y: 0.4 },
    leaderBend: { x: 1.1, y: 0.5 },
    leaderEndpoint: { x: 1.4, y: 0.5 },
    leaderBendFollowsEndpointY: true,
    leaderBendFollowsEndpointX: false,
    maxTextX: 2.0,
    minTextX: undefined,
    maxTextY: 1.2,
    minTextY: -1.2,
    origTextX: 1.5,
    origTextY: -0.25,
    upperLeftHairpinCheck: false,
    skipLeader: false,
    insideSlice: false,
    dominantOutsideEdge: true,
    nameScaleX: 0.7,
    condenseNamePortionOnly: true,
    forceTopRight: false,
  };
}

describe('seamSnapshot / seamRestore', () => {
  it('snapshot キー集合が PLACEMENT_SEAM_POLICY の snapshot 分類と一致する', () => {
    const covered = Object.keys(seamSnapshot([makePlacement()])[0].v).sort();
    const declared = Object.entries(PLACEMENT_SEAM_POLICY)
      .filter(([, policy]) => policy === 'snapshot')
      .map(([key]) => key)
      .sort();
    expect(covered).toEqual(declared);
  });

  it('全 snapshot フィールドを変異させても restore で元値へ戻る (参照 identity 維持)', () => {
    const p = makePlacement();
    const original = structuredClone(p);
    const placements = [p];
    const snap = seamSnapshot(placements);

    // 保存対象を全て変異させる (lines は「新配列で置き換える」規約どおり差し替える)。
    p.x = 99;
    p.y = -99;
    p.anchor = 'end';
    p.baseline = 'top';
    p.lines = ['米ドル 54.3%'];
    p.leaderBend = { x: 0, y: 0 };
    p.leaderEndpoint = { x: 0, y: 0 };
    p.leaderBendFollowsEndpointY = false;
    p.leaderBendFollowsEndpointX = true;
    p.forceTopRight = true;
    p.dominantOutsideEdge = false;
    p.skipLeader = true;
    p.origTextX = 0;
    p.origTextY = 0;
    p.maxTextX = undefined;
    p.minTextX = -5;
    p.maxTextY = undefined;
    p.minTextY = undefined;
    p.nameScaleX = 1;
    p.condenseNamePortionOnly = false;

    seamRestore(snap);

    expect(placements[0]).toBe(p); // 参照 identity (別オブジェクトへの差し替えではない)
    for (const [key, policy] of Object.entries(PLACEMENT_SEAM_POLICY)) {
      if (policy !== 'snapshot') continue;
      expect((p as any)[key], `restore 後の ${key}`).toEqual((original as any)[key]);
    }
  });

  it('leaderBend / leaderEndpoint は値コピーで保存する (snapshot 後の in-place 変異が漏れない)', () => {
    const p = makePlacement();
    const snap = seamSnapshot([p]);
    // 座標オブジェクトを差し替えず in-place で書き換えても、restore で snapshot 時点の値へ戻ること。
    p.leaderBend.x = 123;
    p.leaderEndpoint.y = -123;
    seamRestore(snap);
    expect(p.leaderBend).toEqual({ x: 1.1, y: 0.5 });
    expect(p.leaderEndpoint).toEqual({ x: 1.4, y: 0.5 });
  });
});
