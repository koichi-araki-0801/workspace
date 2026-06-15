// =============================================================================
// config.ts — レイアウト/描画パラメータ集約 (graph/config.js の TS 移植)
// -----------------------------------------------------------------------------
// 1 viewBox unit = 1px 固定。pie 直径は `pieHeightRatio` × `svgHeightPx`(高さの 70% 固定)で、
// 半径は `fontSize` 非依存。上下余白 `marginCapPx` は (svgHeightPx - 直径)/2 で逆算する。
// pie は常にキャンバス中央 (xScale(x)=svgWidthPx/2 + x·unitScale) なので、視覚的な横余白は
// (svgWidthPx - 直径)/2 として半径とキャンバスから自動で決まる。`marginCapHorizontal` はラベルの
// 端マージン(縦と一様=`marginCapPx`)で、ラベル可動域(`canvasXlim`)のみを決める。
// =============================================================================

import type { PieLayoutConfig } from "./types.js";

const PT_PER_MM = 1 / 0.352778; // ≈ 2.83465 pt/mm

// ウェイト → 埋め込みフォント。BIZ UDPGothic は実在する 400/700 の 2 ウェイトのみ。
// `fontWeight` だけ override すれば `embedFontPath` 既定がこの表から自動で切り替わる
// (override で `embedFontPath` を明示した場合はそちらを優先)。gen_glyph_advance.ts の
// WEIGHT_FONT と一致させること。
const WEIGHT_FONT: Record<string, string> = {
  "400": "./fonts/BIZUDPGothic-Regular.woff2",
  "700": "./fonts/BIZUDPGothic-Bold.woff2",
};

/**
 * 円グラフ用設定オブジェクトを生成する。
 * `overrides` で base 値を差し替えれば、外部から個別パラメータだけ調整可能。
 */
export function createPieLayoutConfig(overrides: Partial<PieLayoutConfig> = {}): PieLayoutConfig {
  // baselineFontSize は派生スケールの基準。fontSize 変更時の連動係数として使う。
  const base = {
    baselineFontSize: 20,

    svgWidthPx: 600,
    svgHeightPx: 450,

    pieRadius: 1.0,
    pieHeightRatio: 0.7, // pie 直径が `svgHeightPx` に占める割合 (= 半径が高さ半分の 70%)
    labelRadius: 1.19,
    startangle: 90.0,
    counterclock: false,
    backgroundColor: "#ffffff",

    fontSize: 40,
    fontFamily: '"BIZ UDPGothic", "BIZ UDGothic", "Noto Sans JP", "Yu Gothic", "Meiryo", sans-serif',
    fontWeight: "400",
    // 字画を太らせる faux-bold。塗りと同色の stroke を text に載せ、font-size に対する比率で
    // 太さを足す (0=無効/純フォント, 0.015 前後で擬似500相当)。advance は不変。
    textWeightStrokeRatio: 0,
    embedFont: true,
    embedFontPath: "./fonts/BIZUDPGothic-Regular.woff2",
    embedFontFamilyName: "BIZ UDPGothic",
    percentFormat: (value: number) =>
      value < 0 ? `△${(-value).toFixed(1)}%` : `${value.toFixed(1)}%`,
    lineSpacing: 1.1,
    textColor: "#111111",
    lineColor: "#6a6a6a",
    lineWidth: 1.4,

    textRenderScale: 0.68,
    leaderRenderScale: 0.72,
    labelRadiusRenderScale: 0.88,
    denseSideOutsideRadiusFactor: 1.12,
    radialExitRenderScale: 0.82,
    radialExitLen: 0.1,

    yTop: 1.18,
    yBottom: -1.18,
    minGap: 0.16,
    minGapMultiline: 0.25,
    minGapDense: 0.21,
    minGapUltraDense: 0.19,

    smallSliceThreshold: 6.0,
    tinySliceThreshold: 4.0,
    topZoneDeg: 38.0,
    bottomZoneDeg: 28.0,

    denseCountThreshold: 9,
    ultraDenseCountThreshold: 11,
    oneSideDenseThreshold: 6,
    oneSideVeryDenseThreshold: 7,
    topSmallDenseThreshold: 2,
    topTinyDenseThreshold: 2,

    longLabelLen: 7,
    veryLongLabelLen: 10,
    longLabelDenseThreshold: 3,
    lowerDiffSmallThreshold: 1.5,

    compactLabel: false,

    insideSliceEnabled: true,
    insideSliceClearance: 0.04,
    insideSliceAngularClearanceDeg: 3,
    pieLabelClearance: 0.05,
    darkSliceTextColor: "#ffffff",
    darkSliceFillIndexMin: 2,

    grayScale4: ["#d1d2d4", "#a7a9ab", "#808284", "#57585a"],

    charWidthFactor: 1.0,
    lineHeightFactor: 1.1,
    visualFullwidthEm: 1.0,
    visualHalfwidthEm: 0.5,
    nameCondenseSteps: [0.7],

    ...overrides,
  };

  // `embedFontPath` を override で明示していなければ、`fontWeight` に対応するフォントを既定にする。
  // これで `fontWeight` だけ切り替えれば対応フォント (400=Regular / 700=Bold) が自動で選ばれる。
  if (overrides.embedFontPath === undefined && WEIGHT_FONT[base.fontWeight]) {
    base.embedFontPath = WEIGHT_FONT[base.fontWeight];
  }

  return {
    ...base,
    get fontScale(): number {
      return this.fontSize / this.baselineFontSize;
    },
    get geometryScale(): number {
      return Math.max(0.82, 1.0 + (this.fontScale - 1.0) * 0.25);
    },
    get gapScale(): number {
      return Math.max(0.8, 1.0 + (this.fontScale - 1.0) * 0.35);
    },

    get svgUnitsPerMm(): number {
      return PT_PER_MM;
    },
    get fontSizeUnits(): number {
      return this.fontSize * this.textRenderScale;
    },
    get lineHeightPx(): number {
      return this.fontSizeUnits * this.lineSpacing;
    },
    get marginCapPx(): number {
      // 上下余白は固定半径から逆算する (`pieDiameterPx` は `marginCapPx` を参照しないので循環しない)。
      return (this.svgHeightPx - this.pieDiameterPx) / 2;
    },
    get marginCapHorizontalPx(): number {
      // ラベルがキャンバス端に触れないための端マージン(縦余白 `marginCapPx` と一様=60px)。
      // pie の視覚的な横余白((幅−直径)/2)は中央配置+半径から自動で決まり、この値に依存しない
      // (xScale(x)=svgWidthPx/2 + x·unitScale)。この値はラベルの可動域(`canvasXlim`)のみを決める。
      return this.marginCapPx;
    },
    get pieDiameterPx(): number {
      // 半径を高さの 70% に固定 (直径 = `pieHeightRatio` × `svgHeightPx`)。`fontSize` 非依存。
      const diameter = this.pieHeightRatio * this.svgHeightPx;
      if (diameter <= 0 || diameter > this.svgWidthPx) {
        throw new Error(
          `pieDiameterPx out of range (got ${diameter.toFixed(2)}); ` +
            `pieHeightRatio=${this.pieHeightRatio} は (0,1] かつ svgWidthPx=${this.svgWidthPx} 以内である必要があります。`,
        );
      }
      return diameter;
    },
    get pieRadiusPx(): number {
      return this.pieDiameterPx / 2;
    },
    get pxPerUnit(): number {
      return this.pieRadiusPx / this.pieRadius;
    },

    get mmPerUnit(): number {
      return this.pxPerUnit / PT_PER_MM;
    },
    get fontSizeMm(): number {
      return this.fontSize * 0.352778;
    },

    get canvasYlim(): [number, number] {
      const halfHeightLogical = this.svgHeightPx / 2 / this.pxPerUnit;
      return [-halfHeightLogical, halfHeightLogical];
    },
    get canvasXlim(): [number, number] {
      const halfWidthPt = this.svgWidthPx / 2 - this.marginCapHorizontalPx;
      if (halfWidthPt <= 0) {
        throw new Error(
          `canvasXlim half-width must be positive (got ${halfWidthPt.toFixed(2)}); fontSize=${this.fontSize} is too large for svgWidthPx=${this.svgWidthPx}.`,
        );
      }
      const halfWidthLogical = halfWidthPt / this.pxPerUnit;
      return [-halfWidthLogical, halfWidthLogical];
    },

    get scaledXlim(): [number, number] {
      return this.canvasXlim;
    },
    get scaledYTop(): number {
      return this.canvasYlim[1];
    },
    get scaledYBottom(): number {
      return this.canvasYlim[0];
    },

    get scaledLabelRadius(): number {
      return this.labelRadius + 0.1 * (this.fontScale - 1.0);
    },
    get renderLabelRadius(): number {
      return this.scaledLabelRadius * this.labelRadiusRenderScale;
    },
    get scaledRadialExitLen(): number {
      return this.radialExitLen * Math.max(0.85, 1.0 + (this.fontScale - 1.0) * 0.2);
    },
    get renderRadialExitLen(): number {
      return this.scaledRadialExitLen * this.radialExitRenderScale;
    },
    get scaledMinGap(): number {
      return this.minGap * this.gapScale;
    },
    get scaledMinGapMultiline(): number {
      return this.minGapMultiline * this.gapScale;
    },
    get scaledMinGapDense(): number {
      return this.minGapDense * this.gapScale;
    },
    get scaledMinGapUltraDense(): number {
      return this.minGapUltraDense * this.gapScale;
    },

    get fixedSvgWidthUnits(): number {
      return this.svgWidthPx;
    },
    get fixedSvgHeightUnits(): number {
      return this.svgHeightPx;
    },
    get fixedSvgWidthMm(): number {
      return this.svgWidthPx / PT_PER_MM;
    },
    get fixedSvgHeightMm(): number {
      return this.svgHeightPx / PT_PER_MM;
    },

    get leaderStrokeUnits(): number {
      return this.lineWidth * this.leaderRenderScale;
    },

    get canvasSafetyMargin(): number {
      return Math.max(0.005, this.scaledRadialExitLen * 0.04);
    },
    get cornerGap(): number {
      return Math.max(0.02, this.scaledRadialExitLen * 0.18);
    },
    get rightNaturalYOffset(): number {
      return 0.25 * this.gapScale;
    },
    get lowerLeftNaturalYNudge(): number {
      return 0.1 * this.gapScale;
    },
    get leftInitTopInset(): number {
      return 0.15 * this.gapScale;
    },
    get bottomSpecialY(): number {
      return -0.82 * this.geometryScale;
    },
    get lowerBandYThreshold(): number {
      return -0.55 * this.geometryScale;
    },
    get flipHorizontalCap(): number {
      return 0.18 * this.geometryScale;
    },
    get flipPieClearance(): number {
      return 0.12 * this.gapScale;
    },
    get singleSliceLabelOffset(): number {
      return 0.22 * this.geometryScale;
    },
  } as PieLayoutConfig;
}

/**
 * スライス数に応じた色配列を返す。1 スライス時は最も淡い色のみ。それ以外は
 * `grayScale4` を循環し、先頭と末尾が同色になる場合だけ末尾を `base[1]` にずらす
 * (隣接が同じグレーで境界が消えるのを避けるため)。
 */
export function makeColors(count: number, cfg: PieLayoutConfig): string[] {
  if (count <= 0) {
    return [];
  }

  const base = [...cfg.grayScale4];
  if (count === 1) {
    return [base[0]];
  }

  const colors = Array.from({ length: count }, (_, index) => base[index % base.length]);
  if (base.length >= 2 && colors[colors.length - 1] === colors[0]) {
    colors[colors.length - 1] = base[1];
  }
  return colors;
}
