// =============================================================================
// svg_export/rendering.ts — 純粋な SVG 文字列プリミティブ
// -----------------------------------------------------------------------------
// 副作用ゼロ。座標変換 → スライス path → text 要素 → 視覚 em 推定 を 1 ファイルに集約。
//
// ファイル内構成:
//   1. coordinate system — createCoordinateSystem
//   2. slice path — buildSlicePath + computeArcs
//   3. text fragment + escapeXml
//   4. visual em estimation — detectVisualHorizontalOverflow (視覚 bbox はみ出し判定)
// =============================================================================

import {
  arcAngles,
  polarToCartesian,
  textBoxBounds,
  visualMaxEm,
  visualTextWidthUnits,
} from "../svg_geom.js";
import type { PieLayoutConfig, Scale, Placement, LayoutItem } from "../types.js";

// =============================================================================
// 1. coordinate system
// =============================================================================

export interface CoordSystem {
  width: number;
  height: number;
  unitScale: number;
  xScale: Scale;
  yScale: Scale;
}

/**
 * 論理座標 (円中心 (0,0)、x∈[xMin,xMax]、y∈[yMin,yMax]) を SVG ピクセル座標へ
 * 変換するスケーラを構築。パイ中心は常にキャンバス中央。
 */
export function createCoordinateSystem(cfg: PieLayoutConfig): CoordSystem {
  const width = Math.round(cfg.fixedSvgWidthUnits);
  const height = Math.round(cfg.fixedSvgHeightUnits);
  const [xMin, xMax] = cfg.scaledXlim;
  const [yMin, yMax] = cfg.canvasYlim;
  const domainWidth = xMax - xMin;
  const domainHeight = yMax - yMin;
  const plotHeight = height;
  const topMargin = 0;
  const unitScale = Math.min(width / domainWidth, plotHeight / domainHeight);
  const xOffset = (width - domainWidth * unitScale) / 2;
  const yOffset = topMargin + (plotHeight - domainHeight * unitScale) / 2;

  return {
    width,
    height,
    unitScale,
    xScale(value: number): number {
      return xOffset + (value - xMin) * unitScale;
    },
    yScale(value: number): number {
      // SVG は y が下向きなので反転して描画する
      return plotHeight + topMargin - yOffset - (value - yMin) * unitScale;
    },
  };
}

// =============================================================================
// 2. slice path
// =============================================================================

/**
 * スライス 1 枚分の path d 属性文字列を組み立てる。
 * 全周 (360°) のときだけセンターからの線を持たない 2 つの半円に分けて描く。
 */
export function buildSlicePath(
  startAngle: number,
  endAngle: number,
  radius: number,
  xScale: Scale,
  yScale: Scale,
): string {
  const r = Math.abs(xScale(radius) - xScale(0));
  const start = polarToCartesian(radius, startAngle);
  const sweepFlag = endAngle < startAngle ? 1 : 0;
  if (Math.abs(Math.abs(endAngle - startAngle) - 2 * Math.PI) < 1e-6) {
    const halfTurn = endAngle < startAngle ? -Math.PI : Math.PI;
    const mid = polarToCartesian(radius, startAngle + halfTurn);
    return [
      `M${xScale(start.x)},${yScale(start.y)}`,
      `A${r},${r} 0 1 ${sweepFlag} ${xScale(mid.x)},${yScale(mid.y)}`,
      `A${r},${r} 0 1 ${sweepFlag} ${xScale(start.x)},${yScale(start.y)}`,
      "Z",
    ].join(" ");
  }
  const largeArcFlag = Math.abs(endAngle - startAngle) > Math.PI ? 1 : 0;
  const end = polarToCartesian(radius, endAngle);
  return [
    `M${xScale(0)},${yScale(0)}`,
    `L${xScale(start.x)},${yScale(start.y)}`,
    `A${r},${r} 0 ${largeArcFlag} ${sweepFlag} ${xScale(end.x)},${yScale(end.y)}`,
    "Z",
  ].join(" ");
}

/** computeArcs の戻り値: LayoutItem に弧の開始/終了角 (rad) を付与したもの。 */
export type Arc = LayoutItem & { startAngle: number; endAngle: number };

/** 各スライスに startAngle / endAngle (rad) を付与する */
export function computeArcs(items: LayoutItem[], cfg: PieLayoutConfig): Arc[] {
  const angles = arcAngles(
    items.map((item) => Number(item.value)),
    cfg,
  );
  return items.map((item, index) => ({
    ...item,
    startAngle: angles[index].startAngle,
    endAngle: angles[index].endAngle,
  }));
}

// =============================================================================
// 3. text fragment + escapeXml
// =============================================================================

/** SVG 属性に安全に埋め込めるよう XML 特殊文字をエスケープ。 */
export function escapeXml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/**
 * 名前(長体)圧縮の指定。textFragment に渡すと名前部分のみ横圧縮する。
 * - name: 圧縮する名前文字列 (2 行時は上行 = lines[0] と一致)
 * - rest: 1 行レイアウト時に名前の後ろへ原寸で続ける部分 (例 " 25%")。2 行時は未使用。
 * - nameScaleX: 横圧縮率 (<1)。1 以上なら圧縮なし扱い。
 */
export interface CondenseSpec {
  nameScaleX: number;
  name: string;
  rest: string;
}

/**
 * <text> 1 つを組み立てる。複数行のときは <tspan> で改行を表現。
 * baseline は SVG の dominant-baseline 用文字列に変換する。
 * condense 指定時は名前部分のみ textLength+lengthAdjust="spacingAndGlyphs" で
 * 横方向に圧縮 (長体)。高さは不変、% 部分は原寸。
 */
export function textFragment(
  xScale: Scale,
  yScale: Scale,
  x: number,
  y: number,
  lines: string[],
  options: { anchor: string; baseline: string },
  cfg: PieLayoutConfig,
  condense?: CondenseSpec,
): string {
  const baseline =
    options.baseline === "bottom"
      ? "text-before-edge"
      : options.baseline === "top"
        ? "text-after-edge"
        : "middle";
  const n = lines.length;
  let firstDy = "0em";
  if (n > 1) {
    if (options.baseline === "top") {
      firstDy = `${-(n - 1) * cfg.lineSpacing}em`;
    } else if (options.baseline !== "bottom") {
      firstDy = `${(-(n - 1) * cfg.lineSpacing) / 2}em`;
    }
  }
  const sx = condense?.nameScaleX ?? 1;
  const open = `<text x="${xScale(x)}" y="${yScale(y)}" text-anchor="${options.anchor}" dominant-baseline="${baseline}" font-size="${cfg.fontSizeUnits}" font-family="${escapeXml(cfg.fontFamily)}" font-weight="${cfg.fontWeight}" fill="${cfg.textColor}" text-rendering="geometricPrecision">`;
  if (!condense || sx >= 1) {
    const tspans = lines
      .map(
        (line, index) =>
          `<tspan x="${xScale(x)}" dy="${index === 0 ? firstDy : `${cfg.lineSpacing}em`}">${escapeXml(line)}</tspan>`,
      )
      .join("");
    return `${open}${tspans}</text>`;
  }
  // 名前のみ横圧縮: 名前の原寸送り幅(px) = visualMaxEm([name]) × fontSizeUnits。目標 = ×sx。
  const px = xScale(x);
  const nameLen = (visualMaxEm([condense.name], cfg) * cfg.fontSizeUnits * sx).toFixed(2);
  const nameTspan = `<tspan x="${px}" dy="${firstDy}" textLength="${nameLen}" lengthAdjust="spacingAndGlyphs">${escapeXml(condense.name)}</tspan>`;
  let tspans: string;
  if (n >= 2) {
    // 2 行: 上行=名前(圧縮)、以降=原寸。
    // 横圧縮(textLength)は行位置(dy)を持つ tspan へ同居させると Chromium で後続行の
    // 行送りが壊れ重なる/消える。外側 tspan は行位置のみ・内側 tspan で圧縮し隔離する。
    const nameTspanTwo =
      `<tspan x="${px}" dy="${firstDy}"><tspan textLength="${nameLen}" ` +
      `lengthAdjust="spacingAndGlyphs">${escapeXml(condense.name)}</tspan></tspan>`;
    const rest = lines
      .slice(1)
      .map((line) => `<tspan x="${px}" dy="${cfg.lineSpacing}em">${escapeXml(line)}</tspan>`)
      .join("");
    tspans = nameTspanTwo + rest;
  } else {
    // 1 行: 名前(圧縮) + 残り(x/dy 無しで同一行に流す)
    tspans = `${nameTspan}<tspan>${escapeXml(condense.rest)}</tspan>`;
  }
  return `${open}${tspans}</text>`;
}

// =============================================================================
// 4. visual em estimation — 実描画 em (全角 1.0 / 半角 0.5) 基準 bbox 推定
// -----------------------------------------------------------------------------
// 幅は visualTextWidthUnits (= visualMaxEm × fontSizeUnits) に一本化。配置 bbox
// (estimateVerifyTextExtent, charWidthFactor=1.0) も同じ実描画幅に揃っており、見切れ
// 検出と配置で同一の幅を用いる。視覚 em の実体は svg_geom 側 (layout からも参照する
// ため低レイヤに配置)。
// =============================================================================

/** placement の視覚 bbox (論理座標) が viewBox の左右どちらかからはみ出ているか判定。 */
export function detectVisualHorizontalOverflow(
  placement: Placement,
  cfg: PieLayoutConfig,
): { overflow: boolean; side: "left" | "right" | null } {
  const lines = placement.lines;
  const widthLogical = visualTextWidthUnits(lines, cfg);
  const { left: bboxLeft, right: bboxRight } = textBoxBounds(
    placement.x,
    placement.y,
    { width: widthLogical, height: 0 },
    placement.anchor,
    placement.baseline,
  );
  const tol = 1 / (cfg.svgUnitsPerMm * cfg.mmPerUnit + 1e-9);
  if (bboxRight > cfg.canvasXlim[1] + tol) return { overflow: true, side: "right" };
  if (bboxLeft < cfg.canvasXlim[0] - tol) return { overflow: true, side: "left" };
  return { overflow: false, side: null };
}
