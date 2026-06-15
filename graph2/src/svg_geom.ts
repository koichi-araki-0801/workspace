// =============================================================================
// svg_geom.ts — ラベル配置に使う純粋幾何ヘルパー群 (graph/svg_geom.js の TS 移植)
// -----------------------------------------------------------------------------
// SVG 文字列の生成や xScale/yScale 等の座標変換は含まない(それらは svg_export
// 側の責務)。引出線の屈曲点・ラベルの押し出し点・bbox 計算など数学的な操作のみ。
// =============================================================================

import type { PieLayoutConfig, LayoutItem, LayoutItemReady, Placement } from "./types.js";
import { GLYPH_ADVANCE_EM } from "./glyph_advance.js";

export interface Point {
  x: number;
  y: number;
}

export interface BBox {
  left: number;
  right: number;
  bottom: number;
  top: number;
}

export interface Extent {
  width: number;
  height: number;
}

export interface ArcSpan {
  startAngle: number;
  endAngle: number;
  midAngle: number;
}

export interface InsideFit {
  fits: boolean;
  centerX?: number;
  centerY?: number;
}

/**
 * 文字単位で視覚 em 幅を返す。第一に埋め込みフォント (BIZUDPGothic-Bold.woff2) の実 glyph
 * advance テーブル GLYPH_ADVANCE_EM を引く (実描画幅そのもの)。テーブルは非 1.0 em の codepoint
 * のみ収録 (漢字は実測一律 1.0)。未収録 codepoint は従来のレンジ heuristic にフォールバック:
 * 全角 (漢字/仮名/全角形) は full(1.0)・それ以外 (ASCII/半角カナ) は half(0.5)。
 * テーブルは scripts/gen_glyph_advance.ts が生成。emit の textLength・verify_svg も同テーブルに揃う。
 */
export function visualCharEm(ch: string, cfg: PieLayoutConfig): number {
  const c = ch.codePointAt(0)!;
  const real = GLYPH_ADVANCE_EM.get(c);
  if (real !== undefined) return real;
  if (c >= 0x4e00 && c <= 0x9fff) return cfg.visualFullwidthEm;
  if (c >= 0x3040 && c <= 0x309f) return cfg.visualFullwidthEm;
  if (c >= 0x30a0 && c <= 0x30ff) return cfg.visualFullwidthEm;
  if (c >= 0x3000 && c <= 0x303f) return cfg.visualFullwidthEm;
  if (c >= 0xff01 && c <= 0xff60) return cfg.visualFullwidthEm;
  if (c >= 0xffe0 && c <= 0xffe6) return cfg.visualFullwidthEm;
  if (c === 0x25b3) return cfg.visualFullwidthEm; // U+25B3 (白三角) は全角幅で扱う
  return cfg.visualHalfwidthEm;
}

/** lines の中で最大の視覚 em 幅を返す。 */
export function visualMaxEm(lines: string[], cfg: PieLayoutConfig): number {
  let maxEm = 0;
  for (const line of lines) {
    let lineEm = 0;
    for (const ch of line) lineEm += visualCharEm(ch, cfg);
    if (lineEm > maxEm) maxEm = lineEm;
  }
  return maxEm;
}

/**
 * 実描画グリフ幅(論理単位)。visualMaxEm(全角1.0/半角・ASCII0.5) に実描画フォント
 * サイズ fontSizeUnits(= fontSizeMm × textRenderScale) を掛けた、唯一の幅の真実源。
 * 見切れ検出・nudge・compact 判定・配置 bbox はすべてこれに揃える。
 */
export function visualTextWidthUnits(lines: string[], cfg: PieLayoutConfig): number {
  return (visualMaxEm(lines, cfg) * cfg.fontSizeMm * cfg.textRenderScale) / cfg.mmPerUnit;
}

/**
 * 名前を横圧縮 (長体 nameScaleX) した場合のラベル実描画幅 (論理単位)。% は常に原寸。
 * - 2 行: 上行=名前(圧縮)・下行=% → 幅 = max(名前em×sx, %em) × unit
 * - 1 行: "名前 %" → 幅 = (名前em×sx + " %"em) × unit
 * verify_svg.textBBox もこの式に揃える (data-name-scale-x から sx を読む)。
 */
export function scaledLabelWidthUnits(
  name: string,
  percent: string,
  lineCount: number,
  nameScaleX: number,
  cfg: PieLayoutConfig,
): number {
  // 配置 bbox 系 (estimateVerifyTextExtent) と同じく charWidthFactor を掛ける。
  const unit = (cfg.fontSizeMm * cfg.charWidthFactor * cfg.textRenderScale) / cfg.mmPerUnit;
  const nameEm = visualMaxEm([name], cfg) * nameScaleX;
  if (lineCount >= 2) {
    return Math.max(nameEm, visualMaxEm([percent], cfg)) * unit;
  }
  const pctEm = visualMaxEm([` ${percent}`], cfg);
  return (nameEm + pctEm) * unit;
}

/** 角度を [0, 360) に正規化 */
export function normalizeAngle(angle: number): number {
  return ((angle % 360) + 360) % 360;
}

/** angle が center を中心に ±halfWidth の範囲にあるか(360 跨ぎ対応) */
export function angleInBand(angle: number, center: number, halfWidth: number): boolean {
  // (((x % 360) + 360) % 360) で必ず正の剰余にしてから -180 し、delta を (-180, 180] に
  // 正規化する。素の `% 360` だけだと JS の剰余が被除数の符号を保持するため、
  // angle < center - 180 の側で wrap を取り違える(片側wrap)。
  const delta = ((((angle - center + 180) % 360) + 360) % 360) - 180;
  return Math.abs(delta) <= halfWidth;
}

/** 12 時方向(90°)から angle までの最小角度差(絶対値・度数)。 */
export function topAngleOffset(angle: number): number {
  return Math.abs(((angle - 90 + 180) % 360) - 180);
}

/**
 * 引出線長(scaledRadialExitLen)を基準に「最低値 + 比率」で長さやマージンを返す。
 */
export function radialFraction(cfg: PieLayoutConfig, min: number, factor: number): number {
  return Math.max(min, cfg.scaledRadialExitLen * factor);
}

/**
 * values 配列から各スライスの { startAngle, endAngle, midAngle }(rad)を返す。
 */
export function arcAngles(values: number[], cfg: PieLayoutConfig): ArcSpan[] {
  const total = values.reduce((sum, value) => sum + Number(value), 0);
  if (total <= 0) {
    throw new Error("sum(values) must be > 0");
  }
  const sign = cfg.counterclock ? 1 : -1;
  let current = degToRad(cfg.startangle);
  return values.map((value) => {
    const span = (Number(value) / total) * 2 * Math.PI;
    const startAngle = current;
    const endAngle = current + sign * span;
    const midAngle = current + sign * (span / 2);
    current = endAngle;
    return { startAngle, endAngle, midAngle };
  });
}

/** 度をラジアンへ変換する。 */
export function degToRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/** 半径と角度(rad)から (x, y) を返す */
export function polarToCartesian(radius: number, angleRad: number): Point {
  return {
    x: radius * Math.cos(angleRad),
    y: radius * Math.sin(angleRad),
  };
}

/**
 * ラベルリング半径(描画用)。
 */
function labelRingRadius(cfg: PieLayoutConfig, ringOffset = 0): number {
  return (
    Math.max(
      cfg.renderLabelRadius,
      cfg.pieRadius + cfg.flipPieClearance + cfg.renderRadialExitLen,
    ) + Math.max(0, ringOffset)
  );
}

/** pie 円周の指定 x における y(>=0)。 */
export function pieYAtX(x: number, cfg: PieLayoutConfig): number {
  const r2 = cfg.pieRadius * cfg.pieRadius;
  return Math.sqrt(Math.max(0, r2 - x * x));
}

/** 左上ゾーン (90°→180°) の正規化進捗 [0, 1] */
export function upperLeftAngleProgress(angle: number): number {
  return Math.max(0, Math.min(1, (angle - 90) / 90));
}

function getUpperLeftRanks(item: LayoutItem): { count: number; rank: number; outerRank: number } {
  const count = Math.max(1, item?.upperLeftCount ?? 1);
  const rank = item?.upperLeftRank ?? 0;
  const outerRank = Math.max(0, count - 1 - rank);
  return { count, rank, outerRank };
}

/**
 * verify_svg の bbox 推定に合わせたラベル高さ(論理単位)。
 */
export function labelHeightUnits(textLines: number, cfg: PieLayoutConfig): number {
  const heightMm = textLines * cfg.lineHeightFactor * cfg.fontSizeMm * cfg.textRenderScale;
  return heightMm / cfg.mmPerUnit;
}

/**
 * 横方向ほぼ水平な lower-left の anchorY 上限を返す。
 */
export function pieHorizontalLowerLeftAnchorYBound(cfg: PieLayoutConfig): number {
  return -(labelHeightUnits(1, cfg) + 0.014);
}

/**
 * 「水平ぎみ lower-left」と「深い lower-left」の境界 anchorY。
 */
export function lowerLeftDeepBoundaryY(cfg: PieLayoutConfig): number {
  return -3 * labelHeightUnits(1, cfg);
}

/**
 * 「水平ぎみ lower-left」を deepest LL からどれだけ下方向に下げるかの logical 量。
 */
export function horizontalLowerLeftDropAmount(cfg: PieLayoutConfig): number {
  return cfg.scaledMinGap + Math.max(0.014, cfg.scaledRadialExitLen * 0.16);
}

/**
 * 任意の (x, y) を「ラベルリング(描画用半径)」の上へ射影する。
 */
export function projectLabelPoint(x: number, y: number, cfg: PieLayoutConfig): Point {
  const targetRadius = labelRingRadius(cfg);
  const sourceRadius = Math.hypot(x, y);
  if (sourceRadius <= 1e-6) {
    return { x: targetRadius, y: 0 };
  }
  const scale = targetRadius / sourceRadius;
  return { x: x * scale, y: y * scale };
}

/**
 * 左側用: targetY を保ちつつリング上の左側 x を返す。
 */
export function projectLeftRingPoint(
  targetY: number,
  cfg: PieLayoutConfig,
  ringOffset = 0,
  minX: number | null = null,
): Point {
  let targetRadius = labelRingRadius(cfg, ringOffset);
  const clampedY = Math.max(
    -targetRadius + 1e-4,
    Math.min(targetRadius - 1e-4, targetY),
  );
  if (minX !== null) {
    const minRequiredRadius = Math.hypot(Math.min(0, minX), clampedY);
    if (minRequiredRadius > targetRadius) {
      targetRadius = minRequiredRadius;
    }
  }
  return {
    x: -Math.sqrt(Math.max(0, targetRadius * targetRadius - clampedY * clampedY)),
    y: clampedY,
  };
}

function upperLeftDenseMaxY(anchorY: number, cfg: PieLayoutConfig): number {
  return anchorY + radialFraction(cfg, 0.1, 1.0);
}

function upperLeftRingOffset(item: LayoutItem, angle: number, cfg: PieLayoutConfig): number {
  const angleProgress = upperLeftAngleProgress(angle);
  const { count, outerRank } = getUpperLeftRanks(item);
  let offset = radialFraction(cfg, 0.01, 0.1);
  offset += radialFraction(cfg, 0.02, 0.28) * angleProgress;
  if (count >= 3) offset += radialFraction(cfg, 0.015, 0.1) * outerRank;
  if (item.upperLeftSmallDense) offset += radialFraction(cfg, 0.012, 0.08) * outerRank;
  if (item.upperLeftLongDense) offset += radialFraction(cfg, 0.01, 0.08);
  return offset;
}

/** トップバンドのラベル Y を、anchor から最低限上に持ち上げる。 */
export function topBandY(
  anchorY: number,
  displayY: number,
  angle: number,
  cfg: PieLayoutConfig,
  isUpperLeft: boolean,
): number {
  const angleOffset = topAngleOffset(angle);
  const extraLift = Math.min(0.18, Math.max(0, 18 - angleOffset) * 0.01);
  if (isUpperLeft) {
    return Math.max(displayY, anchorY + cfg.scaledRadialExitLen + extraLift);
  }
  return anchorY + cfg.scaledRadialExitLen + extraLift;
}

/** 右上 flip 時のラベル X を、最低でも anchor から右へ離す */
export function flipTopRightX(anchorX: number, displayX: number, cfg: PieLayoutConfig): number {
  return Math.max(displayX, anchorX + radialFraction(cfg, 0.28, 3.0));
}

function upperLeftFirstLen(angle: number, cfg: PieLayoutConfig): number {
  const angleProgress = upperLeftAngleProgress(angle);
  return radialFraction(cfg, 0.09, 0.95 + 1.1 * angleProgress);
}

/** 左上ラベルの水平区間長(× 0.95)。 */
export function upperLeftHorizontalLen(angle: number, cfg: PieLayoutConfig): number {
  return upperLeftFirstLen(angle, cfg) * 0.95;
}

function upperLeftTextPadding(item: LayoutItem, cfg: PieLayoutConfig): number {
  let pad = radialFraction(cfg, 0.03, 0.35);
  if ((item.upperLeftCount ?? 1) >= 3) {
    pad = radialFraction(cfg, pad, 0.48);
  }
  return pad;
}

/**
 * 左上ラベルの引出線屈曲点。
 */
export function upperLeftBendPoint(
  anchorX: number,
  anchorY: number,
  angle: number,
  cfg: PieLayoutConfig,
  item: LayoutItem,
): Point {
  const { count, rank, outerRank } = getUpperLeftRanks(item);
  let firstLen: number;
  if (item?.upperLeftSmallDense) {
    const rankRatio = rank / Math.max(1, count - 1);
    firstLen = upperLeftFirstLen(angle, cfg) * 1.1;
    firstLen += radialFraction(cfg, 0.02, 0.25) * (1 - rankRatio);
  } else {
    firstLen = upperLeftHorizontalLen(angle, cfg);
  }
  firstLen += radialFraction(cfg, 0.012, 0.14) * outerRank;
  return { x: anchorX - firstLen, y: anchorY };
}

/**
 * 一般ラベルの引出線屈曲点。
 */
export function leaderBendPoint(
  anchorX: number,
  anchorY: number,
  finalX: number,
  finalY: number,
  bendDir: number,
  midAngle: number,
  cfg: PieLayoutConfig,
  labelBox?: BBox,
): Point {
  const horizontalSpan = Math.abs(finalX - anchorX);
  const verticalSpan = Math.abs(finalY - anchorY);
  const angleRad = degToRad(normalizeAngle(midAngle));
  let tangentLikeAngle =
    (Math.atan2(
      Math.abs(Math.cos(angleRad)),
      Math.max(Math.abs(Math.sin(angleRad)), 1e-6),
    ) *
      180) /
    Math.PI;
  if (bendDir > 0) tangentLikeAngle *= 0.82;
  const targetAngle = Math.max(28, Math.min(68, tangentLikeAngle));
  const targetTan = Math.tan(degToRad(targetAngle));
  const angleBasedLength = verticalSpan / Math.max(targetTan, 1e-6);
  const bendLength = Math.max(
    radialFraction(cfg, 0.1, 1.15),
    Math.min(horizontalSpan * 0.55, angleBasedLength),
  );
  const bend: Point = { x: anchorX + bendDir * bendLength, y: anchorY };
  return labelBox ? clampBendOutsideBox(bend, anchorX, finalX, labelBox) : bend;
}

/**
 * bend.x が labelBox の X 範囲内に入ると bend → finalX の対角線が bbox を貫通するため、
 * anchor 側の縁まで引き戻す。
 */
export function clampBendOutsideBox(
  bend: Point,
  anchorX: number,
  finalX: number,
  labelBox: BBox,
  eps = 1e-3,
): Point {
  if (anchorX > labelBox.right && bend.x < labelBox.right - eps) {
    const target = Math.min(Math.max(labelBox.right, finalX), anchorX - eps);
    return { x: target, y: bend.y };
  }
  if (anchorX < labelBox.left && bend.x > labelBox.left + eps) {
    const target = Math.max(Math.min(labelBox.left, finalX), anchorX + eps);
    return { x: target, y: bend.y };
  }
  return bend;
}

/**
 * 引出線の最終線分 [bend → endpoint] を、ラベル bbox に入る手前(anchor 側の縁から gap
 * だけ外)で切り詰めた終点を返す。終点はもともとテキスト基準点(anchor=middle なら水平
 * 中央)に置かれるため、放置すると引出線がラベル中央まで伸びる。bbox 縁で止めることで
 * 左側ラベルなら右縁・右側ラベルなら左縁・真上/真下ラベルなら近い上下縁で接続する。
 * 返す点は線分 [bend → endpoint] 上にあるため drawn パスは元パスの部分集合となり、
 * 新たな貫通・交差を生まない。線分が box に入らなければ endpoint をそのまま返す。
 * Liang-Barsky で線分が AABB に入る最小パラメータ t0 を求める。
 */
export function truncateLeaderEndpointAtBox(
  bend: Point,
  endpoint: Point,
  box: BBox,
  gap: number,
): Point {
  const dx = endpoint.x - bend.x;
  const dy = endpoint.y - bend.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return endpoint;
  let t0 = 0;
  let t1 = 1;
  const p = [-dx, dx, -dy, dy];
  const q = [bend.x - box.left, box.right - bend.x, bend.y - box.bottom, box.top - bend.y];
  for (let i = 0; i < 4; i += 1) {
    if (Math.abs(p[i]) < 1e-12) {
      // 線分がこのスラブに平行。境界の外側なら交差しない。
      if (q[i] < 0) return endpoint;
    } else {
      const r = q[i] / p[i];
      if (p[i] < 0) {
        if (r > t1) return endpoint;
        if (r > t0) t0 = r;
      } else {
        if (r < t0) return endpoint;
        if (r < t1) t1 = r;
      }
    }
  }
  // t0 <= 0: bend が box 内 (引出線がラベルに食い込む病的形状) → 切り詰めない。
  // t0 >= 1: box への進入点が endpoint より先 → 既に box 外なので切り詰め不要。
  if (t0 <= 0 || t0 >= 1) return endpoint;
  const backoff = Math.min(gap / len, t0);
  const t = t0 - backoff;
  return { x: bend.x + t * dx, y: bend.y + t * dy };
}

/**
 * leader をラベルの「縦中央(1 行)/向きに応じた行位置(2 行)」へ繋ぐための接続 Y を返す。
 * approach は anchor(スライス円縁)と box 中心の関係で決める:
 *   - 横優位 (|dx| >= |dy|) → 行間 = box 縦中央
 *   - box が anchor より上 (boxCenterY > anchorY、線は下から来る) → 下行の縦中央
 *   - それ以外 (線は上から来る) → 上行の縦中央
 * box は論理座標 (top > bottom, 上が +)。perLineHeight は 1 行分の高さ
 * (= labelHeightUnits(1)、2 行 box 高の半分)。
 */
export function leaderAttachTargetY(
  box: BBox,
  anchor: Point,
  lineCount: number,
  perLineHeight: number,
): number {
  const boxCenterY = (box.top + box.bottom) / 2;
  if (lineCount < 2) return boxCenterY; // 1 行 → その行の縦中央
  const boxCenterX = (box.left + box.right) / 2;
  const adx = boxCenterX - anchor.x;
  const ady = boxCenterY - anchor.y;
  if (Math.abs(adx) >= Math.abs(ady)) return boxCenterY; // 横 → 行間
  if (boxCenterY > anchor.y) return box.bottom + perLineHeight / 2; // 下から → 下行中央
  return box.top - perLineHeight / 2; // 上から → 上行中央
}

/** 名前長と行数からラベル外側に必要な余白を増やす */
export function labelOutwardClearance(item: LayoutItem, base: number): number {
  let extra = Math.max(0, item.name.length - 6) * 0.012;
  if ((item.textLines ?? 2) >= 3) extra += 0.04;
  return base + extra;
}

export interface LabelLines {
  isCompact: boolean;
  lines: string[];
  longestUnits: number;
}

/**
 * ラベル本文を 1 行 or 2 行のテキスト配列にする。
 */
export function getLabelLines(item: LayoutItem, cfg: PieLayoutConfig): LabelLines {
  const isCompact = Boolean(item.compactLabel || cfg.compactLabel);
  const lines = isCompact
    ? [`${item.name} ${item.percentText ?? ""}`]
    : [item.name, item.percentText ?? ""];
  // 幅は実描画 em(全角1.0/半角・ASCII0.5)で数える(visualMaxEm)。配置・見切れ検出の
  // 唯一の幅源 visualTextWidthUnits と同じ em 基準に揃える。
  const longestUnits = Math.max(visualMaxEm(lines, cfg), 1);
  return { isCompact, lines, longestUnits };
}

/**
 * verify_svg の bbox 推定と完全一致する論理単位の bbox。
 */
export function estimateVerifyTextExtent(
  item: LayoutItem,
  cfg: PieLayoutConfig,
  lineCount = 2,
): Extent {
  const { longestUnits } = getLabelLines(item, cfg);
  const widthMm = longestUnits * cfg.fontSizeMm * cfg.charWidthFactor * cfg.textRenderScale;
  return {
    width: widthMm / cfg.mmPerUnit,
    height: labelHeightUnits(lineCount, cfg),
  };
}

/**
 * 配置決定用の bbox 推定。
 */
export function estimateTextExtent(item: LayoutItem, cfg: PieLayoutConfig): Extent {
  const { isCompact } = getLabelLines(item, cfg);
  const lineCount = isCompact ? 1 : item.textLines ?? 2;
  return estimateVerifyTextExtent(item, cfg, lineCount);
}

/**
 * スライス内部にラベル bbox が収まるか判定し、収まる場合は配置中心 (cx, cy) を返す。
 */
export function fitsInsideSlice(
  midAngleRad: number,
  spanRad: number,
  item: LayoutItem,
  lineCount: number,
  cfg: PieLayoutConfig,
): InsideFit {
  const { width, height } = estimateVerifyTextExtent(item, cfg, lineCount);
  return fitsInsideSliceExtent(midAngleRad, spanRad, width, height, cfg);
}

/**
 * fitsInsideSlice の本体。bbox 幅/高さ (論理単位) を明示指定する版。
 * カスケードが各 form (行数 × 長体率) の実寸で内側判定するために使う。
 *
 * `horizontalCenter=true` (dominant スライス用) のときは配置中心の水平成分を 0 (= キャンバス水平中央)
 * へ固定する。重心方向に置くと欠けたウェッジの反対側へ横ずれするため、dominant では「真下中央」意図
 * どおり中心へ揃える。縦成分 `cy` は据え置き。スパンが大きいので四隅は半径・角度スパン内に収まる。
 */
export function fitsInsideSliceExtent(
  midAngleRad: number,
  spanRad: number,
  bboxW: number,
  bboxH: number,
  cfg: PieLayoutConfig,
  horizontalCenter = false,
): InsideFit {
  if (spanRad <= 1e-6) return { fits: false };
  const halfSpan = spanRad / 2;
  if (bboxW <= 0 || bboxH <= 0) return { fits: false };

  const R = cfg.pieRadius;
  const centroidR = ((2 * R) / 3) * (Math.sin(halfSpan) / halfSpan);
  const anchorRadius = Math.max(0.3 * R, Math.min(0.7 * R, centroidR));
  const cx = horizontalCenter ? 0 : anchorRadius * Math.cos(midAngleRad);
  const cy = anchorRadius * Math.sin(midAngleRad);

  const clearance = cfg.insideSliceClearance ?? 0.04;
  const angularClearanceRad = degToRad(cfg.insideSliceAngularClearanceDeg ?? 3);
  const maxRadius = R - clearance;
  const allowedHalfSpan = halfSpan - angularClearanceRad;
  if (allowedHalfSpan <= 0) return { fits: false };

  const halfW = bboxW / 2;
  const halfH = bboxH / 2;
  const corners: Point[] = [
    { x: cx - halfW, y: cy - halfH },
    { x: cx + halfW, y: cy - halfH },
    { x: cx - halfW, y: cy + halfH },
    { x: cx + halfW, y: cy + halfH },
  ];
  for (const corner of corners) {
    const r = Math.hypot(corner.x, corner.y);
    if (r > maxRadius) return { fits: false };
    const cornerAngle = Math.atan2(corner.y, corner.x);
    const delta = Math.atan2(
      Math.sin(cornerAngle - midAngleRad),
      Math.cos(cornerAngle - midAngleRad),
    );
    if (Math.abs(delta) > allowedHalfSpan) return { fits: false };
  }
  return { fits: true, centerX: cx, centerY: cy };
}

/**
 * テキスト基準点と anchor / baseline からラベル bbox を求める。
 * 座標系は y-up(他の幾何関数と同様、+y が上)。
 */
export function textBoxBounds(
  textX: number,
  textY: number,
  measured: Extent,
  anchor: string,
  baseline: string,
): BBox {
  let left: number;
  let right: number;
  if (anchor === "start") {
    left = textX;
    right = textX + measured.width;
  } else if (anchor === "end") {
    left = textX - measured.width;
    right = textX;
  } else {
    left = textX - measured.width / 2;
    right = textX + measured.width / 2;
  }

  let bottom: number;
  let top: number;
  if (baseline === "bottom") {
    top = textY;
    bottom = textY - measured.height;
  } else if (baseline === "top") {
    bottom = textY;
    top = textY + measured.height;
  } else {
    bottom = textY - measured.height / 2;
    top = textY + measured.height / 2;
  }

  return { left, right, bottom, top };
}

/**
 * placement の現在位置から verify_svg と同じ bbox を計算する。
 */
/**
 * placement の実描画 extent (論理単位)。行数は placement.lines.length、名前長体は
 * placement.nameScaleX を反映する (% は原寸)。scaledLabelWidthUnits(...,1) は
 * 非圧縮 estimateVerifyTextExtent と一致するため、衝突/クランプの幅源を一本化できる。
 */
export function placementExtent(placement: Placement, cfg: PieLayoutConfig): Extent {
  const lineCount = placement.lines.length >= 2 ? 2 : 1;
  const sx = placement.nameScaleX ?? 1;
  if (placement.nameSplit && placement.lines.length >= 2) {
    // 名前分割ラベル: lines = [名前前半, 名前後半+%]。長体は上行 (名前前半) のみ。
    // scaledLabelWidthUnits(line1, line2, 2, sx) = max(em(line1)×sx, em(line2)) × unit。
    return {
      width: scaledLabelWidthUnits(placement.lines[0], placement.lines[1], 2, sx, cfg),
      height: labelHeightUnits(2, cfg),
    };
  }
  const name = placement.item.name;
  const percent = placement.item.percentText ?? "";
  return {
    width: scaledLabelWidthUnits(name, percent, lineCount, sx, cfg),
    height: labelHeightUnits(lineCount, cfg),
  };
}

export function placementBox(placement: Placement, cfg: PieLayoutConfig): BBox {
  const measured = placementExtent(placement, cfg);
  return textBoxBounds(placement.x, placement.y, measured, placement.anchor, placement.baseline);
}

/**
 * placement の水平可動域 (論理 X 下限/上限)。通常は canvasXlim (端マージン 67.5px)。
 * twoLineLeftColumn (円から離して縦積みした左列ラベル) は円とラベルの隙間を確保するため、
 * canvasXlim ではなく viewBox 端 (svgWidthPx) から ~6px 内側までを可動域にする。
 */
export function horizontalLabelLimits(
  placement: Placement,
  cfg: PieLayoutConfig,
): [number, number] {
  if (placement.twoLineLeftColumn) {
    const half = cfg.svgWidthPx / 2 / cfg.pxPerUnit;
    const edge = 6 / cfg.pxPerUnit; // viewBox 端から ~6px の安全代
    return [-half + edge, half - edge];
  }
  return cfg.canvasXlim;
}

/**
 * 線分 ab と cd が交差するか。verify_svg.ts と同一実装 (tolerance は px 基準)。
 * 端点が辺に乗る (=|cross| <= tolerance) 場合は「交差せず」と扱う。
 */
export function segmentsIntersect(
  a: Point,
  b: Point,
  c: Point,
  d: Point,
  tolerance = 0.5,
): boolean {
  const cross = (p: Point, q: Point, r: Point) =>
    (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  if (Math.abs(d1) <= tolerance) return false;
  if (Math.abs(d2) <= tolerance) return false;
  if (Math.abs(d3) <= tolerance) return false;
  if (Math.abs(d4) <= tolerance) return false;
  return (d1 > 0) !== (d2 > 0) && (d3 > 0) !== (d4 > 0);
}

/**
 * leader の折れ線 (pixel 座標) が矩形 box (pixel 座標, pad で内側へ収縮) を貫くか。
 * verify_svg.ts の "leader through label" 判定 (segIntersectsBox) を厳密再現する。
 * 両端とも box 内のセグメントは貫通とみなさない (verify と同様)。box は top < bottom
 * (pixel, y 下向き) 前提。
 */
export function leaderCrossesBox(points: Point[], box: BBox, pad = 2): boolean {
  const left = box.left + pad;
  const right = box.right - pad;
  const top = box.top + pad;
  const bottom = box.bottom - pad;
  if (left >= right || top >= bottom) return false;
  const corners = [
    { x: left, y: top },
    { x: right, y: top },
    { x: right, y: bottom },
    { x: left, y: bottom },
  ];
  for (let k = 0; k + 1 < points.length; k += 1) {
    const p1 = points[k];
    const p2 = points[k + 1];
    const inA = p1.x >= left && p1.x <= right && p1.y >= top && p1.y <= bottom;
    const inB = p2.x >= left && p2.x <= right && p2.y >= top && p2.y <= bottom;
    if (inA && inB) continue;
    if (inA || inB) return true;
    for (let i = 0; i < 4; i += 1) {
      if (segmentsIntersect(p1, p2, corners[i], corners[(i + 1) % 4])) return true;
    }
  }
  return false;
}

/**
 * テキスト bbox が引出線端点に被っていたら、押し出して離す(最大 3 回試行)。
 */
export function nudgeTextAwayFromEndpoint(
  textX: number,
  textY: number,
  anchor: string,
  baseline: string,
  endpointX: number,
  endpointY: number,
  measured: Extent,
  cfg: PieLayoutConfig,
): Point {
  const padX = radialFraction(cfg, 0.03, 0.34);
  const padY = radialFraction(cfg, 0.02, 0.24);
  let nextX = textX;
  let nextY = textY;

  for (let step = 0; step < 3; step += 1) {
    const bounds = textBoxBounds(nextX, nextY, measured, anchor, baseline);
    const insideX = bounds.left - padX <= endpointX && endpointX <= bounds.right + padX;
    const insideY = bounds.bottom - padY <= endpointY && endpointY <= bounds.top + padY;
    if (!insideX || !insideY) break;

    if (anchor === "start") {
      nextX = Math.max(nextX, endpointX + padX);
    } else if (anchor === "end") {
      nextX = Math.min(nextX, endpointX - padX);
    }

    if (baseline === "bottom") {
      nextY = Math.max(nextY, endpointY + padY);
    } else if (baseline === "top") {
      nextY = Math.min(nextY, endpointY - padY);
    } else if (endpointY >= nextY) {
      nextY -= padY;
    } else {
      nextY += padY;
    }
  }

  return { x: nextX, y: nextY };
}

function segmentBounds(start: Point, end: Point, padX: number, padY: number): BBox {
  return {
    left: Math.min(start.x, end.x) - padX,
    right: Math.max(start.x, end.x) + padX,
    bottom: Math.min(start.y, end.y) - padY,
    top: Math.max(start.y, end.y) + padY,
  };
}

function boxesOverlap(a: BBox, b: BBox): boolean {
  return !(a.right < b.left || a.left > b.right || a.top < b.bottom || a.bottom > b.top);
}

/** 2 つの BBox の X/Y 方向の重なり量 (正=重なり, 0 以下=非重なり)。 */
export function boxOverlapAmount(a: BBox, b: BBox): { x: number; y: number } {
  return {
    x: Math.min(a.right, b.right) - Math.max(a.left, b.left),
    y: Math.min(a.top, b.top) - Math.max(a.bottom, b.bottom),
  };
}

/**
 * ラベル箱の Y 範囲 (boxTop/boxBottom)・幅・anchor から、pie クリアランスを満たす textX の
 * 上下限 (pieMinTextX = 右側ラベルの下限 / pieMaxTextX = 左側ラベルの上限) を計算する。
 *
 * post_layout の clampPlacement が後段で y が動いた後に円クリアランス X 限界を動的再計算するための
 * ヘルパ。label_placement の clampAndBuildPlacement にある draft 構築時の静的計算 (同式をインライン
 * 展開) と対になる。静的計算は draft 時点の y で固定されるため、ラベルが大きい |y| へ動くと円が太く
 * なり静的限界では円内へ食い込む。それを本関数の動的再計算が補正する。
 * 箱の最近接 Y 縁が円の完全に外 (|closestY| >= pieRadius) のときは円との X 干渉が無いので null を
 * 返す (静的計算は同ケースで insidePieR=0 の名残制約を作るが、動的側は X 制約不要として正しく外す)。
 *
 * closestY は箱の Y 範囲のうち円中心 (y=0) に最も近い値: 箱が y=0 を跨げば 0、そうでなければ
 * 絶対値の小さい側の縁。その Y での円半幅 insidePieR = sqrt(r² − closestY²) にクリアランスと
 * ラベル幅 (anchor 依存) を足して X 限界にする。
 */
export function pieClampXLimits(
  boxTop: number,
  boxBottom: number,
  width: number,
  anchor: string,
  cfg: PieLayoutConfig,
): { pieMinTextX: number; pieMaxTextX: number } | null {
  let closestY: number;
  if (boxBottom <= 0 && boxTop >= 0) closestY = 0;
  else closestY = Math.abs(boxBottom) < Math.abs(boxTop) ? boxBottom : boxTop;
  if (Math.abs(closestY) >= cfg.pieRadius) return null;
  const pieClearanceLogical = Math.max(cfg.pieLabelClearance, radialFraction(cfg, 0.012, 0.12));
  const insidePieR = Math.sqrt(
    Math.max(0, cfg.pieRadius * cfg.pieRadius - closestY * closestY),
  );
  let pieMinTextX = insidePieR + pieClearanceLogical;
  let pieMaxTextX = -(insidePieR + pieClearanceLogical);
  if (anchor === "middle") {
    pieMinTextX += width / 2;
    pieMaxTextX -= width / 2;
  } else if (anchor === "end") {
    pieMinTextX += width;
  } else {
    pieMaxTextX -= width;
  }
  return { pieMinTextX, pieMaxTextX };
}

/**
 * テキスト bbox が円内に侵入していたら、半径方向に押し出して逃がす。
 */
export function nudgeTextAwayFromPie(
  textX: number,
  textY: number,
  anchor: string,
  baseline: string,
  verifyMeasured: Extent,
  cfg: PieLayoutConfig,
): Point {
  const pieR = cfg.pieRadius;
  const clearance = cfg.pieLabelClearance;
  let nextX = textX;
  let nextY = textY;

  for (let step = 0; step < 8; step += 1) {
    const bounds = textBoxBounds(nextX, nextY, verifyMeasured, anchor, baseline);
    const closestX = Math.max(bounds.left, Math.min(0, bounds.right));
    const closestY = Math.max(bounds.bottom, Math.min(0, bounds.top));
    const dist = Math.hypot(closestX, closestY);
    if (dist >= pieR + clearance) break;

    let dirX: number;
    let dirY: number;
    if (dist > 1e-6) {
      dirX = closestX / dist;
      dirY = closestY / dist;
    } else {
      const cx = (bounds.left + bounds.right) / 2;
      const cy = (bounds.bottom + bounds.top) / 2;
      const cd = Math.hypot(cx, cy);
      if (cd < 1e-6) break;
      dirX = cx / cd;
      dirY = cy / cd;
    }
    const need = pieR + clearance - dist + 1e-4;
    nextX += dirX * need;
    nextY += dirY * need;
  }

  return { x: nextX, y: nextY };
}

/**
 * テキスト bbox が引出線本体(線分)に被っていたら、線の主軸に対して直交する
 * 方向に押し出して離す。
 */
export function nudgeTextAwayFromSegment(
  textX: number,
  textY: number,
  anchor: string,
  baseline: string,
  start: Point,
  end: Point,
  measured: Extent,
  cfg: PieLayoutConfig,
): Point {
  const padX = radialFraction(cfg, 0.03, 0.34);
  const padY = radialFraction(cfg, 0.02, 0.24);
  let nextX = textX;
  let nextY = textY;

  for (let step = 0; step < 3; step += 1) {
    const textBounds = textBoxBounds(nextX, nextY, measured, anchor, baseline);
    const lineBounds = segmentBounds(start, end, padX, padY);
    if (!boxesOverlap(textBounds, lineBounds)) break;

    const horizontal = Math.abs(end.x - start.x) >= Math.abs(end.y - start.y);
    if (horizontal) {
      if (baseline === "bottom") {
        nextY = Math.min(Math.max(nextY, lineBounds.top + padY), textY + padY * 1.4);
      } else if (baseline === "top") {
        nextY = Math.max(Math.min(nextY, lineBounds.bottom - padY), textY - padY * 1.4);
      } else if (nextY >= (start.y + end.y) / 2) {
        nextY = Math.min(nextY + padY, textY + padY * 1.4);
      } else {
        nextY = Math.max(nextY - padY, textY - padY * 1.4);
      }
    } else if (anchor === "start") {
      nextX = Math.min(Math.max(nextX, lineBounds.right + padX), textX + padX * 1.6);
    } else if (anchor === "end") {
      nextX = Math.max(Math.min(nextX, lineBounds.left - padX), textX - padX * 1.6);
    } else if (nextX >= (start.x + end.x) / 2) {
      nextX = Math.min(nextX + padX, textX + padX * 1.6);
    } else {
      nextX = Math.max(nextX - padX, textX - padX * 1.6);
    }
  }

  return { x: nextX, y: nextY };
}

/**
 * 左上 + トップバンド用のラベル端点を求める。
 */
export function topBandUpperLeftTarget(
  item: LayoutItemReady,
  anchorX: number,
  topY: number,
  angle: number,
  cfg: PieLayoutConfig,
  measured: Extent,
): Point {
  const angleProgress = upperLeftAngleProgress(angle);
  const renderY = item.upperLeftRenderY ?? 0;
  let endpointY = renderY > 0 ? renderY : topY;
  const anchorClearanceY =
    Math.sin(degToRad(angle)) * cfg.pieRadius + cfg.scaledRadialExitLen * 0.42;
  endpointY = Math.max(endpointY, anchorClearanceY);
  if (item.textLines >= 3) {
    endpointY += Math.max(cfg.scaledMinGap * 0.12, measured.height * 0.08);
  }

  const firstLen = upperLeftFirstLen(angle, cfg);
  let textPush = upperLeftTextPadding(item, cfg);
  if (item.upperLeftLongDense || item.isLong) {
    textPush += 0.03;
  }
  const minHorizontalX = Math.min(
    anchorX - radialFraction(cfg, 0.06, 0.54),
    anchorX - Math.max(firstLen, textPush * 0.72),
    -textPush,
  );

  let ringOffset = upperLeftRingOffset(item, angle, cfg);
  ringOffset += radialFraction(cfg, 0.015, 0.14) * (1 - angleProgress);
  if (item.upperLeftSmallDense) {
    ringOffset += radialFraction(cfg, 0.015, 0.12);
  }
  if (item.upperLeftLongDense || item.isLong) {
    ringOffset += radialFraction(cfg, 0.02, 0.18);
  }

  return projectLeftRingPoint(endpointY, cfg, ringOffset, minHorizontalX);
}

/**
 * 通常の左上ラベル用の端点を求める。
 */
export function upperLeftTarget(
  item: LayoutItemReady,
  anchorY: number,
  displayY: number,
  angle: number,
  cfg: PieLayoutConfig,
  padY: number,
  measured: Extent,
): Point {
  const angleProgress = upperLeftAngleProgress(angle);
  const { outerRank } = getUpperLeftRanks(item);

  let endpointY: number;
  const hasRenderY = (item.upperLeftRenderY ?? 0) > 0;
  if (hasRenderY) {
    endpointY = item.upperLeftRenderY;
  } else {
    endpointY = Math.max(displayY, anchorY + Math.min(padY, measured.height * 0.16));
  }

  if (item.upperLeftSmallDense && !hasRenderY) {
    endpointY = Math.min(endpointY, upperLeftDenseMaxY(anchorY, cfg));
  }
  endpointY = Math.max(endpointY, anchorY + Math.min(padY, measured.height * 0.12));

  let ringOffset = upperLeftRingOffset(item, angle, cfg);
  ringOffset += radialFraction(cfg, 0.01, 0.1) * outerRank;
  if (item.upperLeftLongDense && angle < 135) {
    ringOffset += radialFraction(cfg, 0.02, 0.22) * (1 - angleProgress);
  }
  if (item.upperLeftSmallDense) {
    ringOffset = Math.max(0.0, ringOffset - radialFraction(cfg, 0.01, 0.08));
  }
  if (angle >= 160 && item.isLong) {
    ringOffset += radialFraction(cfg, 0.07, 0.55);
  }
  return projectLeftRingPoint(endpointY, cfg, ringOffset);
}

