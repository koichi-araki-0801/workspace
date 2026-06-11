// =============================================================================
// svg_export/post_layout.ts — レイアウト後・SVG 出力前の placement 調整
// -----------------------------------------------------------------------------
// 役割:
//   - resolveLabelOverlaps: 3 段 (主パス対角押し + Secondary パス縦分離 +
//     settlePinnedClustersDownward で固定済みクラスタを下方向に沈降) の overlap 解消
//   - clampPlacement / clampToAnchorSide: viewBox 上下限 + anchor 側引き戻し
//   - runCompactCascade: compactLabel 自動選択カスケード (6 ブロックの heuristic)
//   - applyVisualViewBoxNudge: 視覚 viewBox はみ出し最終 nudge
// 注: 半角カナのフォント subset 包含は svg_export/font.ts (REQUIRED_FONT_CHARS) の責務。
//
// ファイル内構成:
//   1. overlap resolution + clamp
//   2. compactify cascade (runCompactCascade)
//   3. visual viewBox nudge
// =============================================================================

import {
  placementBox,
  boxOverlapAmount,
  estimateTextExtent,
  labelHeightUnits,
  pieHorizontalLowerLeftAnchorYBound,
  lowerLeftDeepBoundaryY,
  radialFraction,
  normalizeAngle,
  angleInBand,
  pieYAtX,
  textBoxBounds,
  visualTextWidthUnits,
} from "../svg_geom.js";
import { layoutLabels } from "../layout.js";
import { TOP_BAND_HALF_WIDTH_DEG } from "../label_placement.js";
import type { PieLayoutConfig, LayoutItem, Placement } from "../types.js";
import { detectVisualHorizontalOverflow } from "./rendering.js";

// =============================================================================
// 1. overlap resolution + clamp
// =============================================================================

/** 重なり量がこの値 (px) 未満なら警告に達しないので無視する閾値。重なり警告の境界
 *  (8px) に対し、bbox 推定差で取りこぼす境界ケース (8px ちょうど) を確実に解消するため
 *  僅かに低く設定する。 */
export const OVERLAP_THRESHOLD_PX = 6;
/** 1 パス内での同じペアに対する押し離し試行回数の上限。 */
export const OVERLAP_MAX_ITER = 8;
/** 主パスで対角押しに切り替える dy 正規化の最小値。 */
export const OVERLAP_DIAG_MIN_DY_NORM = 0.3;
/** 横方向の隙間がこの px 未満かつ縦に重なるペアを Secondary パスで縦分離する。 */
export const OVERLAP_HORIZ_NEAR_GAP_PX = 24;
/** resolveLabelOverlaps + nudgeTextAwayFromPie の交互反復回数。 */
export const POST_LAYOUT_PASS_COUNT = 4;

/** placement.x/y を min/maxTextX/min/maxTextY 上下限にクランプする (undefined はスルー)。 */
export function clampPlacement(placement: Placement): void {
  if (typeof placement.maxTextX === "number" && placement.x > placement.maxTextX) {
    placement.x = placement.maxTextX;
  }
  if (typeof placement.minTextX === "number" && placement.x < placement.minTextX) {
    placement.x = placement.minTextX;
  }
  if (typeof placement.maxTextY === "number" && placement.y > placement.maxTextY) {
    placement.y = placement.maxTextY;
  }
  if (typeof placement.minTextY === "number" && placement.y < placement.minTextY) {
    placement.y = placement.minTextY;
  }
}

/**
 * placement.x の変更後、leader endpoint が pie 中心 (x=0) を跨いで anchor の
 * 反対側へ移った場合、placement.x を「leader endpoint が x=0 に戻る位置」へ引き戻す。
 */
export function clampToAnchorSide(p: Placement): void {
  // 上部「その他」を右上へ第一優先で置いたラベルは中心跨ぎの引き戻しを免除 (anchorX が
  // 僅かに負でも右側を維持する)。
  if (p.forceTopRight) return;
  const ax = p.leaderAnchor?.x;
  const ex = p.leaderEndpoint?.x;
  const ox = p.origTextX;
  if (typeof ax !== "number" || typeof ex !== "number" || typeof ox !== "number") return;
  const newEx = ex + (p.x - ox);
  if (ax > 0 && newEx < 0) p.x = ox - ex;
  else if (ax < 0 && newEx > 0) p.x = ox - ex;
}

/**
 * placement が符号付き Y 変位 dyDelta の方向へ既にクランプ上限/下限へ張り付いていて
 * 動かせない場合 true。maxTextY/minTextY 未設定ならブロックなし。
 * (dyDelta > 0 = 上方向 / canvasYlim 上限 maxTextY 側、dyDelta < 0 = 下方向 minTextY 側)
 */
function blockedInY(p: Placement, dyDelta: number): boolean {
  if (dyDelta > 0 && typeof p.maxTextY === "number" && p.y >= p.maxTextY - 1e-9) return true;
  if (dyDelta < 0 && typeof p.minTextY === "number" && p.y <= p.minTextY + 1e-9) return true;
  return false;
}

/**
 * 天井 (maxTextY) に固定されたラベルを起点に、それと水平方向に重なる下側ラベルを
 * 「下方向のみ」で順に押し下げ、固定クラスタ全体を分離する。
 *
 * 主パスの対称押しは固定ラベル相手だと分離量が半減し、残りの重なりが下隣のペアへ
 * 連鎖的に移動して threshold 直下で取りこぼされる。本パスは threshold を介さず、固定/確定済み
 * の上側ラベルを壁として下方向のみに押し下げるため、最上段は動かさずに確実に離せる。
 */
function settlePinnedClustersDownward(textPlacements: Placement[], cfg: PieLayoutConfig): void {
  const margin = 0.5 / (cfg.mmPerUnit * cfg.svgUnitsPerMm); // ≈0.5px の余白
  const anchored = new Set<number>();
  textPlacements.forEach((p, i) => {
    if (typeof p.maxTextY === "number" && p.y >= p.maxTextY - 1e-9) anchored.add(i);
  });
  if (anchored.size === 0) return;

  for (let iter = 0; iter < OVERLAP_MAX_ITER; iter += 1) {
    let anyMoved = false;
    // box top 降順 (上 → 下) で壁を上から確定させる。
    const order = textPlacements
      .map((_, i) => i)
      .sort((i, j) => placementBox(textPlacements[j], cfg).top - placementBox(textPlacements[i], cfg).top);
    for (const ai of order) {
      if (!anchored.has(ai)) continue; // 固定 or 確定済みの上側ラベルのみ壁にする
      const boxA = placementBox(textPlacements[ai], cfg);
      for (const bi of order) {
        if (bi === ai) continue;
        const b = textPlacements[bi];
        const boxB = placementBox(b, cfg);
        if (boxB.top >= boxA.top) continue; // b は a より下のみ対象
        const overlapX = Math.min(boxA.right, boxB.right) - Math.max(boxA.left, boxB.left);
        if (overlapX <= 0) continue;
        const overlapY = boxB.top - boxA.bottom; // >0 で縦に重なり
        if (overlapY <= margin) {
          anchored.add(bi); // 既に離れているが壁として確定
          continue;
        }
        b.y -= overlapY + margin; // 下方向のみ
        clampPlacement(b);
        anchored.add(bi);
        anyMoved = true;
      }
    }
    if (!anyMoved) break;
  }
}

/**
 * 全ラベルのテキスト位置を集めた後に、ペアごとのオーバーラップを検出して
 * 互いに反対方向へ押し離す。verify は vertical overlap >= OVERLAP_THRESHOLD_PX を
 * warning にするため、その閾値を超える対のみ対象。
 *
 * 主パス: bbox が strictly に重なるペアを bbox 中心ベクトル方向に分離。
 * Secondary パス: 横方向の隙間が OVERLAP_HORIZ_NEAR_GAP_PX 未満かつ縦に重なる
 * ペアを縦方向のみで分離する。
 *
 * クランプ考慮: 片方が canvas 端 (maxTextY/minTextY) に固定されていて押し離し方向へ
 * 動けない場合、対称半分割だと固定側の移動が clampPlacement で無効化され分離量が
 * 半減する。この場合は可動側へ分離量を全振りし、純縦方向に動かして確実に離す。
 */
export function resolveLabelOverlaps(textPlacements: Placement[], cfg: PieLayoutConfig): void {
  const thresholdLogical = OVERLAP_THRESHOLD_PX / (cfg.mmPerUnit * cfg.svgUnitsPerMm);

  for (let iter = 0; iter < OVERLAP_MAX_ITER; iter += 1) {
    let anyMoved = false;
    for (let i = 0; i < textPlacements.length; i += 1) {
      for (let j = i + 1; j < textPlacements.length; j += 1) {
        const a = textPlacements[i];
        const b = textPlacements[j];
        const ba = placementBox(a, cfg);
        const bb = placementBox(b, cfg);
        const { x: overlapX, y: overlapY } = boxOverlapAmount(ba, bb);
        if (overlapX <= 0 || overlapY <= 0) continue;
        if (overlapY < thresholdLogical) continue;

        const cax = (ba.left + ba.right) / 2;
        const cay = (ba.top + ba.bottom) / 2;
        const cbx = (bb.left + bb.right) / 2;
        const cby = (bb.top + bb.bottom) / 2;
        let dx = cbx - cax;
        let dy = cby - cay;
        const d = Math.hypot(dx, dy);
        if (d < 1e-9) {
          dx = 0;
          dy = 1;
        } else {
          dx /= d;
          dy /= d;
        }
        if (Math.abs(dy) < OVERLAP_DIAG_MIN_DY_NORM) {
          dx = 0;
          dy = dy >= 0 ? 1 : -1;
        }

        const needTotal = overlapY + 2e-4;
        // a の Y 変位は -dy*scale、b は +dy*scale 方向。
        const aBlocked = blockedInY(a, -dy);
        const bBlocked = blockedInY(b, dy);
        if (aBlocked && !bBlocked) {
          // a は固定 → b へ全振り (純縦)。
          b.y += (dy >= 0 ? 1 : -1) * needTotal;
        } else if (bBlocked && !aBlocked) {
          a.y += (dy >= 0 ? -1 : 1) * needTotal;
        } else {
          const pushScale = needTotal / 2 / Math.max(Math.abs(dy), 1e-6);
          a.x -= dx * pushScale;
          a.y -= dy * pushScale;
          b.x += dx * pushScale;
          b.y += dy * pushScale;
        }
        clampPlacement(a);
        clampPlacement(b);
        clampToAnchorSide(a);
        clampToAnchorSide(b);
        anyMoved = true;
      }
    }
    if (!anyMoved) break;
  }

  const visualHorizGap = OVERLAP_HORIZ_NEAR_GAP_PX / (cfg.mmPerUnit * cfg.svgUnitsPerMm);
  for (let iter = 0; iter < OVERLAP_MAX_ITER; iter += 1) {
    let anyMoved = false;
    for (let i = 0; i < textPlacements.length; i += 1) {
      for (let j = i + 1; j < textPlacements.length; j += 1) {
        const a = textPlacements[i];
        const b = textPlacements[j];
        const ba = placementBox(a, cfg);
        const bb = placementBox(b, cfg);
        const { x: overlapX, y: overlapY } = boxOverlapAmount(ba, bb);
        if (overlapX > 0) continue;
        if (overlapX + visualHorizGap <= 0) continue;
        if (overlapY < thresholdLogical) continue;

        const cay = (ba.top + ba.bottom) / 2;
        const cby = (bb.top + bb.bottom) / 2;
        const dy = cay >= cby ? 1 : -1;
        const needTotal = overlapY + 2e-4;
        // a の Y 変位は +dy*push、b は -dy*push 方向。
        const aBlocked = blockedInY(a, dy);
        const bBlocked = blockedInY(b, -dy);
        if (aBlocked && !bBlocked) {
          b.y -= dy * needTotal;
        } else if (bBlocked && !aBlocked) {
          a.y += dy * needTotal;
        } else {
          const push = needTotal / 2;
          a.y += dy * push;
          b.y -= dy * push;
        }
        clampPlacement(a);
        clampPlacement(b);
        clampToAnchorSide(a);
        clampToAnchorSide(b);
        anyMoved = true;
      }
    }
    if (!anyMoved) break;
  }

  // 3rd: 天井固定クラスタを下方向へ連鎖分離 (主/Secondary パスの取りこぼし救済)。
  settlePinnedClustersDownward(textPlacements, cfg);
}

// =============================================================================
// 2. compactify cascade — compactLabel 自動選択
// -----------------------------------------------------------------------------
// 6 ブロックの heuristic で items の compactLabel / forceFlipToRight /
// forceHorizontalLowerLeftDrop を破壊的に立てる。
//   1) 2 個 flipped pre-compact
//   2) forceLowerLeftCompactBand (LL 強制 1 行化 + horizontalLowerLeftDrop)
//   3) dense + 第3パス flip pre-compact
//   4) compactify ループ (上端 overflow / 2 個以上 flipped)
//   5) 2 個 flipped post-check (forceFlipToRight 付与 + 両方 compact 化)
//   6) 180° 寄り long の revert
// =============================================================================

export const COMPACT_CASCADE_MAX_ATTEMPTS = 10;

/** dense + 第3パス flip で pre-compact を発動する閾値 = oneSideVeryDenseThreshold + 1。 */
function denseUpperLeftPrecompactThreshold(cfg: PieLayoutConfig): number {
  return cfg.oneSideVeryDenseThreshold + 1;
}

/** 180° (水平 LEFT) 寄り long upper-left を非 compact に戻す境界。 */
const LEFT_HORIZON_LONG_COMPACT_REVERT_MIN_ANGLE_DEG = 180 - TOP_BAND_HALF_WIDTH_DEG;

/**
 * compactLabel 自動選択カスケード本体。items を破壊的に更新する。
 * options.compactLabel が明示されていない場合のみ呼び出し側で実行する。
 */
export function runCompactCascade(items: LayoutItem[], cfg: PieLayoutConfig): void {
  if (items.length <= 1) return;
  const maxAllowedY = cfg.canvasYlim[1] - cfg.canvasSafetyMargin;

  // ── 1) 2 個 flipped pre-compact ──
  {
    const probe = layoutLabels(items.map((it) => ({ ...it })), cfg);
    const flipped = probe.labels.filter((l: LayoutItem) => l.flipToRight);
    if (flipped.length === 2) {
      const sorted = [...flipped].sort((a: LayoutItem, b: LayoutItem) => a.anchorX! - b.anchorX!);
      const outer = sorted[0];
      const inner = sorted[1];
      const heights = sorted.map((item: LayoutItem) => estimateTextExtent(item, cfg).height);
      const rankStep = Math.max(0.14, cfg.scaledMinGap, Math.max(...heights) * 1.15);
      const textGapYApprox = radialFraction(cfg, radialFraction(cfg, 0.02, 0.35), 0.6);
      const maxTopY = cfg.canvasYlim[1] - textGapYApprox - cfg.canvasSafetyMargin;
      const innerRoom = maxTopY - inner.anchorY!;
      if (rankStep > innerRoom) {
        for (const lb of [outer, inner]) {
          const target = items.find((it) => it.name === lb.name);
          if (target && !target.compactLabel) target.compactLabel = true;
        }
      }
    }
  }

  // ── 1.5) 2 upper-left in narrow top band pre-compact ──
  // dominant が大半を占め、2 つの極小スライスが共に 12 時直近 (angle within ±8° of 90°) に
  // 並ぶ場合、両方とも 12 時直左の upper-left 経路にルーティングされ、内側 (angle≈90°) が
  // canvas 上端で maxTextY clamp、外側が pie clearance に押し上げられて 2 行 bbox が重なる。
  // 両方を 1 行 (compactLabel=true) にして bbox 高さを半減させ clean separation を確保。
  // narrow gate (cluster 中心 ±8° + total UL===2) で他ケースへの副作用を防ぐ。
  {
    const probe = layoutLabels(items.map((it) => ({ ...it })), cfg);
    const NARROW_TOP_BAND_DEG = 8;
    const topBandUL = probe.labels.filter((l: LayoutItem) => {
      const a = normalizeAngle(l.midAngle!);
      return l.isUpperLeft && !l.flipToRight && angleInBand(a, 90, NARROW_TOP_BAND_DEG);
    });
    if (topBandUL.length === 2 && topBandUL.every((l: LayoutItem) => (l.textLines ?? 2) >= 2)) {
      for (const lb of topBandUL) {
        const target = items.find((it) => it.name === lb.name);
        if (target && !target.compactLabel) target.compactLabel = true;
      }
    }
  }

  // ── 2) forceLowerLeftCompactBand ──
  const denseDominantProbe = layoutLabels(items, cfg);
  if (denseDominantProbe.diagnostics?.forceLowerLeftCompactBand) {
    const horizontalAnchorYBound = pieHorizontalLowerLeftAnchorYBound(cfg);
    const deepLLBoundary = lowerLeftDeepBoundaryY(cfg);
    const lowerLeftSiblings = denseDominantProbe.labels.filter(
      (l: LayoutItem) =>
        l.side === "left" &&
        !l.isUpperLeft &&
        !l.flipToRight &&
        l.anchorY! < horizontalAnchorYBound &&
        (l.percent ?? 0) < 50,
    );
    for (const lb of lowerLeftSiblings) {
      const target = items.find((it) => it.name === lb.name);
      if (target && !target.compactLabel) target.compactLabel = true;
      if (target && lb.anchorY! >= deepLLBoundary) {
        target.forceHorizontalLowerLeftDrop = true;
      }
    }
  }

  // ── 3) dense + 第3パス flip pre-compact ──
  const denseFlipProbe = layoutLabels(items, cfg);
  const denseUpperLeftCount = denseFlipProbe.labels.filter((l: LayoutItem) => l.isUpperLeft).length;
  if (
    denseFlipProbe.diagnostics?.modeTags?.includes("upper_left_small_dense") &&
    !denseFlipProbe.diagnostics.keepUpperLeft2Lines &&
    denseUpperLeftCount >= denseUpperLeftPrecompactThreshold(cfg)
  ) {
    const allFlipped = denseFlipProbe.labels.filter((l: LayoutItem) => l.flipToRight);
    for (const lb of allFlipped) {
      const target = items.find((it) => it.name === lb.name);
      if (target && !target.compactLabel) target.compactLabel = true;
    }
  }

  // ── 4) compactify ループ ──
  for (let attempt = 0; attempt < COMPACT_CASCADE_MAX_ATTEMPTS; attempt += 1) {
    const probe = layoutLabels(items, cfg);
    const upperLeft = probe.labels.filter(
      (l: LayoutItem) => l.isUpperLeft && !l.flipToRight && (l.percent ?? 0) < 50,
    );
    if (upperLeft.length === 0) break;
    const overflowing = upperLeft.find((l: LayoutItem) => {
      const heightLogical = labelHeightUnits(l.textLines ?? 2, cfg);
      return (l.upperLeftRenderY ?? 0) + heightLogical + cfg.cornerGap > maxAllowedY;
    });
    const flippedCount = probe.labels.filter((l: LayoutItem) => l.flipToRight).length;
    const tooManyFlipped = flippedCount >= 2;
    if (!overflowing && !tooManyFlipped) break;
    const candidates = upperLeft.filter((l: LayoutItem) => {
      if (l.compactLabel) return false;
      if (probe.diagnostics?.keepUpperLeft2Lines) return false;
      if (overflowing && overflowing.name === l.name) return true;
      const compactLine = `${l.name} ${l.percentText ?? ""}`;
      const compactWidthLogical = visualTextWidthUnits([compactLine], cfg);
      const distanceLogical =
        l.side === "left"
          ? l.anchorX! - cfg.canvasXlim[0] - cfg.scaledRadialExitLen - cfg.cornerGap
          : cfg.canvasXlim[1] - l.anchorX! - cfg.scaledRadialExitLen - cfg.cornerGap;
      return compactWidthLogical <= distanceLogical;
    });
    if (candidates.length === 0) break;
    const topmost = candidates.reduce((best, cur) =>
      cur.anchorY > best.anchorY ? cur : best,
    );
    const target = items.find((it) => it.name === topmost.name);
    if (!target || target.compactLabel) break;
    target.compactLabel = true;
  }

  // ── 5) 2 個 flipped post-check (forceFlipToRight + 両方 compact 化) ──
  {
    const probe = layoutLabels(items, cfg);
    const flipped = probe.labels.filter((l: LayoutItem) => l.flipToRight);
    if (
      flipped.length === 2 &&
      flipped.some((l: LayoutItem) => !l.compactLabel) &&
      !probe.diagnostics?.keepUpperLeft2Lines
    ) {
      for (const lb of flipped) {
        const target = items.find((it) => it.name === lb.name);
        if (target) {
          if (!target.compactLabel) target.compactLabel = true;
          target.forceFlipToRight = true;
        }
      }
    }
  }

  // ── 6) 180° 寄り long の revert ──
  {
    const probe = layoutLabels(items, cfg);
    for (const l of probe.labels) {
      const ang = normalizeAngle(l.midAngle!);
      if (
        l.isUpperLeft &&
        !l.flipToRight &&
        l.compactLabel &&
        l.isLong &&
        ang >= LEFT_HORIZON_LONG_COMPACT_REVERT_MIN_ANGLE_DEG
      ) {
        const target = items.find((it) => it.name === l.name);
        if (target && target.compactLabel) {
          target.compactLabel = false;
        }
      }
    }
  }

}

// =============================================================================
// 3. visual viewBox nudge — 最終 nudge (resolveLabelOverlaps の検出漏れを吸収)
// -----------------------------------------------------------------------------
// 視覚 bbox (全角=1.0em / 半角=0.5em 想定) が viewBox 左右からはみ出している
// ラベルを、その分だけ内側へ平行移動する。円内侵入を防ぐため、bbox 右端
// (左サイド) / 左端 (右サイド) が pie 境界を超えない範囲でのみ shift する。
// =============================================================================

export function applyVisualViewBoxNudge(textPlacements: Placement[], cfg: PieLayoutConfig): void {
  for (const placement of textPlacements) {
    if (placement.insideSlice) continue;
    const overflow = detectVisualHorizontalOverflow(placement, cfg);
    if (!overflow.overflow) continue;
    // compact 1 行ラベルは対象外 (元々狭い区間に詰め込まれており nudge で leader と干渉しやすい)。
    if ((placement.item.textLines ?? 2) <= 1 || placement.item.compactLabel) continue;
    const lines = placement.lines;
    const widthLogical = visualTextWidthUnits(lines, cfg);
    const heightLogical = labelHeightUnits(placement.item.textLines ?? 2, cfg);
    const box = textBoxBounds(
      placement.x,
      placement.y,
      { width: widthLogical, height: heightLogical },
      placement.anchor,
      placement.baseline,
    );
    const bboxLeft = box.left;
    const bboxRight = box.right;
    const bboxTop = box.top;
    const bboxBottom = box.bottom;
    let closestPieY = 0;
    if (bboxBottom > cfg.pieRadius) closestPieY = bboxBottom;
    else if (bboxTop < -cfg.pieRadius) closestPieY = bboxTop;
    else closestPieY = Math.abs(bboxTop) < Math.abs(bboxBottom) ? bboxTop : bboxBottom;
    const pieClearance = Math.max(cfg.pieLabelClearance, radialFraction(cfg, 0.01, 0.1));
    const safety = cfg.canvasSafetyMargin;
    if (overflow.side === "left") {
      let shift = cfg.canvasXlim[0] + safety - bboxLeft;
      if (shift > 0) {
        if (Math.abs(closestPieY) < cfg.pieRadius) {
          const pieLeftX = -pieYAtX(closestPieY, cfg) - pieClearance;
          const maxBboxRight = pieLeftX;
          const maxShift = maxBboxRight - bboxRight;
          shift = Math.min(shift, Math.max(0, maxShift));
        }
        placement.x += shift;
        clampToAnchorSide(placement);
      }
    } else if (overflow.side === "right") {
      let shift = bboxRight - (cfg.canvasXlim[1] - safety);
      if (shift > 0) {
        if (Math.abs(closestPieY) < cfg.pieRadius) {
          const pieRightX = pieYAtX(closestPieY, cfg) + pieClearance;
          const minBboxLeft = pieRightX;
          const maxShift = bboxLeft - minBboxLeft;
          shift = Math.min(shift, Math.max(0, maxShift));
        }
        placement.x -= shift;
        clampToAnchorSide(placement);
      }
    }
  }
}

/** condense-to-fit の下限 sx (可読性のためこれ以上は縮めない)。 */
export const FINAL_CONDENSE_MIN_SCALE = 0.7;

/**
 * 最終手段: viewBox (canvasXlim) をはみ出す外側ラベルを「収まるまで名前を長体化」して縮める。
 * アンカー (pie 側の辺: 左=end / 右=start / middle) は固定なので、縮めると far edge のみが
 * 内側へ動き pie 側へは寄らない → pie 侵入・新規重なりを生まない (縮むだけなので overlap は
 * 減りこそすれ増えない)。可読性のため sx は FINAL_CONDENSE_MIN_SCALE で打ち止めとし、それでも
 * 収まらない残件は console.warn で記録する (無音切り詰め回避)。
 * placement.nameScaleX は render (index.ts の condense) と verify (data-name-scale-x) の双方が
 * honor 済なので、値を下げるだけで描画・検証が一致する。
 */
export function applyFinalCondenseToFit(textPlacements: Placement[], cfg: PieLayoutConfig): void {
  const [xmin, xmax] = cfg.canvasXlim;
  const tol = 1 / (cfg.svgUnitsPerMm * cfg.mmPerUnit + 1e-9);
  const fits = (p: Placement): boolean => {
    const b = placementBox(p, cfg);
    return b.left >= xmin - tol && b.right <= xmax + tol;
  };
  for (const placement of textPlacements) {
    if (placement.insideSlice) continue;
    if (fits(placement)) continue;
    let sx = placement.nameScaleX ?? 1;
    let fitted = false;
    while (sx - 0.025 >= FINAL_CONDENSE_MIN_SCALE - 1e-9) {
      sx = Math.round((sx - 0.025) * 1000) / 1000;
      placement.nameScaleX = sx;
      if (fits(placement)) {
        fitted = true;
        break;
      }
    }
    if (!fitted) {
      // 下限でも収まらない構造的ケース (極端な長カタカナ / 支配スライス右端)。
      // 下限を適用しつつ残件を記録する。
      placement.nameScaleX = FINAL_CONDENSE_MIN_SCALE;
      const box = placementBox(placement, cfg);
      const overUnits = Math.max(xmin - box.left, box.right - xmax);
      const overPx = Math.round(overUnits * cfg.pxPerUnit);
      console.warn(
        `[svg_export] condense-to-fit 下限(${FINAL_CONDENSE_MIN_SCALE})でも viewBox に収まらず: ` +
          `"${placement.item.name}" 残り約 ${overPx}px`,
      );
    }
  }
}

/**
 * 長体 (nameScaleX < 1) になった外側ラベルを「キャンバスに収まる範囲で原寸へ向けて」緩和し、
 * ラベルごとにギリギリ収まる最大サイズ (上限 sx=1 = デフォルトの大きさ) にする。旧来の
 * 「1 つでも長体なら全ラベルを統一圧縮」方針の置き換えで、収まるラベルは原寸のまま・
 * はみ出すラベルだけ必要最小限の長体に落ち着く。
 *
 * 候補へラウンドロビンで +0.025 ずつ与える (逐次貪欲だと配列先頭が共有空間を独占するため)。
 * 1 ステップの採用条件 (満たさなければ revert):
 *   (a) canvas fit — placementBox が canvasXlim 内 (±tol)。例外: box 幅が変わらないステップ
 *       (% 行が幅を支配する短い名前) は常に許可 — 箱が不変なので clips/重なり/採点に一切影響
 *       しない (構造的はみ出しの dominant rim ラベルでも名前だけ原寸へ戻せる)
 *   (b) pie 非侵入 — box の原点最近接距離が pieRadius+clearance 以上、または広げる前より
 *       近づいていない (anchor=start/end は pie 側辺固定で自明に通る。middle 用のガード)
 *   (c) 重なり非悪化 — 縦に重なる他 box との横交差量が広げる前から増えない
 * (a)(c) により countDefects (clips / overlap / crossings / pie) は構造的に非増加 = do-no-harm。
 * 内側スライスラベルは wedge フィットが制約 (computeInsideOptions が sx=1 を先に試す
 * per-label 最小長体) なので対象外。scorer (finalizeForScoring) と emit が同一スロットで
 * 共有し、verify_consistency の scorer ↔ emit 一致を保つ。
 */
export function relaxNameCondense(textPlacements: Placement[], cfg: PieLayoutConfig): void {
  const [xmin, xmax] = cfg.canvasXlim;
  const tol = 1 / (cfg.svgUnitsPerMm * cfg.mmPerUnit + 1e-9); // ≈ 1 SVG px (condense-to-fit と同じ)
  const STEP = 0.025; // applyFinalCondenseToFit と同じ格子
  const pieClearance = Math.max(cfg.pieLabelClearance, radialFraction(cfg, 0.01, 0.1));
  const distToPie = (b: { left: number; right: number; top: number; bottom: number }): number => {
    const nx = Math.max(b.left, Math.min(0, b.right));
    const ny = Math.max(b.bottom, Math.min(0, b.top));
    return Math.hypot(nx, ny);
  };
  const candidates = textPlacements.filter(
    (p) => !p.insideSlice && (p.nameScaleX ?? 1) < 1 - 1e-9,
  );
  if (candidates.length === 0) return;

  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const p of candidates) {
      const cur = p.nameScaleX ?? 1;
      if (cur >= 1 - 1e-9) continue;
      const beforeBox = placementBox(p, cfg);
      const beforePieDist = distToPie(beforeBox);
      p.nameScaleX = Math.min(1, Math.round((cur + STEP) * 1000) / 1000);
      const box = placementBox(p, cfg);
      let ok =
        (box.left >= xmin - tol && box.right <= xmax + tol) ||
        box.right - box.left <= beforeBox.right - beforeBox.left + 1e-9;
      if (ok) {
        const d = distToPie(box);
        ok = d >= cfg.pieRadius + pieClearance - 1e-9 || d >= beforePieDist - 1e-9;
      }
      if (ok) {
        for (const q of textPlacements) {
          if (q === p) continue;
          const b = placementBox(q, cfg);
          const oy = Math.min(box.top, b.top) - Math.max(box.bottom, b.bottom);
          if (oy <= 0) continue;
          const oxAfter = Math.min(box.right, b.right) - Math.max(box.left, b.left);
          const oxBefore = Math.min(beforeBox.right, b.right) - Math.max(beforeBox.left, b.left);
          if (oxAfter > Math.max(oxBefore, 0) + 1e-9) {
            ok = false;
            break;
          }
        }
      }
      if (ok) progressed = true;
      else p.nameScaleX = cur;
    }
  }
}

