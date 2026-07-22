// =============================================================================
// mark_flags.test.ts — layout 段の特例マーカー発火対応表 (特性テスト)
// =============================================================================
// `layout/diagnostics.ts` の mark*** 系 (markTopBandSmallRight / markForcedTopSliverLeader /
// markBottomCenterBelow 等) と `deriveModeTags` は、特定サンプルの回帰対応が積層した
// ゲート付き特例で、byte-diff (SVG 出力) では「どのフラグがどのサンプルで動いたか」を
// 切り分けられない。本テストは samples.json 全件について layoutLabels 直後の
// {modeTags, 診断フラグ, item 単位マーカー} をスナップショットに固定し、layout 変更時の
// 発火表の変化を 1 サンプル単位で可視化する。
//
// スナップショットの更新は「発火表が変わる変更を意図的に行った」時だけ許される
// (`npx vitest run -u`)。リファクタで意図せず変わった場合は変更側を直すこと。
// =============================================================================

import { describe, expect, it } from 'vitest';
import { createPieLayoutConfig } from '../src/config.js';
import { resolveInputData, samples } from '../src/input/load.js';
import { layoutLabels } from '../src/layout/diagnostics.js';
import { normalizeAndSortItems } from '../src/svg_export/pipeline.js';
import type { Diagnostics, LayoutItemReady } from '../src/types.js';

// item 単位のマーカーフラグ (types.ts の LayoutItem 定義順)。true のものだけ表へ載せる。
const ITEM_FLAG_KEYS = [
  'flipToRight',
  'flipToLeft',
  'forceFlipToRight',
  'forceHorizontalLowerLeftDrop',
  'upperLeftSmallDense',
  'upperLeftLongDense',
  'upperLeftTriad',
  'useStackRimY',
  'preferOneLineCascade',
  'keepTwoLineLeftStack',
  'topRightRejected',
  'clusterTopBand',
  'clusterTopBandBottom',
  'topBandSmallRight',
  'bottomCenterBelow',
  'forceOutsideLeader',
  'lowerLeftDropLeader',
  'loneTopSliverLeader',
  'denseSideOutsidePush',
  'bisectedDominantCenter',
  'singleDominantInside',
  'bisectedSecondSliceNoLeader',
] as const;

// Diagnostics のブールフラグ (関数・カウント・finalScore を除く)。true のものだけ表へ載せる。
const DIAG_FLAG_KEYS = [
  'manyItems',
  'ultraDenseItems',
  'oneSideDense',
  'oneSideVeryDense',
  'topSmallDense',
  'topTinyDense',
  'longLabelDense',
  'lowerGapIsTight',
  'upperLeftLongDense',
  'upperRightLongDense',
  'leftStackMode',
  'twoLineLeftStackMode',
  'topBandClusterMode',
  'forceLowerLeftCompactBand',
  'keepUpperLeft2Lines',
  'allowTopBandThreeFlip',
  'upperLeftTriadEligible',
] as const;

interface SampleFlags {
  modeTags: string[];
  diag: string[];
  items: Record<string, string[]>;
}

/** 1 サンプルの発火表 (layoutLabels 直後・emit 前)。 */
function flagsOf(sampleName: string): SampleFlags {
  const entry = samples[sampleName];
  const items = normalizeAndSortItems(resolveInputData({ data: entry.items }));
  const cfg = createPieLayoutConfig({});
  const { labels, diagnostics } = layoutLabels(items, cfg);
  const itemFlags: Record<string, string[]> = {};
  for (const label of labels as LayoutItemReady[]) {
    const on = ITEM_FLAG_KEYS.filter((k) => (label as any)[k] === true);
    if (on.length > 0) itemFlags[label.name] = on;
  }
  return {
    modeTags: [...diagnostics.modeTags],
    diag: DIAG_FLAG_KEYS.filter((k) => (diagnostics as Diagnostics)[k] === true),
    items: itemFlags,
  };
}

describe('mark*** 系マーカーの発火対応表 (layoutLabels 直後)', () => {
  it('全サンプルの発火表がスナップショットと一致する', () => {
    const table: Record<string, SampleFlags> = {};
    for (const name of Object.keys(samples).sort()) {
      table[name] = flagsOf(name);
    }
    expect(table).toMatchSnapshot();
  });

  // コメントで経緯が語られる代表サンプルは、スナップショットとは別にインライン期待値で固定する
  // (`-u` での意図しない一括更新から守る)。期待値は現行実装の観測値 (特性テスト)。

  it('manulife_country: 1強+極小トップ2枚 → 極小に forceOutsideLeader (markForcedTopSliverLeader)', () => {
    const f = flagsOf('pdf_510037_04_manulife_country');
    const withLeader = Object.entries(f.items)
      .filter(([, on]) => on.includes('forceOutsideLeader'))
      .map(([name]) => name);
    expect(withLeader.length).toBeGreaterThan(0);
  });

  it('pdf_510037_02_world_bond_idx_currency: オフショア人民元に lowerLeftDropLeader (markClippedUpperLeftLongDrop)', () => {
    const f = flagsOf('pdf_510037_02_world_bond_idx_currency');
    const dropped = Object.entries(f.items)
      .filter(([, on]) => on.includes('lowerLeftDropLeader'))
      .map(([name]) => name);
    expect(dropped).toContain('オフショア人民元');
  });

  it('stress_top_cluster_8: leftStackMode が立つ', () => {
    expect(flagsOf('stress_top_cluster_8').diag).toContain('leftStackMode');
  });
});
