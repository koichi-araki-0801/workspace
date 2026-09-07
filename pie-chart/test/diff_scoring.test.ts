// =============================================================================
// diff_scoring.test.ts — 差分採点が全走査と同値であることの固定
// =============================================================================
// 差分計算は「動いていない index の対判定を再利用する」ことなので、正しさは「全走査と同じ値を
// 返す」に尽きる。実配置の分布に依存しない性質なので、決定的な擬似乱数で作った配置を動かして
// 9 フィールドすべてを突き合わせる。`replaceLeaderGeometryAt` が `collectLeaderGeometry` と
// 同値であることも同時に固定する (この 2 つの一致は差分の前提で、これまで byte 比較だけが網だった)。
import { describe, expect, it } from 'vitest';
import { createPieLayoutConfig } from '../src/config.js';
import { layoutLabels } from '../src/layout/diagnostics.js';
import {
  measureRepairVec,
  measureRepairVecDelta,
  measureRepairVecFrom,
} from '../src/svg_export/emit_repair.js';
import {
  buildScoreBase,
  collectLeaderGeometry,
  replaceLeaderGeometryAt,
} from '../src/svg_export/leader_geometry.js';
import type { Coord } from '../src/svg_export/leader_geometry.js';
import { normalizeAndSortItems } from '../src/svg_export/pipeline.js';
import { createCoordinateSystem } from '../src/svg_export/rendering.js';
import type { PieLayoutConfig, Placement } from '../src/types.js';
import { syntheticCases } from './helpers/syntheticCases.js';

/** 決定的な擬似乱数 (seed 固定の線形合同法)。外部依存を足さないための最小実装。 */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/**
 * 採点対象の `Placement[]` を組み立てる。カスケード本体 (`pipeline.ts` の `runLabelCascade`) は
 * 非公開で、テストのために export を足すと本番の公開面が広がるため、公開 API の `layoutLabels`
 * が返す確定済みの配置座標 (`finalX`/`finalY`/`anchorX`/`anchorY`) から `Placement` を組む。
 * 差分採点の同値性は配置の由来に依存しない性質なので、実レイアウトそのものである必要はなく
 * 「leader と box が実在する現実的な分布」であれば足りる。
 */
function makePlacements(
  items: { name: string; value: number }[],
  cfg: PieLayoutConfig,
): { placements: Placement[]; coord: Coord } {
  const coord = createCoordinateSystem(cfg);
  const { labels } = layoutLabels(normalizeAndSortItems(items), cfg);
  const placements = labels.map((it): Placement => {
    const anchor = it.side === 'left' ? ('end' as const) : ('start' as const);
    return {
      x: it.finalX,
      y: it.finalY,
      anchor,
      baseline: 'middle',
      lines: it.textLines >= 2 ? [it.name, it.percentText] : [`${it.name} ${it.percentText}`],
      item: { name: it.name, value: it.value, percentText: it.percentText },
      leaderAnchor: { x: it.anchorX, y: it.anchorY },
      leaderBend: { x: it.anchorX, y: it.finalY },
      leaderEndpoint: { x: it.finalX, y: it.finalY },
      leaderBendFollowsEndpointY: false,
      leaderBendFollowsEndpointX: false,
      origTextX: it.finalX,
      origTextY: it.finalY,
      upperLeftHairpinCheck: false,
      skipLeader: false,
      insideSlice: false,
    };
  });
  return { placements, coord };
}

describe('差分採点は全走査と同値', () => {
  const cfg = createPieLayoutConfig({});
  const items = syntheticCases().gen_long_12_other;

  it('replaceLeaderGeometryAt は collectLeaderGeometry と同じ幾何を返す', () => {
    const { placements, coord } = makePlacements(items, cfg);
    const rnd = lcg(20260908);
    for (let t = 0; t < 20; t += 1) {
      const i = Math.floor(rnd() * placements.length);
      placements[i].x += (rnd() - 0.5) * 4;
      placements[i].y += (rnd() - 0.5) * 4;
      const base = collectLeaderGeometry(placements, cfg, coord);
      placements[i].leaderBend = { x: (rnd() - 0.5) * 10, y: (rnd() - 0.5) * 10 };
      expect(replaceLeaderGeometryAt(base, placements, cfg, coord, i)).toEqual(
        collectLeaderGeometry(placements, cfg, coord),
      );
    }
  });

  it('measureRepairVecDelta は全走査の measureRepairVec と 9 フィールドすべて一致する', () => {
    const { placements, coord } = makePlacements(items, cfg);
    const rnd = lcg(4242);
    for (let t = 0; t < 30; t += 1) {
      const base = buildScoreBase(placements, cfg, coord);
      const changed = [Math.floor(rnd() * placements.length)];
      if (rnd() < 0.3) changed.push(Math.floor(rnd() * placements.length));
      for (const i of changed) {
        placements[i].x += (rnd() - 0.5) * 6;
        placements[i].leaderBend = { x: (rnd() - 0.5) * 12, y: (rnd() - 0.5) * 12 };
      }
      // 参照側は被検側と幾何を共有させない。`replaceLeaderGeometryAt` の連鎖適用で組んだ
      // `geo` を両側へ渡すと、連鎖に誤りがあっても両側が同じだけ狂って一致してしまう。
      // `measureRepairVec` は `collectLeaderGeometry` から幾何を作り直すので独立な参照になる。
      expect(measureRepairVecDelta(base, placements, cfg, coord, changed)).toEqual(
        measureRepairVec(placements, cfg, coord),
      );
    }
  });

  it('同名スライスがあれば差分を使わず全走査へ落ちる', () => {
    const dup = [
      { name: '国内株式', value: 40 },
      { name: '国内株式', value: 35 },
      { name: '現金', value: 25 },
    ];
    const { placements, coord } = makePlacements(dup, cfg);
    const base = buildScoreBase(placements, cfg, coord);
    expect(base.usable).toBe(false);
    placements[0].leaderBend = { x: 3, y: 3 };
    const geo = replaceLeaderGeometryAt(base.geo, placements, cfg, coord, 0);
    expect(measureRepairVecDelta(base, placements, cfg, coord, [0])).toEqual(
      measureRepairVecFrom(placements, cfg, coord, geo),
    );
  });
});
