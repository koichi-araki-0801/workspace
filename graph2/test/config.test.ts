import { describe, expect, it } from 'vitest';
import { createPieLayoutConfig, makeColors } from '../src/config.js';
import type { PieLayoutConfig } from '../src/types.js';

// 派生 getter を一通り触って評価させるためのキー一覧 (関数カバレッジ用)。
const DERIVED_KEYS: (keyof PieLayoutConfig)[] = [
  'fontScale',
  'geometryScale',
  'gapScale',
  'svgUnitsPerMm',
  'fontSizeUnits',
  'lineHeightPx',
  'marginCapPx',
  'marginCapHorizontalPx',
  'pieDiameterPx',
  'pieRadiusPx',
  'pxPerUnit',
  'mmPerUnit',
  'fontSizeMm',
  'canvasYlim',
  'canvasXlim',
  'scaledXlim',
  'scaledYTop',
  'scaledYBottom',
  'scaledLabelRadius',
  'renderLabelRadius',
  'scaledRadialExitLen',
  'renderRadialExitLen',
  'scaledMinGap',
  'scaledMinGapMultiline',
  'scaledMinGapDense',
  'scaledMinGapUltraDense',
  'fixedSvgWidthUnits',
  'fixedSvgHeightUnits',
  'fixedSvgWidthMm',
  'fixedSvgHeightMm',
  'leaderStrokeUnits',
  'canvasSafetyMargin',
  'cornerGap',
  'rightNaturalYOffset',
  'lowerLeftNaturalYNudge',
  'leftInitTopInset',
  'bottomSpecialY',
  'lowerBandYThreshold',
  'flipHorizontalCap',
  'flipPieClearance',
  'singleSliceLabelOffset',
];

describe('createPieLayoutConfig', () => {
  it('既定値を持つ', () => {
    const cfg = createPieLayoutConfig();
    expect(cfg.pieRadius).toBe(1.0);
    expect(cfg.startangle).toBe(90);
    expect(cfg.counterclock).toBe(false);
    expect(cfg.fontSize).toBe(40);
  });

  it('overrides で個別パラメータを差し替えられる', () => {
    const cfg = createPieLayoutConfig({ fontSize: 36, counterclock: true });
    expect(cfg.fontSize).toBe(36);
    expect(cfg.counterclock).toBe(true);
    expect(cfg.pieRadius).toBe(1.0); // 触っていない値は既定のまま
  });

  it('派生 getter がすべて有限値 / 形を返す', () => {
    const cfg = createPieLayoutConfig();
    for (const key of DERIVED_KEYS) {
      const v = cfg[key];
      if (Array.isArray(v)) {
        expect(v).toHaveLength(2);
        expect(Number.isFinite(v[0])).toBe(true);
        expect(Number.isFinite(v[1])).toBe(true);
      } else {
        expect(Number.isFinite(v as number)).toBe(true);
      }
    }
  });

  it('派生値の関係が整合する', () => {
    const cfg = createPieLayoutConfig();
    expect(cfg.fontScale).toBeCloseTo(40 / 20);
    expect(cfg.pieDiameterPx).toBeCloseTo(0.7 * 450);
    expect(cfg.pieRadiusPx).toBeCloseTo(cfg.pieDiameterPx / 2);
    expect(cfg.marginCapPx).toBeCloseTo((450 - cfg.pieDiameterPx) / 2);
    expect(cfg.canvasYlim[0]).toBeCloseTo(-cfg.canvasYlim[1]);
  });

  it('fontSize に応じてスケールが連動する', () => {
    const small = createPieLayoutConfig({ fontSize: 20 });
    const big = createPieLayoutConfig({ fontSize: 40 });
    expect(small.fontScale).toBeCloseTo(1);
    expect(big.fontScale).toBeGreaterThan(small.fontScale);
    expect(big.scaledRadialExitLen).toBeGreaterThan(small.scaledRadialExitLen);
  });

  it('pieHeightRatio が範囲外なら pieDiameterPx で投げる', () => {
    const bad = createPieLayoutConfig({ pieHeightRatio: 2.0 }); // 直径 900 > 幅 600
    expect(() => bad.pieDiameterPx).toThrow();
    const zero = createPieLayoutConfig({ pieHeightRatio: 0 });
    expect(() => zero.pieDiameterPx).toThrow();
  });

  it('canvasXlim は半幅が非正だと投げる', () => {
    // marginCapHorizontalPx = marginCapPx = (svgHeightPx - diameter)/2 を幅の半分以上にする
    const cfg = createPieLayoutConfig({ svgWidthPx: 200, svgHeightPx: 600, pieHeightRatio: 0.3 });
    // diameter = 180, marginCapPx = (600-180)/2 = 210, halfWidthPt = 100 - 210 < 0
    expect(() => cfg.canvasXlim).toThrow();
  });

  it('percentFormat は負値を △ 表記にする', () => {
    const cfg = createPieLayoutConfig();
    expect(cfg.percentFormat(12.3)).toBe('12.3%');
    expect(cfg.percentFormat(-4.5)).toBe('△4.5%');
  });
});

describe('makeColors', () => {
  const cfg = createPieLayoutConfig();
  it('0 以下は空配列', () => {
    expect(makeColors(0, cfg)).toEqual([]);
    expect(makeColors(-3, cfg)).toEqual([]);
  });
  it('1 スライスは最も淡い色のみ', () => {
    expect(makeColors(1, cfg)).toEqual([cfg.grayScale4[0]]);
  });
  it('件数ぶん grayScale4 を循環する', () => {
    const colors = makeColors(3, cfg);
    expect(colors).toEqual(cfg.grayScale4.slice(0, 3));
  });
  it('先頭と末尾が同色になる循環は末尾をずらす', () => {
    // grayScale4 は 4 色 → 5 件目は base[0] と同色になり、末尾を base[1] に差し替える
    const colors = makeColors(5, cfg);
    expect(colors).toHaveLength(5);
    expect(colors[4]).toBe(cfg.grayScale4[1]);
    expect(colors[4]).not.toBe(colors[0]);
  });
});
