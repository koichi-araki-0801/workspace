// =============================================================================
// svg_export/index.ts — renderPdfStylePieToSvg (public API, orchestrator)
// -----------------------------------------------------------------------------
// 入力 items → 最終 SVG 文字列を組み立てる本ライブラリの最終出力点。
// サブモジュールの責務:
//   - rendering.ts   : 座標変換 + スライス path + text 要素 + 視覚 em 推定
//   - post_layout.ts : overlap 解消 / compactify cascade / 半角カナ fallback /
//                      視覚 viewBox nudge
//   - emit_repair.ts : emit 修復パス列 (EMIT_REPAIR_PASSES) + 採点・計測・do-no-harm ゲート基盤
//   - font.ts        : フォントサブセット埋込 (TTF → WOFF2)
// =============================================================================

import { createPieLayoutConfig, makeColors } from '../config.js';
import { normalizeInputItems } from '../data.js';
import { layoutLabels } from '../layout.js';
import {
  normalizeAngle,
  angleInBand,
  estimateTextExtent,
  estimateVerifyTextExtent,
  nudgeTextAwayFromPie,
  pieClearanceWithinViewBox,
  pieYAtX,
  placementBox,
  placementExtent,
  leaderCrossesBox,
  radialFraction,
  degToRad,
  upperLeftBendPoint,
  labelCongestionOffsetDeg,
  isOtherCategory,
  boxOverlapAmount,
  pxToLogical,
} from '../svg_geom.js';
import {
  leaderPath,
  computeInsideOptions,
  outsideFormForRank,
  buildInsideDraft,
  buildOutsideRimDraft,
  buildOutsideLeaderDraft,
  buildLowerLeftDropLeaderDraft,
  finalizePlacement,
  TOP_BAND_HALF_WIDTH_DEG,
  BOTTOM_BAND_HALF_WIDTH_DEG,
  topBandSonohokaZone,
} from '../label_placement.js';
import type { InsideOption } from '../label_placement.js';
import type {
  PieLayoutConfig,
  RenderResult,
  LayoutItem,
  LayoutItemReady,
  LayoutResult,
  Diagnostics,
  Placement,
} from '../types.js';

import {
  createCoordinateSystem,
  buildSlicePath,
  computeArcs,
  escapeXml,
  textFragment,
} from './rendering.js';
import {
  resolveLabelOverlaps,
  clampPlacement,
  POST_LAYOUT_PASS_COUNT,
  runCompactCascade,
  applyVisualViewBoxNudge,
  applyFinalCondenseToFit,
  relaxNameCondense,
  FINAL_CONDENSE_MIN_SCALE,
  blockedInY,
} from './post_layout.js';
import { buildFontFaceDefs } from './font.js';
import {
  ALWAYS_DRAW_OUTSIDE_LEADERS,
  computeDrawnLeader,
  qualifiesTopCenterAttach,
  qualifiesSideEdgeCenterAttach,
  isRedundantUpperLeftSmallLeader,
  isRedundantDominantRimLeader,
  resolveLeaderCrossings,
  distPointToSegment,
  pathsCross,
  realLeaderPaths,
  countLeaderCrossings,
  countLeaderThroughLabels,
  leaderThroughPairs,
  leaderCrossingPairs,
  countBundledRimStubs,
  boxOverlapMax,
  boxPieIntrusionMax,
  boxViewOverflowOf,
  boxViewOverflowMax,
  projectBoxesToPixels,
  oobLeaderCount,
  countAngularDiscordantPairs,
  LEADER_MAX_ANGULAR_DIFF_RAD,
} from './leader_geometry.js';
import type { Pt, Coord } from './leader_geometry.js';
// 採点・計測ゲート・emit 修復列は emit_repair.ts へ集約 (循環 import だが関数宣言のみ参照で安全)。
import {
  VIEW_OVERFLOW_CAP_PX,
  applyEmitRepairPasses,
  applyOutsideLeaderAngularOrder,
  captureEmitDefectVec,
  countDefects,
  countVerifyIssues,
  countVerifyIssuesDetailed,
  emitDefectsWorsened,
  enforceFinalPieClearance,
  finalizeForScoring,
  gateNotWorseExceptClips,
  hasNewPair,
  logicalYAtViewBoxYPx,
  measureDefectGate,
  measureRepairVec,
  overlapsOf,
  placementPixelRect,
  repairResidualLeaderDefects,
  seamRestore,
  seamSnapshot,
  tryMoveWithGuard,
  trySeamMutation,
} from './emit_repair.js';
import type { DefectCounts, SeamSnap } from './emit_repair.js';

export { escapeXml } from './rendering.js';
export { distPointToSegment, pathsCross } from './leader_geometry.js';

// twoLineLeftStackMode の左列ラベルを円縁 (rim) からどれだけ外側へ離すかの mid-angle 放射係数。
// 1.0 で円ハグ (旧)。参考 PDF はラベルと円の間に ~0.3R の隙間を空け、リーダー線が長い斜め線として
// 明確に見える。anchor は rim のまま (この係数は box 位置のみに効く) なので、リーダーは rim→box の
// 長い斜め直線になる。円侵入は起きないため verify/スコアラへの影響はない。
const TWO_LINE_LEFT_OUT_FACTOR = 1.28;
// 12時シーム (midAngle≈90) 近傍に密集する小スライスを「右上へ逃がす」対象とみなす帯の半幅。
// escapeTopBandSeamLeader が使う (9時版 NINE_OCLOCK_ESCAPE と対になるトップバンド版)。
const TOP_SEAM_ESCAPE_HALF_WIDTH_DEG = 32;
const TOP_BAND_RIGHT_ANGLE_MIN_DEG = 90 - TOP_BAND_HALF_WIDTH_DEG;
const TOP_BAND_RIGHT_ANGLE_MAX_DEG = 90;

// =============================================================================
// 統一カスケード (①〜⑨) — leader は最終手段、ラベルは円の近くに
// -----------------------------------------------------------------------------
// rank: ①2行内 ②2行外 ③2行長体内 ④2行長体外 ⑤1行内 ⑥1行外 ⑦1行長体内
//       ⑧1行長体外 ⑨最終手段(外側リングへ逃がし leader 可)。内側{1,3,5,7}は各ラベル
//       独立 (wedge フィット)、外側{2,4,6,8}は rim 配置 + 全ラベル横断の overlap/pie
//       nudge に依存。失敗ラベルを 1 段ずつ降格させて収束させる。
// =============================================================================
const CASCADE_INSIDE_RANKS = new Set([1, 3, 5, 7]);
const CASCADE_MAX_ITER = 10;

// `restackLiftedIfOverlapping` の部分適用の刻み数。必要量の 1/N ずつ浅くしながら「円に当たらない
// 最大の降下量」を採る。冠直下は円の幅が急に広がるため、刻みを細かくしても得られる余地は僅か。
const RESTACK_DROP_STEPS = 8;

interface CascadeState {
  item: LayoutItemReady;
  insideOpts: Record<number, InsideOption | null>;
  rank: number;
  placement: Placement;
}

/** state の現在 rank に対応する Placement を生成 (inside は wedge 中心 / 外側は rim / ⑨は外側リング)。 */
function buildPlacementForRank(
  item: LayoutItemReady,
  cfg: PieLayoutConfig,
  insideOpts: Record<number, InsideOption | null>,
  rank: number,
): Placement {
  if (CASCADE_INSIDE_RANKS.has(rank)) {
    const opt = insideOpts[rank];
    if (opt) {
      return finalizePlacement(item, cfg, buildInsideDraft(opt.form, opt.fit), opt.form)
        .textPlacement;
    }
  }
  const form = outsideFormForRank(item, cfg, rank);
  const draft =
    rank >= 9 ? buildOutsideLeaderDraft(item, cfg, form) : buildOutsideRimDraft(item, cfg, form);
  return finalizePlacement(item, cfg, draft, form).textPlacement;
}

/** 現 rank から次に試す rank を返す。不可能な inside rank はスキップ。8 を超えたら 9(最終手段)。 */
function nextCascadeRank(state: CascadeState): number {
  let r = state.rank + 1;
  while (r <= 8) {
    if (CASCADE_INSIDE_RANKS.has(r)) {
      if (state.insideOpts[r]) return r;
      r += 1;
    } else {
      return r;
    }
  }
  return 9;
}

/** 外側 placement が「失敗」か (= viewBox はみ出し / pie 侵入 / 他ラベルと閾値以上重なり)。 */
function isCascadeFailed(placement: Placement, others: Placement[], cfg: PieLayoutConfig): boolean {
  const px = (n: number) => pxToLogical(cfg, n);
  const vboxTol = px(2);
  const overlapTol = px(8);
  const box = placementBox(placement, cfg);
  // dominant outside-edge は rim 配置 (anchor が pieRadius=1.0) のため canvasXlim の
  // 内側 (marginCapHorizontal を引いた可動域) では幅 7em 級のラベルが入らない。verify が
  // 不具合として扱う境界は実 viewBox (svgWidthPx) なので、dominant outside-edge に限り
  // 横方向の判定を svgWidthPx 基準に緩める。これにより rank 4 (2行 0.7 長体) が rim で
  // 採用されるようになり、1行で右端から見切れる症状が解消する。
  let xmin: number;
  let xmax: number;
  if (placement.dominantOutsideEdge) {
    const halfSvgWidthLogical = cfg.svgWidthPx / 2 / cfg.pxPerUnit;
    xmin = -halfSvgWidthLogical;
    xmax = halfSvgWidthLogical;
  } else {
    [xmin, xmax] = cfg.canvasXlim;
  }
  const [ymin, ymax] = cfg.canvasYlim;
  if (box.left < xmin - vboxTol || box.right > xmax + vboxTol) return true;
  if (box.bottom < ymin - vboxTol || box.top > ymax + vboxTol) return true;
  const nearX = Math.max(box.left, Math.min(box.right, 0));
  const nearY = Math.max(box.bottom, Math.min(box.top, 0));
  if (Math.hypot(nearX, nearY) < cfg.pieRadius - vboxTol) return true;
  for (const q of others) {
    if (q === placement) continue;
    const b = placementBox(q, cfg);
    const { x: ox, y: oy } = boxOverlapAmount(box, b);
    if (ox > overlapTol && oy > overlapTol) return true;
  }
  return false;
}

// leader 折れ線の幾何プリミティブ (`computeDrawnLeader` / `isRedundantUpperLeftSmallLeader` /
// `resolveLeaderCrossings` / `distPointToSegment`) と型 `Pt` / `Coord` は `./leader_geometry.js` へ分離した。
/** `leftStackMode` の左列とみなす placement (side=left・baseline=bottom・非 inside・x<0)。 */
function isLeftStackMember(p: Placement): boolean {
  return p.item.side === 'left' && p.baseline === 'bottom' && !p.insideSlice && p.x < 0;
}

/** twoLineLeftStackMode の左列メンバ (上部「その他」・真下中央・flip・inside を除く左側外側ラベル)。 */
function twoLineLeftColumnMembers(placements: Placement[]): Placement[] {
  return placements.filter(
    (p) =>
      p.item.side === 'left' &&
      !p.insideSlice &&
      !p.item.flipToRight &&
      !p.item.flipToLeft &&
      !p.item.bottomCenterBelow &&
      topBandSonohokaZone(p.item) === null &&
      !isOtherCategory(p.item.name),
  );
}

/**
 * twoLineLeftStackMode 専用の左列パッカ。片側に外側ラベルが多数 (>=6) 寄る過密チャートで、
 * 左列を全 2 行のまま「角度順 (上→下) に円縁へ寄せた縦 1 列」へ再配置する。参考 PDF が左 7 ラベルを
 * 全 2 行・密ピッチで縦積みする見た目を再現する。
 *
 * 通常カスケードは縦クランプを scaledLabelRadius に縛り (X 公式 x=√(r²−y²) と連動)、7 件 2 行が
 * 入りきらず 1 件を 1 行へ降格させて左端見切れを起こす。本パッカは:
 *   - X: 各ラベルを自身の slice 中心角の rim (cos·pieRadius, anchor=end) へ置き円へハグ。実際の
 *     円クリアランスは clampPlacement(pieClearance 動的) が現在 y で保証する。
 *   - Y: canvas 全高 (canvasYlim) を使い角度順に密ピッチで均等配置 (scaledLabelRadius 制約を外す)。
 * メンバが <6 のチャートには影響しない (gate と二重の安全)。
 */
function applyTwoLineLeftColumn(placements: Placement[], cfg: PieLayoutConfig): void {
  const members = twoLineLeftColumnMembers(placements);
  if (members.length < 6) return;
  // 角度順 (上→下 = sin 降順)。
  members.sort(
    (a, b) => Math.sin(degToRad(b.item.midAngle ?? 0)) - Math.sin(degToRad(a.item.midAngle ?? 0)),
  );
  // X: mid-angle 放射方向に rim から TWO_LINE_LEFT_OUT_FACTOR 倍だけ外へ離す。参考 PDF のように
  // ラベルと円の間に隙間を空け、rim→box の斜めリーダーを見えるようにする。anchor=end のまま。
  // 円から離す方向なので円侵入は起きない (clampPlacement の左端クランプは長名でのみ効く)。
  for (const p of members) {
    p.x = Math.cos(degToRad(p.item.midAngle ?? 0)) * cfg.pieRadius * TWO_LINE_LEFT_OUT_FACTOR;
  }
  const heights = members.map((p) => {
    const b = placementBox(p, cfg);
    return b.top - b.bottom;
  });
  const sumH = heights.reduce((s, h) => s + h, 0);
  const safety = cfg.canvasSafetyMargin;
  const yHi = cfg.canvasYlim[1] - safety;
  const yLo = cfg.canvasYlim[0] + safety;
  const range = yHi - yLo;
  const n = members.length;
  // 残り高さを等ギャップに割る (scaledMinGap を上限、収まらなければ詰める)。
  const gap = n > 1 ? Math.max(0, Math.min(cfg.scaledMinGap, (range - sumH) / (n - 1))) : 0;
  const colH = sumH + gap * (n - 1);
  // 列の縦中心は「メンバの自然アンカー中心 (sin·pieRadius の平均)」へ寄せる。参考 PDF のように
  // 列がスライス群の中心高さへ沿い、上下端ラベルのスタブが短くなる。canvas 上下限へはクランプ。
  const anchorMidY =
    members.reduce((s, p) => s + Math.sin(degToRad(p.item.midAngle ?? 0)) * cfg.pieRadius, 0) / n;
  let topEdge = anchorMidY + colH / 2;
  topEdge = Math.min(yHi, Math.max(yLo + colH, topEdge));
  for (let i = 0; i < n; i += 1) {
    const p = members[i];
    const h = heights[i];
    const b = placementBox(p, cfg);
    const curCenter = (b.top + b.bottom) / 2;
    // baseline (top/bottom) と y の関係を保つため、現在の y−中心オフセットを維持して中心を移す。
    const offset = p.y - curCenter;
    const targetCenter = topEdge - h / 2;
    p.y = targetCenter + offset;
    topEdge = targetCenter - h / 2 - gap;
    // 円から離した左列ラベルは canvasXlim (端マージン 67.5px) ではなく viewBox 端まで使えるよう
    // フラグを立てる (後段 applyVisualViewBoxNudge / condense が円側へ引き戻さないように)。
    p.twoLineLeftColumn = true;
    clampPlacement(p, cfg);
    // leader を rim 縮退形へ正規化: bend==endpoint==(現在の x,y) かつ
    // leaderBendFollows* を解除する。これで computeDrawnLeader は draft 由来の L 字 (anchorX へ
    // 折り返す bendFollowsEndpointY) を作らず、イギリス/カナダと同じ「anchor→box 縁の直線斜め
    // スタブ」経路 (rim 縮退 → bend 畳み → truncate → 縮退スタブ除去で 2 点) に乗る。円を貫く
    // ケースは既存の円弦リルートが外へ曲げる。origText も現在位置へ更新し dx/dy=0 にする。
    p.origTextX = p.x;
    p.origTextY = p.y;
    p.leaderEndpoint = { x: p.x, y: p.y };
    p.leaderBend = { x: p.x, y: p.y };
    p.leaderBendFollowsEndpointY = false;
    p.leaderBendFollowsEndpointX = false;
  }
}

/**
 * leftStackMode 専用の順序保存 de-collision。汎用 resolveLabelOverlaps は箱中心ベクトル押しで
 * 密な左列の角度順を反転させる (例: 細い "カナダドル" が上へ catapult) ため、その左列だけを
 * 自然 rim Y (= 角度順に単調・最小変位) に再アンカーし、角度順 (上→下 = sin 降順) を保ったまま
 * 隣接間に必要ギャップを均等割りで確保する。X は不変 (各ラベル固有 rim anchor)。
 * naturalY は init 時点 (buildOutsideRimDraft の sin*r) の y を呼び出し側が捕捉して渡す。
 */
function spreadLeftStackByAngle(
  placements: Placement[],
  cfg: PieLayoutConfig,
  naturalY: Map<LayoutItemReady, number>,
): void {
  const stack = placements.filter(isLeftStackMember);
  if (stack.length < 4) return; // leftStackMode (upperLeftSmallCount>=4) 相当のみ
  // 自然 rim Y へ再アンカー (角度順に単調)。捕捉漏れは現 y を維持。
  for (const p of stack) {
    const ny = naturalY.get(p.item as LayoutItemReady);
    if (typeof ny === 'number') p.y = ny;
  }
  // 角度順 (上→下 = sin 降順)。
  const byAngle = [...stack].sort(
    (a, b) => Math.sin(degToRad(b.item.midAngle ?? 0)) - Math.sin(degToRad(a.item.midAngle ?? 0)),
  );
  const eps = 1e-6;
  for (let iter = 0; iter < 8; iter += 1) {
    let moved = false;
    for (let i = 0; i + 1 < byAngle.length; i += 1) {
      const u = byAngle[i]; // 上 (高 sin)
      const l = byAngle[i + 1]; // 下 (低 sin)
      const bu = placementBox(u, cfg);
      const need = bu.top - bu.bottom + cfg.scaledMinGap; // 上箱高 + gap = 必要な中心 (top) 間隔
      const cur = u.y - l.y; // baseline=bottom なので box.top=y。u.y>l.y を維持したい
      if (cur < need - eps) {
        const d = need - cur;
        // 上を上へ・下を下へ均等に分離 (角度順を保ったまま広げる)。clamp は clampPlacement が吸収。
        u.y += d / 2;
        l.y -= d / 2;
        clampPlacement(u);
        clampPlacement(l);
        moved = true;
      }
    }
    if (!moved) break;
  }
}

/**
 * `alignLeftStackToAnchors` の整え係数。
 *   EDGE_INSET_PX: viewBox 上下端からの内側マージン (px)。右上逃がしスタックの上端
 *     (`tidyTopRightEscapeeStack` の hardTop) と揃える。
 *   MIN_GAP_FRACTION: `scaledMinGap` に対する割合で 2 役を兼ねる: ①発火判定 — 隣接エアギャップの
 *     最小値がこれを下回る (= 箱がほぼ接触する) 列だけを整える。②整列後の最小エアギャップ (floor)。
 *     発火閾値と floor を同値にすることで、整列済みの列は再発火しない (冪等)。
 */
const LEFT_STACK_ALIGN_EDGE_INSET_PX = 4;
const LEFT_STACK_ALIGN_MIN_GAP_FRACTION = 0.25;

/**
 * leftStackMode の左列が接触級に詰まるとき、各ラベルの箱中心を**自スライスの rim 高さ
 * (sin(midAngle)·R)** へ寄せつつ最小エアギャップと viewBox 上下端だけを制約に再配置する
 * (`applyLeftStackGapClose` の広げる版)。X は mid-angle 放射方向に `TWO_LINE_LEFT_OUT_FACTOR` 倍
 * 離し、9時に近いラベルほど円から離れて斜めリーダーが見える (参考 PDF と同じ見せ方 —
 * `applyTwoLineLeftColumn` の X と同式)。
 *
 * 背景: 左列の積み上げ (`assignUpperLeftRenderY`) は天井超過時に圧縮する一方、収まっている時に
 * 余白へ広げる機構が無く、小スライス連続チャート (例 currency 系 10 スライス) では隣接箱が接触
 * したまま余白が残る。等間隔で縦全域へ展開する案は中段ラベルをスライスから引き離し、rim 沿いの
 * 長い近平行 leader (所属が読めない) を作ったためボツ — ラベルが自スライスの正面へ並べば leader
 * は短い放射スタブになり、間隔の粗密より判読性が勝る (ユーザー選定)。
 *
 * 手順: 箱中心の縦順 (上→下。p.y は baseline 向き混在で視覚順と食い違い得る) に、目標中心 =
 * 自スライス rim 高さから始め、隣接ペアの必要間隔 (箱高 + floor) と上下端を反復投影で満たす。
 * 目標列が角度順に単調なので投影後も角度順 (=値順) は保たれる。y は箱中心オフセット保存で移動し
 * baseline 向き差を吸収。円キャップより完全に上/下のラベルは X 現状維持 (rim が無い)。
 * 移動ラベルは skipLeader を解除し、leader は emit の描画段が最終 box から再計算して追従する。
 * do-no-harm: `emitDefectsWorsened` (一級 + through/cross 新規対 + inv) 悪化で全 revert。
 */
export function alignLeftStackToAnchors(
  placements: Placement[],
  cfg: PieLayoutConfig,
  coord: Coord,
): void {
  const boxCenterOf = (p: Placement): number => {
    const b = placementBox(p, cfg);
    return (b.top + b.bottom) / 2;
  };
  const stack = placements
    .filter(
      (p) =>
        p.item.side === 'left' &&
        !p.insideSlice &&
        !p.item.flipToRight &&
        !p.item.flipToLeft &&
        !p.item.topBandSmallRight &&
        p.x < 0,
    )
    .sort((a, b) => boxCenterOf(b) - boxCenterOf(a)); // 上 → 下 (箱中心の降順)
  const n = stack.length;
  if (n < 4) return;

  const boxes = stack.map((p) => placementBox(p, cfg));
  const heights = boxes.map((b) => b.top - b.bottom);
  let minAir = Number.POSITIVE_INFINITY;
  for (let i = 1; i < n; i += 1) minAir = Math.min(minAir, boxes[i - 1].bottom - boxes[i].top);
  if (minAir >= cfg.scaledMinGap * LEFT_STACK_ALIGN_MIN_GAP_FRACTION) return;

  const hardTop = logicalYAtViewBoxYPx(coord, LEFT_STACK_ALIGN_EDGE_INSET_PX);
  const hardBottom = logicalYAtViewBoxYPx(coord, cfg.svgHeightPx - LEFT_STACK_ALIGN_EDGE_INSET_PX);
  const sumH = heights.reduce((s, h) => s + h, 0);
  // floor は「発火閾値と同値」を上限に、列が上下端に収まらない場合は等分残余へ縮める。
  const gapFloor = Math.min(
    cfg.scaledMinGap * LEFT_STACK_ALIGN_MIN_GAP_FRACTION,
    (hardTop - hardBottom - sumH) / (n - 1),
  );
  const tol = pxToLogical(cfg, 1);
  if (gapFloor <= tol || gapFloor <= minAir + tol) return; // 広がらない再配分はしない

  const before = captureEmitDefectVec(placements, cfg, coord);
  const intrusionBefore = boxPieIntrusionMax(placements, cfg);
  const origX = stack.map((p) => p.x);
  const origY = stack.map((p) => p.y);
  const origSkip = stack.map((p) => Boolean(p.skipLeader));

  // 目標中心 = 自スライスの rim 高さ。隣接ペアの必要間隔 (箱高の半分ずつ + floor) と per-label の
  // 上下境界を反復投影で満たす (押し合いは対称に半分ずつ)。目標列が角度順に単調なので順序は保たれる。
  // 境界: 基本は viewBox 上下端。加えて、元 box が pie キャップの完全に上/下にあるラベルは移動後も
  // キャップを跨がせない — 天頂/底近くは mid-angle 放射の押し出しがほぼ横向きに効かず (cos≈0)、
  // 円の y 帯へ降りると nudge で逃がしきれず box が円内へ入る (実測退行: stress_top_cluster_8 の
  // "H 2.5%" が 21px 侵入)。
  const pieR = cfg.pieRadius;
  const c = stack.map((p) => Math.sin(degToRad(p.item.midAngle ?? 0)) * cfg.pieRadius);
  const eps = 1e-9;
  const minC = stack.map((_, i) =>
    boxes[i].bottom >= pieR - eps ? pieR + heights[i] / 2 : hardBottom + heights[i] / 2,
  );
  const maxC = stack.map((_, i) =>
    boxes[i].top <= -pieR + eps ? -pieR - heights[i] / 2 : hardTop - heights[i] / 2,
  );
  for (let iter = 0; iter < 200; iter += 1) {
    let moved = false;
    for (let i = 0; i + 1 < n; i += 1) {
      const need = (heights[i] + heights[i + 1]) / 2 + gapFloor;
      const cur = c[i] - c[i + 1];
      if (cur < need - eps) {
        const d = (need - cur) / 2;
        c[i] += d;
        c[i + 1] -= d;
        moved = true;
      }
    }
    for (let i = 0; i < n; i += 1) {
      if (c[i] < minC[i] - eps) {
        c[i] = minC[i];
        moved = true;
      } else if (c[i] > maxC[i] + eps) {
        c[i] = maxC[i];
        moved = true;
      }
    }
    if (!moved) break;
  }
  for (let i = 0; i < n; i += 1) {
    const p = stack[i];
    const h = heights[i];
    const newTop = c[i] + h / 2;
    const newBottom = newTop - h;
    // baseline (top/bottom) と y の関係を保つため、現在の y−箱中心オフセットを維持して中心を移す。
    const newY = p.y + ((newTop + newBottom) / 2 - (boxes[i].top + boxes[i].bottom) / 2);
    if (newBottom >= pieR || newTop <= -pieR) {
      // 円キャップより完全に上/下: rim が無いので X 現状維持。
      p.y = newY;
    } else {
      // mid-angle 放射方向へ TWO_LINE_LEFT_OUT_FACTOR 倍離す (9時に近いほど円から離れ、rim→box の
      // 斜めリーダーが見える)。pie クリアランスは nudge が現在 y で保証する。
      const measured = placementExtent(p, cfg);
      const outX = Math.cos(degToRad(p.item.midAngle ?? 0)) * pieR * TWO_LINE_LEFT_OUT_FACTOR;
      const nudged = nudgeTextAwayFromPie(outX, newY, p.anchor, p.baseline, measured, cfg);
      p.x = nudged.x;
      p.y = nudged.y;
    }
    // ⚠ どちらの枝でも `clampPlacement` は呼ばない: 静的 pie クランプ (scaledLabelRadius 基準) が
    // 極寄りの新 y でも旧位置相当まで x を左へ引き戻し、箱左端が viewBox を割る clips を新規に作る
    // (`tidyTopRightEscapeeStack` の stale minTextX と同型)。pie クリアランスは上の
    // `nudgeTextAwayFromPie` が現在 y で保証し、その他の悪化は下の do-no-harm ゲートが拾う。
    // 前段 gap-close が rim ハグ前提で立てた leader 抑制を解除 (縮退判定は leader 再計算が行う)。
    p.skipLeader = false;
  }

  // 二級の box 円侵入 (`countDefects` は数えない) も安全網として非増加を要求する。
  if (
    emitDefectsWorsened(before, placements, cfg, coord) ||
    boxPieIntrusionMax(placements, cfg) > intrusionBefore + tol
  ) {
    stack.forEach((p, i) => {
      p.x = origX[i];
      p.y = origY[i];
      p.skipLeader = origSkip[i];
    });
  }
}

/**
 * 全ラベルを①〜⑨カスケードで 1 回配置する。① が wedge に収まれば内側で確定、否なら②外側 rim
 * から始め、overlap/pie nudge を反復しつつ失敗ラベルを 1 段ずつ降格させて収束させる。
 * 上部「その他」を右上へ置くかは `item.topRightRejected` (`topBandSonohokaRight` が参照) で決まる。
 */
function runCascadeOnce(
  labels: LayoutItemReady[],
  cfg: PieLayoutConfig,
  spreadLeftStack = false,
): Placement[] {
  const states: CascadeState[] = labels.map((item) => {
    const insideOpts = computeInsideOptions(item, cfg);
    // forceOutsideLeader (1強+極小トップ2枚の遠い方) は rim leaderless で確定させず rank 9
    // (buildOutsideLeaderDraft) を起点にし、円頂上へ up-and-over leader を引かせる。
    // 左密集 (preferOneLineCascade) の item は 1 行 rank 起点 (内側1行 → 外側1行 rim)。
    // それ以外は 2 行 rank 起点 (内側2行 → 外側2行 rim)。
    const rank = item.forceOutsideLeader
      ? 9
      : item.preferOneLineCascade
        ? insideOpts[5]
          ? 5
          : 6
        : insideOpts[1]
          ? 1
          : 2;
    return {
      item,
      insideOpts,
      rank,
      placement: buildPlacementForRank(item, cfg, insideOpts, rank),
    };
  });
  // 左列の自然 rim Y を init 時点で捕捉 (順序保存 spread の再アンカー基準)。
  const naturalLeftStackY = new Map<LayoutItemReady, number>();
  for (const s of states) {
    if (isLeftStackMember(s.placement)) naturalLeftStackY.set(s.item, s.placement.y);
  }

  for (let iter = 0; iter < CASCADE_MAX_ITER; iter += 1) {
    const outside = states.filter((s) => !s.placement.insideSlice);
    const outsidePlacements = outside.map((s) => s.placement);
    for (let pass = 0; pass < POST_LAYOUT_PASS_COUNT; pass += 1) {
      resolveLabelOverlaps(outsidePlacements, cfg);
      // 左密集列は汎用 de-collision が角度順を壊すので、順序保存 spread で上書きする。
      if (spreadLeftStack) {
        spreadLeftStackByAngle(outsidePlacements, cfg, naturalLeftStackY);
      }
      for (const placement of outsidePlacements) {
        const verifyMeasured = placementExtent(placement, cfg);
        const pieNudged = nudgeTextAwayFromPie(
          placement.x,
          placement.y,
          placement.anchor,
          placement.baseline,
          verifyMeasured,
          cfg,
        );
        placement.x = pieNudged.x;
        placement.y = pieNudged.y;
        clampPlacement(placement);
      }
    }
    let changed = false;
    for (const s of outside) {
      if (s.rank >= 9) continue;
      if (isCascadeFailed(s.placement, outsidePlacements, cfg)) {
        let nr = nextCascadeRank(s);
        // useStackRimY (上左 triad の rim 重なり救済対象) は 2 行を維持する。1 行降格
        // (rank >= 5) を許さず rank 4 (2行長体) で打ち止め、viewBox はみ出し分は後段の
        // applyFinalCondenseToFit が名前長体で吸収する。9時付近の幅広上左ラベルが
        // 1 行化して左へ伸び見切れる症状を防ぐ。
        if ((s.item.useStackRimY || s.item.keepTwoLineLeftStack) && nr > 4) nr = s.rank;
        // bottomCenterBelow は 1行/長体 (rank 6/8) への降格は許すが rank 9 (leader) を禁止。
        // 真下中央 push-down は pie/viewBox を構造的にクリアするので leader 化は不要。
        if (s.item.bottomCenterBelow && nr > 8) nr = 8;
        if (nr !== s.rank) {
          s.rank = nr;
          s.placement = buildPlacementForRank(s.item, cfg, s.insideOpts, nr);
          changed = true;
        }
      }
    }
    if (!changed) break;
  }

  return states.map((s) => s.placement);
}

/**
 * 単行 (`lines.length===1`) の幅広ラベルを **標準2行** `[name, percent]` へ変換する (名前を語中で割らず
 * 数値行に名前文字が乗らない = 他ラベルと同形)。`nameScaleX` を 1 から下限
 * `FINAL_CONDENSE_MIN_SCALE`(0.7) まで 0.025 刻みで落として `canvasXlim` に収め、収まらなければ 0.7 で
 * 打ち切る (見切れ許容)。revert 用に変換前 `{lines, nameSplit, nameScaleX}` を返す。
 */
function toTwoLineNamePlacement(
  placement: Placement,
  cfg: PieLayoutConfig,
): { lines: string[]; nameSplit?: boolean; nameScaleX?: number } | null {
  if (placement.insideSlice || placement.nameSplit || placement.lines.length !== 1) return null;
  const snap = {
    lines: placement.lines,
    nameSplit: placement.nameSplit,
    nameScaleX: placement.nameScaleX,
  };
  placement.lines = [placement.item.name, placement.item.percentText ?? ''];
  placement.nameSplit = false;
  const [xmin, xmax] = cfg.canvasXlim;
  const tol = 1 / (cfg.svgUnitsPerMm * cfg.mmPerUnit + 1e-9);
  let sx = 1;
  placement.nameScaleX = 1;
  while (sx - 0.025 >= FINAL_CONDENSE_MIN_SCALE - 1e-9) {
    const b = placementBox(placement, cfg);
    if (b.left >= xmin - tol && b.right <= xmax + tol) break;
    sx = Math.round((sx - 0.025) * 1000) / 1000;
    placement.nameScaleX = sx;
  }
  return snap;
}

/** `toTwoLineNamePlacement` の snap で placement を変換前へ戻す。 */
function restoreTwoLineNamePlacement(
  placement: Placement,
  snap: { lines: string[]; nameSplit?: boolean; nameScaleX?: number },
): void {
  placement.lines = snap.lines;
  placement.nameSplit = snap.nameSplit;
  placement.nameScaleX = snap.nameScaleX;
}

/**
 * 標準 2 行フォールバック (emit 最終段, do-no-harm)。下限長体 (0.7) でも viewBox を見切れる 1 行ラベルを、
 * 名前を語中で割らない **標準 2 行** `[name, %]` (`toTwoLineNamePlacement`) へ変換する。名前行だけになって
 * 箱幅が縮むため、1 行 (名前+%) より見切れ px が減る。語割れ (旧 `splitLongName`) は pie-chart 全体で廃止した
 * ため、見切れる長名はこの 2 行化か、収まらなければ僅かな見切れで対応する (参考PDF「ニュージーランド・ドル」)。
 *
 * 全後段の後 (= 位置確定後) に走るのでゲートは最終配置を正しく評価する。採否は対象ラベル自身の見切れ px が
 * 厳密に減り、かつチャート全体の他不具合 (交差/leader円貫通/重なり/box円侵入) と clips 件数が非悪化の時だけ。
 * 見切れの無いチャートは `before.clips === 0` で即 return = baseline byte 不変。
 */
export function applyTwoLineNameFallback(
  placements: Placement[],
  cfg: PieLayoutConfig,
  coord: Coord,
): void {
  const { width, height } = coord;
  // 対象ラベルの viewBox 見切れ量 (px)。4 辺の超過の最大値。
  const clipPx = (p: Placement): number => {
    const b = placementPixelRect(p, cfg, coord);
    return Math.max(0, -1 - b.left, b.right - (width + 1), -1 - b.top, b.bottom - (height + 1));
  };

  let before = measureDefectGate(placements, cfg, coord);
  if (before.d.clips === 0) return;
  for (const p of placements) {
    if (p.insideSlice || p.nameSplit || p.lines.length !== 1) continue;
    const myClipBefore = clipPx(p);
    if (myClipBefore <= 0) continue; // 見切れていない 1 行はそのまま
    const snap = toTwoLineNamePlacement(p, cfg);
    if (!snap) continue;
    // 2 行化は箱が縦に伸び、下辺が pie 円へ食い込むことがある (クリアランス拡大で顕在化)。ゲートは
    // 食い込みを nudge で外した実 emit 相当の姿で判定する (却下時は幾何ごと戻す)。
    const geomSnap = { x: p.x, y: p.y };
    const nudged = nudgeTextAwayFromPie(
      p.x,
      p.y,
      p.anchor,
      p.baseline,
      placementExtent(p, cfg),
      cfg,
    );
    p.x = nudged.x;
    p.y = nudged.y;
    const after = measureDefectGate(placements, cfg, coord);
    // do-no-harm: 対象自身の見切れ px が厳密に減り、全体の他カテゴリ (clips件数/交差/円貫通/重なり/box円侵入)
    // が非悪化。2 行化は名前行のみで箱幅が縮むため自分の左右見切れは減るが、高さ増で別不具合を生むなら revert。
    // 例外: チャートの clips 件数が厳密に減る 2 行化に限り、軽微な box 重なり +1 件までは許す
    // (見切れ ≫ 重なり — `runLabelCascade` の keepTwoLineLeftStack ループと同じ辞書順方針)。クリアランス
    // 拡大で 2 行化の縦膨らみが隣とグレーズしやすくなり、見切れ完全解消 (currency_low_diff_10
    // シンガポールドル 21.6px→0) が重なり 1 件で却下されるのを防ぐ。交差/円貫通/box 円侵入/through は
    // この例外枝でも非悪化を要求する。
    const adopt =
      clipPx(p) < myClipBefore - 1e-9 &&
      after.d.clips <= before.d.clips &&
      (gateNotWorseExceptClips(after, before) ||
        (after.d.clips < before.d.clips &&
          after.d.crossings <= before.d.crossings &&
          after.d.pie <= before.d.pie &&
          after.pieBox <= before.pieBox &&
          after.through <= before.through &&
          overlapsOf(after.d) <= overlapsOf(before.d) + 1));
    if (adopt) {
      before = after;
    } else {
      restoreTwoLineNamePlacement(p, snap);
      p.x = geomSnap.x;
      p.y = geomSnap.y;
    }
  }
}

/**
 * 左側 near-equator 見切れラベルの縦 spread フォールバック (emit 最終段, do-no-harm)。
 * `post_layout.ts` の `applyVisualViewBoxNudge` は水平シフトのみで、円の縦中心付近
 * (`Math.abs(closestPieY) < cfg.pieRadius`) の左ラベルは左シフトが pie に頭打ちされ
 * (同関数の `pieLeftX` クランプ) viewBox 左端を見切れたまま残る。本パスは該当ラベルを円の縦中心から
 * 離す向き (中心より上は上・下は下) へ少しずつ動かし、その y で円が細る分だけ `applyVisualViewBoxNudge`
 * が横可動域を取り戻して見切れを解消する (左 rim X が `finalX = -sqrt(r^2 - y^2)` 由来で |y| が増える
 * ほど中心寄りになる幾何による)。同側の見切れラベルは equator 近接側から順に動かし、内側ラベルと
 * 重ならないよう外側へ追い出して縦に広げる。広げた結果 leader が長い斜線になり交差しうるので
 * `repairResidualLeaderDefects` (bend 再配置, do-no-harm) を掛けてから採否を判定する。採否は片側単位で
 * チャート全体 `countDefects` の do-no-harm ゲート (clips 厳密減・crossings/pie/重なり/box 円侵入 非悪化)
 * を満たす時だけ全件採用、満たさなければ全件 revert。`applyLowerLeftDropFallback` より先に走り、
 * 解消すれば後続は `before.clips === 0` で no-op。見切れの無い
 * チャートは早期 return で完全無変更 (= baseline byte 不変)。
 */
export function applyVerticalDeclipFallback(
  placements: Placement[],
  cfg: PieLayoutConfig,
  coord: Coord,
): void {
  const { xScale } = coord;
  const pieRpx = Math.abs(xScale(cfg.pieRadius) - xScale(0));
  const clipsLeftViewBox = (p: Placement): boolean => placementPixelRect(p, cfg, coord).left < -1;

  // `countDefects` は leader×label 貫通を数えない。横優先 L 字の縦 riser が隣ラベル box を貫く退行
  // (例 `pdf_510037_07` オフショア riser が韓国 box を貫通) を防ぐため、gate の through も非悪化で見る。
  let before = measureDefectGate(placements, cfg, coord);
  if (before.d.clips === 0) return;

  // 隣接ラベル間の最小縦間隔 (`countDefects` の重なり閾値 6px に余裕)。
  const marginLogical = 8 / (pieRpx / cfg.pieRadius);
  // placement の論理 box (top > bot, +y = 上)。
  const lbox = (p: Placement) => {
    const b = placementBox(p, cfg);
    return { top: Math.max(b.top, b.bottom), bot: Math.min(b.top, b.bottom) };
  };

  // 対象: 左側 (x<0) の外側ラベルで左端を見切れ、かつ水平 nudge が pie ブロックされる
  // (|y| < pieRadius) もの。2 行左列は専用パス管轄なので除外。下left ドロップ
  // 候補 (`lowerLeftDropLeader`) は本パスを `applyLowerLeftDropFallback` より先に試し、縦 spread で
  // 解消できればドロップ不要にするため除外しない。
  const targets = placements.filter(
    (p) =>
      !p.insideSlice &&
      p.x < 0 &&
      Math.abs(p.y) < cfg.pieRadius &&
      !p.nameSplit &&
      !p.twoLineLeftColumn &&
      clipsLeftViewBox(p),
  );
  if (targets.length === 0) return;

  const step = radialFraction(cfg, 0.01, 0.06);
  const MAX_ITERS = 200;

  // 円の縦中心から離す向き `dir` へ、見切れ解消 (または可動限界) まで少しずつ動かし、各ステップで
  // x を pie 限界まで右へ寄せ直す (`applyVisualViewBoxNudge`)。ラベル幅は変えず x のみ寄せる。
  const stepAway = (p: Placement, dir: number): void => {
    for (let i = 0; i < MAX_ITERS; i += 1) {
      if (blockedInY(p, dir)) break;
      p.y += dir * step;
      if (typeof p.maxTextY === 'number' && p.y > p.maxTextY) p.y = p.maxTextY;
      if (typeof p.minTextY === 'number' && p.y < p.minTextY) p.y = p.minTextY;
      applyVisualViewBoxNudge([p], cfg);
      if (!clipsLeftViewBox(p)) break;
    }
  };

  // 片側 (上 or 下) の見切れラベル群を equator 近接側から外側へ順に動かす。各ラベルを見切れ解消位置
  // まで動かした後、内側 (equator 寄り) の直前ラベルと重ならないよう外側へ追い出す。これにより外側
  // ラベルが内側ラベルのぶん余分に動いて縦に広がり、群全体が衝突せず収まる (単純な貪欲 1 件ずつでは
  // 外側ラベルが「自身が解消した時点」で止まり内側ラベルの空きを作れない)。採否は片側単位の do-no-harm
  // ゲートで全件採用/全件 revert する。
  const processSide = (group: Placement[], dir: number): void => {
    if (group.length === 0) return;
    group.sort((a, b) => Math.abs(a.y) - Math.abs(b.y)); // equator 近接側 (|y| 小) から
    // 全 placement の幾何 snapshot (revert 用)。後段 leader 修復が他ラベルの bend も触りうるため全件。
    const snaps = placements.map((p) => ({
      p,
      x: p.x,
      y: p.y,
      lb: { ...p.leaderBend },
      le: { ...p.leaderEndpoint },
    }));
    // 見切れる 1 行 (lines.length===1) の幅広ラベルは box が広すぎて equator 近傍では収まらない。先に
    // **標準2行** [name, %] へ変換 (`toTwoLineNamePlacement`) して箱幅を狭める (数値行に名前文字を乗せない
    // = 他ラベルと同形)。これにより縦移動で収まらない時の過剰な移動採用 (見た目改善のない他チャート
    // 巻き込み) を避け、収まらなければ revert 時に変換も戻す。
    const splitSnaps: {
      p: Placement;
      snap: ReturnType<typeof toTwoLineNamePlacement>;
      origLeft: number; // 1 行時の左端 px (2 行化で見切れ量が減ったか判定する基準)
    }[] = [];
    for (const p of group) {
      if (clipsLeftViewBox(p) && p.lines.length === 1) {
        const origLeft = placementPixelRect(p, cfg, coord).left;
        const s = toTwoLineNamePlacement(p, cfg);
        if (s) splitSnaps.push({ p, snap: s, origLeft });
      }
    }
    const groupOrigY = group.map((p) => p.y); // 移動採用後に「実際に動いたラベル」を識別する基準
    let innerEdge: number | null = null; // 直前 (内側) ラベルの外側エッジ (上群=top / 下群=bot)
    for (const p of group) {
      stepAway(p, dir);
      if (innerEdge !== null) {
        const box = lbox(p);
        if (dir > 0) {
          const need = innerEdge + marginLogical - box.bot; // p(上) の下端を直前 top + margin 以上へ
          if (need > 0) {
            p.y += need;
            if (typeof p.maxTextY === 'number' && p.y > p.maxTextY) p.y = p.maxTextY;
            applyVisualViewBoxNudge([p], cfg);
          }
        } else {
          const need = box.top - (innerEdge - marginLogical); // p(下) の上端を直前 bot - margin 以下へ
          if (need > 0) {
            p.y -= need;
            if (typeof p.minTextY === 'number' && p.y < p.minTextY) p.y = p.minTextY;
            applyVisualViewBoxNudge([p], cfg);
          }
        }
      }
      innerEdge = dir > 0 ? lbox(p).top : lbox(p).bot;
    }
    const revertGeometry = (): void => {
      for (const s of snaps) {
        s.p.x = s.x;
        s.p.y = s.y;
        s.p.leaderBend = s.lb;
        s.p.leaderEndpoint = s.le;
      }
    };
    // 採用した移動ラベルのリーダを箱「アンカー側の縁・水平中央」へ寄せて見やすくする (do-no-harm)。
    // 移動採用が確定した後にフラグを立て直し再評価し、悪化したらフラグと bend のみ戻す (移動は維持)。
    const refineMovedLeaders = (): void => {
      const moved = group.filter((p, i) => Math.abs(p.y - groupOrigY[i]) > 1e-6);
      if (moved.length === 0) return;
      const leaderSnap = placements.map((p) => ({
        p,
        lb: { ...p.leaderBend },
        le: { ...p.leaderEndpoint },
      }));
      for (const p of moved) p.declipBottomLeader = true;
      repairResidualLeaderDefects(placements, cfg, coord);
      const a = measureDefectGate(placements, cfg, coord);
      const ok =
        a.d.clips <= before.d.clips &&
        gateNotWorseExceptClips(a, before) &&
        a.through <= before.through;
      if (ok) {
        before = a;
      } else {
        for (const p of moved) p.declipBottomLeader = undefined;
        for (const s of leaderSnap) {
          s.p.leaderBend = s.lb;
          s.p.leaderEndpoint = s.le;
        }
      }
    };

    // 手順1: 縦に広げた結果 leader が長い斜線になり交差しうるので既存 leader 修復 (do-no-harm) を掛けて
    // から、移動+spread を do-no-harm ゲート (clips 厳密減) で判定する。
    repairResidualLeaderDefects(placements, cfg, coord);
    const moveAfter = measureDefectGate(placements, cfg, coord);
    const moveAdopt =
      moveAfter.d.clips < before.d.clips &&
      gateNotWorseExceptClips(moveAfter, before) &&
      moveAfter.through <= before.through;
    if (moveAdopt) {
      before = moveAfter;
      refineMovedLeaders();
      return;
    }

    // 手順2: 移動失敗。完全 revert の前に「分割維持」を試す (例 スウェーデンクローナ: 円脇に幅が入らず
    // 移動では収まらないが、2 行分割で見切れ量は縮む — ユーザは 1 行見切れより 2 行見切れを好む)。幾何
    // (x/y/leader) を元へ戻し分割 (lines/nameSplit/nameScaleX) は維持、元位置で x 再フィット → 各分割対象
    // の左はみ出し量が減り、かつ他カテゴリ非悪化 (clips は同値可) なら分割維持。
    revertGeometry();
    if (splitSnaps.length > 0) {
      for (const { p } of splitSnaps) applyVisualViewBoxNudge([p], cfg);
      repairResidualLeaderDefects(placements, cfg, coord);
      const splitAfter = measureDefectGate(placements, cfg, coord);
      const magnitudeReduced = splitSnaps.every(
        ({ p, origLeft }) => placementPixelRect(p, cfg, coord).left > origLeft + 1e-6,
      );
      const splitAdopt =
        magnitudeReduced &&
        splitAfter.d.clips <= before.d.clips &&
        gateNotWorseExceptClips(splitAfter, before) &&
        splitAfter.through <= before.through;
      if (splitAdopt) {
        before = splitAfter;
        return;
      }
    }

    // 手順1・2 とも不採用: 2 行変換も含め完全 revert (baseline byte 不変)。
    for (const { p, snap } of splitSnaps) {
      if (snap) restoreTwoLineNamePlacement(p, snap);
    }
    revertGeometry();
  };

  // 中心より上 (y>=0) の見切れラベルは上へ、下 (y<0) は下へ。各側を片側単位でゲートする。
  processSide(
    targets.filter((p) => p.y >= 0),
    1,
  );
  processSide(
    targets.filter((p) => p.y < 0),
    -1,
  );
}

/**
 * 下left ドロップ + 斜めリーダー フォールバック (emit 最終段, do-no-harm)。`layout.ts` の
 * `markClippedUpperLeftLongDrop` が識別した `lowerLeftDropLeader` ラベル (9時直近で長体下限でも
 * viewBox 左端を見切れる幅広長名) を、円が横へ逃げ帯が広い下left へ 2 行のまま置き直し
 * (`buildLowerLeftDropLeaderDraft`)、slice rim から斜めリーダーで接続する (参考PDF「オーストラリア」)。
 * 採否は do-no-harm ゲート (`countDefects` で clips 厳密減・他カテゴリ
 * 非悪化)。密チャート (例 asset_long_labels_9) で交差/順序反転を生む場合は revert され、当該チャートは
 * baseline (rim 2 行) のまま = 回帰なし。
 */
export function applyLowerLeftDropFallback(
  placements: Placement[],
  cfg: PieLayoutConfig,
  coord: Coord,
): void {
  const { width, height } = coord;
  const clipsViewBox = (p: Placement): boolean => {
    const b = placementPixelRect(p, cfg, coord);
    return b.left < -1 || b.right > width + 1 || b.top < -1 || b.bottom > height + 1;
  };

  let before = measureDefectGate(placements, cfg, coord);
  if (before.d.clips === 0) return;
  for (let i = 0; i < placements.length; i += 1) {
    const p = placements[i];
    if (p.insideSlice || !p.item.lowerLeftDropLeader || !clipsViewBox(p)) continue;
    const item = p.item as LayoutItemReady;
    // 下left ドロップ placement を構築。forceHorizontalLowerLeftDrop を一時的に立てて
    // clampAndBuildPlacement の内側 (canvasXlim) X クランプを解放し、viewBox 端まで伸ばせるようにする。
    const prevDrop = item.forceHorizontalLowerLeftDrop;
    item.forceHorizontalLowerLeftDrop = true;
    const form = outsideFormForRank(item, cfg, 2); // 2 行原寸起点
    const dropP = finalizePlacement(
      item,
      cfg,
      buildLowerLeftDropLeaderDraft(item, cfg, form),
      form,
    ).textPlacement;
    item.forceHorizontalLowerLeftDrop = prevDrop;
    dropP.twoLineLeftColumn = true; // 可動域/condense を viewBox 基準にし、収まる最大サイズへ
    placements[i] = dropP;
    // emit パイプラインと同順で dropP を整える: viewBox はみ出しを pie 手前まで右シフト →
    // 収まるまで長体 → 収まる範囲で原寸へ緩和。pie clearance は左ラベルの上限のみ与え右へ
    // 引き戻さないため、nudge を入れないと draft 初期 x のまま左へ張り出して見切れる。
    applyVisualViewBoxNudge([dropP], cfg);
    applyFinalCondenseToFit([dropP], cfg);
    relaxNameCondense([dropP], cfg);
    const after = measureDefectGate(placements, cfg, coord);
    const adopt = after.d.clips < before.d.clips && gateNotWorseExceptClips(after, before);
    if (adopt) {
      before = after;
    } else {
      placements[i] = p;
    }
  }
}

/**
 * 上部「その他」の右上(第一優先) vs 左上(代替)をチャート単位で選ぶ。右上が左上に無い不具合を
 * 増やさないなら右上、増やすなら左上。対象はコア帯 (90°±18°) のみ: 左拡張帯 (leftExt) の
 * その他は topBandSonohokaRight が topRightRejected に依らず常に真上垂直 center 配置を返す
 * ため、右/左の二重試行が同一結果になり比較が無意味 (スキップして cascade 1 回で済ませる)。
 */
function cascadeWithSonohokaPick(
  labels: LayoutItemReady[],
  cfg: PieLayoutConfig,
  coord: Coord,
  spreadLeftStack = false,
  leftStackMode = false,
): Placement[] {
  const topOthers = labels.filter((it) => topBandSonohokaZone(it) === 'core');
  for (const it of topOthers) it.topRightRejected = false;
  const right = runCascadeOnce(labels, cfg, spreadLeftStack);
  if (topOthers.length === 0) return right;

  const rightIssues = countVerifyIssuesDetailed(right, cfg, coord, leftStackMode);
  for (const it of topOthers) it.topRightRejected = true;
  const left = runCascadeOnce(labels, cfg, spreadLeftStack);
  for (const it of topOthers) it.topRightRejected = false;
  const leftIssues = countVerifyIssuesDetailed(left, cfg, coord, leftStackMode);

  // 孤立極小スライス leader 型 (`layout.ts` の `markLoneTopSliverLeader`) では『その他』を右上へ確定
  // (右逃がし)。これをしないと極小の up-and-over leader が中央の『その他』box を貫いて Pass 2 で
  // 抑制され、せっかくの leader が消える。本印は同マーカーの厳ゲートでこの 1 構成のみに立つ。
  if (labels.some((it) => it.loneTopSliverLeader)) return right;
  // 右上(第一優先)は hard 不具合 (交差 / 円内貫通) を左上より悪化させないことが前提で採用する。判定は
  // 実描画 (ALWAYS_DRAW) + 全後段で数える countVerifyIssuesDetailed を使い、後段 (角度順引き離し/9時
  // 逃がし) が解消する見かけ上の交差で右上を誤却下しない。右逃がしが本当に悪い構成
  // (例 currency_many_small_10: 極小その他が隣接 leader と交差) は crossings/pie で弾ける。
  //
  // clips (viewBox 見切れ=soft WARN) は hard と同格には扱わない: 幅モデルを実 glyph advance に統一して
  // placementBox の clips が実描画と一致するので比較材料には使うが、「右上が hard (交差/円内) を厳密に
  // 減らす」なら clips が増えても右上を採る (hard > soft)。clips<= を必須にする旧条件は、左上が交差を
  // 抱える構成 (例 currency_usd_heavy_9: その他を左へ置くと スイスフラン leader の根本に接触=交差) で、
  // 右上が 1px 見切れるだけで右上を却下し交差側を選んでいた。soft 見切れ増を受け入れ確実に分離する。
  const rightNotWorse =
    rightIssues.crossings <= leftIssues.crossings &&
    rightIssues.pie <= leftIssues.pie &&
    (rightIssues.clips <= leftIssues.clips ||
      rightIssues.crossings < leftIssues.crossings ||
      rightIssues.pie < leftIssues.pie);
  return rightNotWorse ? right : left;
}

/** `pickCapClearanceParity` 用の採点。`countDefects` が数えない leader のラベル箱貫通を併載する。 */
function capParityScore(
  placements: Placement[],
  cfg: PieLayoutConfig,
  coord: Coord,
  leftStackMode: boolean,
): DefectCounts & { through: number } {
  const finalized = finalizeForScoring(placements, cfg, coord, leftStackMode);
  return {
    ...countDefects(finalized, cfg, coord),
    through: countLeaderThroughLabels(finalized, cfg, coord),
  };
}

/**
 * pie キャップ外の箱に対する静的 pie クランプの「名残制約」除去 (`label_placement.ts` の
 * `clampAndBuildPlacement`) を、チャート単位で採否する do-no-harm。
 *
 * 名残制約は動的側 `pieClampXLimits` (`svg_geom.ts`) が持たない静的側だけの非対称で、円と X 方向で
 * 干渉しない箱まで横へ押し出す (例 `currency_low_diff_10` の「その他」が 66px 左寄せされ、真上垂直の
 * はずの leader が長い斜めになる)。ただしこの押し出しが偶発的に隣接ラベルの重なり回避として働いて
 * いるチャートがあり、一律除去すると退行する (実測: `pdf_510037_01_fund_country_20240710` の
 * ルクセンブルク↔ケイマン諸島で 48px 重なり + leader 貫通、`pdf_510037_07_fidelity_foreign_bond_currency`
 * で 24px 重なり)。
 *
 * そこで除去版 (parity) と旧挙動版 (rejected) を同じ最終化で比較し、`countDefects` が数えない二級
 * defect (leader のラベル箱貫通) も明示的に足したうえで、parity が 1 項目も悪化させないチャートだけ
 * parity を採る。以降の `bestResult()` 再走が同じ選択を再現するよう、フラグは確定側で残す。
 */
function pickCapClearanceParity(
  labels: LayoutItemReady[],
  cfg: PieLayoutConfig,
  coord: Coord,
  leftStackMode: boolean,
  bestResult: () => Placement[],
): Placement[] {
  for (const it of labels) it.capParityRejected = false;
  const parity = bestResult();
  const parityScore = capParityScore(parity, cfg, coord, leftStackMode);
  for (const it of labels) it.capParityRejected = true;
  const rejected = bestResult();
  const rejectedScore = capParityScore(rejected, cfg, coord, leftStackMode);
  // 採否は `cascadeWithSonohokaPick` と同じ hard > soft の辞書順。hard (交差 / 円内貫通 / ラベル箱
  // 貫通) を 1 つも増やさないことをガードにし、その下で hard が厳密に減るなら soft (見切れ / 総数) の
  // 増加は許す。名残制約の除去は「斜め leader がラベル箱を貫く」型の解消が主目的で、その代償として
  // placementBox 基準の clips が 1 増えることがあるため (実描画では見切れていないことが多い)。
  //
  // 同点なら **既存挙動を維持** する (parity を採らない)。採点は `finalizeForScoring` = scoring 段
  // までしか見ず、emit 限定の後段パスが生む二級 defect を数えないため、同点採用は実描画でだけ重なりが
  // 増える退行を招く (実測: `pdf_510037_07_fidelity_foreign_bond_currency` は採点上 完全同点だが
  // emit 後に ニュージーランド・ドル ↔ その他 の 24px 重なりが出る)。改善が測れるチャートに限定する。
  const hardGuard =
    parityScore.crossings <= rejectedScore.crossings &&
    parityScore.pie <= rejectedScore.pie &&
    parityScore.through <= rejectedScore.through;
  const hardBetter =
    parityScore.crossings < rejectedScore.crossings ||
    parityScore.pie < rejectedScore.pie ||
    parityScore.through < rejectedScore.through;
  const softNotWorse =
    parityScore.clips <= rejectedScore.clips && parityScore.total <= rejectedScore.total;
  const softBetter =
    parityScore.clips < rejectedScore.clips || parityScore.total < rejectedScore.total;
  const parityNotWorse = hardGuard && (hardBetter || (softNotWorse && softBetter));
  if (!parityNotWorse) return rejected;
  for (const it of labels) it.capParityRejected = false;
  return parity;
}

/**
 * 1 行起点 (preferOneLineCascade=true) の左側ラベルに対する probe-then-override:
 * cascade を一度プローブし、1 行 placement の実描画 bbox が実 viewBox (svgWidthPx) の
 * 左右端を越える label のみ起点を 2 行 (rank 1/2) に戻す。
 *
 * 「左側密集は 1 行優先・入る分だけ」方針。位置 (左帯のどこにあるか) では判定せず、実 bbox が
 * viewBox を越える時だけ 2 行に戻す (= 物理的に 1 行で入らない長名のみ救済)。判定境界は
 * `layout.ts` の `leftStackMode` ゲート / `isCascadeFailed` (`dominantOutsideEdge`) と同じ `svgWidthPx`
 * 基準に統一する (detectVisualHorizontalOverflow は可動域 canvasXlim 基準で狭すぎるため使わない)。
 * これにより viewBox に収まる中位ラベルは 1 行を維持し、見切れ判定 (= viewBox) とも整合する。
 *
 * 起点を戻すフラグは 3 点セット (preferOneLineCascade / compactLabel / textLines)
 * で `layout.ts` の `leftStackMode` と対称に書き戻す。`textLines` を 2 (長名は 3) に復元する
 * ことで後段 applyVisualViewBoxNudge (1 行除外ガード) も通過し、最終 shift 救済も
 * 効くようになる。2 行が物理的に入らなければ本番 cascade が 1行/長体/leader まで自然降格
 * するので safety net は既存挙動が担う。
 */
function overrideOverflowPreferOneLine(labels: LayoutItemReady[], cfg: PieLayoutConfig): void {
  const candidates = labels.filter((it) => it.preferOneLineCascade && it.side === 'left');
  if (candidates.length === 0) return;
  // プローブを **emit と同じ後段** (nudge/condense-to-fit/relax-condense) で最終化したコピー上で
  // overflow を判定する。生 cascade 直後の box は condense/nudge で実際は収まる左ラベルを誤って
  // overflow 扱いし、不要な 2 行化を招く。leftStackOverflowItems と対称の実描画基準判定。配列順は
  // 各パスとも不変なので index で labels と対応づけできる。
  const probe = runCascadeOnce(labels, cfg);
  applyVisualViewBoxNudge(probe, cfg);
  applyFinalCondenseToFit(probe, cfg);
  relaxNameCondense(probe, cfg);
  const halfW = cfg.svgWidthPx / 2 / cfg.pxPerUnit;
  const tol = 1 / (cfg.svgUnitsPerMm * cfg.mmPerUnit + 1e-9); // ≈ 1 SVG px
  for (let i = 0; i < labels.length; i += 1) {
    const item = labels[i];
    const placement = probe[i];
    if (!item.preferOneLineCascade) continue;
    if (placement.insideSlice) continue;

    const box = placementBox(placement, cfg);
    const overflows = box.left < -halfW - tol || box.right > halfW + tol;
    if (!overflows) continue;

    item.preferOneLineCascade = false;
    item.compactLabel = false;
    item.textLines = item.name.length >= cfg.veryLongLabelLen ? 3 : 2;
  }
}

/**
 * topBandClusterMode 専用の後処理: 12時近傍クラスタ (clusterTopBand=true) のラベル群を
 * midAngle 順 (90°に近い順 = 上、遠い順 = 下) でタイトに積み直す。bottom メンバー
 * (clusterTopBandBottom=true) は最下段に追加 gap で配置。
 *
 * 既存の cascade y 値を再利用せず、クラスタ最上段の y (= cluster 内の最大 pie y) を
 * 起点に、上→下へ「前ラベルの top − (現ラベル全高 + minGap)」で順に積む。これにより
 * cascade が 2 行ラベルを中段以下に置いてしまった場合でも、その下の 1 行ラベルを
 * すぐ下にタイトに引き上げる。
 *
 * Y 計算は pie 座標 (Y 大 = 視覚的上、baseline=top で text 下方向に伸びる規約):
 *  - baseline=top: text の上端が p.y。次の top は p.y − labelHeight − gap
 *  - baseline=bottom: text の下端が p.y。これは内側等で稀なので、cascade の y を維持
 *
 * 占有範囲が広がる方向 (= 下方向) に動くため、クラスタ外ラベル (日本 inside / 右側など)
 * と衝突する可能性は低い (日本は内側、右側は別 X)。Y 変更後は clampPlacement で範囲内
 * に収める。
 *
 * 積み直し後、天端に headroom が残る場合は列を viewBox 天端まで持ち上げて均等再配分する
 * (下記 liftClusterToCanvasTop)。coord / leftStackMode はその do-no-harm ゲート
 * (`countVerifyIssuesDetailed`) 専用。
 */
function applyTopBandClusterReorder(
  placements: Placement[],
  cfg: PieLayoutConfig,
  coord: Coord,
  leftStackMode: boolean,
): void {
  // forceTopRight 済 (= clusterTopBandBottomRight で右上 rim へ逃げた) item は再配置対象外。
  // label_placement.ts 側で確定済みの右上 rim 配置を尊重し、左帯の再スタックには参加させない。
  const cluster = placements.filter(
    (p) => p.item.clusterTopBand === true && !p.insideSlice && !p.forceTopRight,
  );
  if (cluster.length < 2) return;
  const nonBottom = cluster.filter((p) => p.item.clusterTopBandBottom !== true);
  const bottom = cluster.filter((p) => p.item.clusterTopBandBottom === true);
  if (nonBottom.length === 0) return;

  // クラスタ最上段の y (現在の cluster 中の最大 pie y) を起点にする
  const topY = Math.max(...cluster.map((p) => p.y));
  const minGap = cfg.scaledMinGap;
  const sorted = [...nonBottom].sort(
    (a, b) => Math.abs(a.item.midAngle! - 90) - Math.abs(b.item.midAngle! - 90),
  );

  // ヘルパ: stacking で y を仮設定した後、pie 侵入を避けるよう上方向 (pie y 増加) に
  // 引き上げる。横方向 nudge ではなく純粋に y のみ上げる (cluster 内の列を崩さないため)。
  // text bbox の最も pie 中心に近い点との距離が pieR + clearance 以上になるまで反復。
  //
  // baseline 規約 (rendering.ts と一致):
  //   - baseline="top"   = SVG `text-after-edge`  → p.y は text の **下端** (pie y 最小)
  //   - baseline="bottom"= SVG `text-before-edge` → p.y は text の **上端** (pie y 最大)
  //   - baseline="middle"= SVG `middle`            → p.y は text の中央
  const pushUpToClearPie = (p: Placement): void => {
    const measured = p.measured ?? { width: 0, height: cfg.fontSizeUnits * cfg.lineHeightFactor };
    const clearance = cfg.pieLabelClearance;
    const pieR = cfg.pieRadius;
    for (let step = 0; step < 8; step += 1) {
      let left: number, right: number;
      if (p.anchor === 'start') {
        left = p.x;
        right = p.x + measured.width;
      } else if (p.anchor === 'end') {
        left = p.x - measured.width;
        right = p.x;
      } else {
        left = p.x - measured.width / 2;
        right = p.x + measured.width / 2;
      }
      let top: number, bot: number;
      if (p.baseline === 'top') {
        top = p.y + measured.height;
        bot = p.y;
      } else if (p.baseline === 'bottom') {
        top = p.y;
        bot = p.y - measured.height;
      } else {
        top = p.y + measured.height / 2;
        bot = p.y - measured.height / 2;
      }
      const closestX = Math.max(left, Math.min(0, right));
      const closestY = Math.max(bot, Math.min(0, top));
      const dist = Math.hypot(closestX, closestY);
      if (dist >= pieR + clearance) return;
      // pie 上側 (y > 0) に居る前提: y を上げて離す
      const need = pieR + clearance - dist + 1e-3;
      p.y += need;
    }
  };

  // baseline=top 規約: y は text 上端 (pie 座標で上ほど y 大)。次ラベルの上端 = 現上端 − (現高 + minGap)。
  // baseline=bottom (内側等) の場合は y を中央扱いとし、heightで上下に伸びる近似で同様処理。
  let currentTop = topY;
  for (let i = 0; i < sorted.length; i += 1) {
    const p = sorted[i];
    if (i === 0) {
      p.y = currentTop;
    } else {
      // 前ラベルの底面 = currentTop − prevHeight。次ラベルの top = 底面 − minGap。
      const prev = sorted[i - 1];
      const prevH = prev.measured?.height ?? cfg.fontSizeUnits * cfg.lineHeightFactor;
      currentTop = currentTop - prevH - minGap;
      p.y = currentTop;
    }
    pushUpToClearPie(p);
    clampPlacement(p);
    // p.y が pie 侵入回避で上方向に動いた場合、次ラベルの起点も追随させる
    currentTop = p.y;
  }

  // rim 最上部起点の積みは、右上へ逃げた forceTopRight メンバー (clampPlacement が viewBox
  // 天端へ張り付ける) と非対称な左上空白を残す。天端に headroom が残る場合は 12時最寄り
  // ラベルを maxTextY (= クランプが許す上限) まで持ち上げ、空いた分を最下段との間で均等
  // 配分する。最下段を rim 由来の現位置へ据え置くのは、中段が rim から離れると長い近平行
  // leader が生まれ判読性が落ちるため (`spreadLeftStackFullHeight` 却下の経緯と同じ判断)。
  // 発火は幾何条件のみ: headroom があり、かつ再配分で最小エアギャップが広がる時だけ
  // (整列後は headroom=0 になるので冪等)。悪化は末尾の do-no-harm ゲートが拾い全 revert。
  const liftClusterToCanvasTop = (): void => {
    const n = sorted.length;
    const first = sorted[0];
    if (n < 2 || typeof first.maxTextY !== 'number') return;
    const tol = pxToLogical(cfg, 2);
    const headroom = first.maxTextY - first.y;
    if (headroom <= tol) return;
    const boxes = sorted.map((p) => placementBox(p, cfg));
    const heights = boxes.map((b) => b.top - b.bottom);
    let minAir = Number.POSITIVE_INFINITY;
    for (let i = 1; i < n; i += 1) minAir = Math.min(minAir, boxes[i - 1].bottom - boxes[i].top);
    // 均等エアギャップ = (持ち上げ後の先頭箱上端 〜 据え置き最下段箱上端) から中間の箱高を
    // 引いた残余の等分。広がらない再配分はしない (`alignLeftStackToAnchors` と同思想)。
    const liftedTop = boxes[0].top + headroom;
    const sumH = heights.slice(0, n - 1).reduce((s, h) => s + h, 0);
    const gap = (liftedTop - boxes[n - 1].top - sumH) / (n - 1);
    if (gap <= minAir + tol) return;
    const before = countVerifyIssuesDetailed(placements, cfg, coord, leftStackMode);
    const intrusionBefore = boxPieIntrusionMax(placements, cfg);
    const origY = sorted.map((p) => p.y);
    let targetTop = liftedTop;
    for (let i = 0; i < n - 1; i += 1) {
      const p = sorted[i];
      // 箱上端を目標へ移す (baseline 向き差は y−箱上端オフセット保存で吸収)。上方向移動は
      // 円頂から遠ざかる向きなので pushUp/clamp は実質 no-op 想定の安全網。動いた場合は
      // 実箱上端から次ラベルの目標を取り直し、ギャップ食い潰しを防ぐ。
      p.y += targetTop - boxes[i].top;
      pushUpToClearPie(p);
      clampPlacement(p);
      const actualTop = boxes[i].top + (p.y - origY[i]);
      targetTop = actualTop - heights[i] - gap;
    }
    const after = countVerifyIssuesDetailed(placements, cfg, coord, leftStackMode);
    // 二級の box 円侵入 (`countDefects` は数えない) も安全網として非増加を要求する。
    const worsened =
      after.clips > before.clips ||
      after.crossings > before.crossings ||
      after.pie > before.pie ||
      after.total > before.total ||
      boxPieIntrusionMax(placements, cfg) > intrusionBefore + tol;
    if (worsened) {
      sorted.forEach((p, i) => {
        p.y = origY[i];
      });
    }
  };
  liftClusterToCanvasTop();

  // bottom メンバーは最下段ラベルの底面 − (extraGap + labelHeight) へ。
  // 注: pushUpToClearPie で X が pie 中心寄り (12時近傍) の bottom ラベルは pie 上端へ
  // 強制押し上げされる。それが nonBottom ラベルと重なる場合、bottom ラベル X を pie 円外
  // (= cosA より大きい |x|) へ横にずらして低い Y を許す。
  if (bottom.length > 0) {
    const lastNonBottom = sorted[sorted.length - 1];
    const lastH = lastNonBottom.measured?.height ?? cfg.fontSizeUnits * cfg.lineHeightFactor;
    const lastBottomY = lastNonBottom.y - lastH;
    // クラスタ分離 gap は minGap の 0.5 倍 (= ~14 SVG px)。bottom メンバーを「最下段ラベル
    // のちょい下」に置く意図。minGap*2 だと隙間が空きすぎて視覚的に切り離されすぎる。
    const extraGap = minGap * 0.5;
    for (const p of bottom) {
      // X を pie 円外へ寄せて、低い Y で配置できるようにする。bbox の pie 中心寄りの
      // 端 (右端) が pie 縁外 (= -(pieR + xClearance)) より外側に来るよう X を調整。
      // すでに十分外側にあれば触らない。viewBox 左端を越える分は許容 (下位 rank と同じ扱い)。
      // xClearance は pushUpToClearPie の clearance より大きく取って、X 寄せだけで pie 制約を
      // 解消できるよう余裕を持たせる。
      const measured = p.measured ?? { width: 0, height: cfg.fontSizeUnits * cfg.lineHeightFactor };
      const pieR = cfg.pieRadius;
      const xClearance = 0.1;
      const requiredRight = -(pieR + xClearance);
      let bboxRight: number;
      if (p.anchor === 'start') bboxRight = p.x + measured.width;
      else if (p.anchor === 'end') bboxRight = p.x;
      else bboxRight = p.x + measured.width / 2;
      if (bboxRight > requiredRight) {
        const shift = bboxRight - requiredRight;
        p.x -= shift;
      }
      p.y = lastBottomY - extraGap;
      pushUpToClearPie(p);
      clampPlacement(p);
    }
  }
}

/**
 * 右上へ逃がした複数の lifted ラベル (forceTopRight) の縦順を、引出線が交差しないよう整える。
 * `topRightLiftedRimDraft` は escapee ごとに `anchorX` 由来の異なる X へ置くため、cascade の重なり解消が
 * Y を分離するが、その順序が slice 角度順と逆だと riser と horizontal が交差する (12時最寄り slice は
 * 右寄り・遠い slice は左寄りなので、**遠い slice を上段・最寄りを下段** にすると交差しない)。
 *
 * 既存の縦スロット (cascade が確定した Y 群) を保ったまま、12時から遠い順に上 (logical y 大) から
 * 割り当て直す。これで横方向の見た目 (各 anchorX 由来の X) は維持しつつ縦順だけ是正する。
 * `markLeftStackTopBandEscapeRight` が 2 枚立てた leftStackMode 形状で発火。1 枚以下なら無処理。
 */
export function stackTopRightLiftedLabels(placements: Placement[], cfg: PieLayoutConfig): void {
  const esc = placements.filter((p) => p.forceTopRight && !p.insideSlice);
  if (esc.length < 2) return;
  // 望ましい縦順: 12時から遠い (|midAngle-90| 大) ほど上段。
  const byFarthest = [...esc].sort(
    (a, b) => Math.abs((b.item.midAngle ?? 0) - 90) - Math.abs((a.item.midAngle ?? 0) - 90),
  );
  // 現在の Y スロット (logical y) を上段 (大) から順に取り、遠い順に割り当て直す。
  const slots = esc.map((p) => p.y).sort((a, b) => b - a);
  byFarthest.forEach((p, i) => {
    p.y = slots[i];
    clampPlacement(p);
  });
  restackLiftedIfOverlapping(byFarthest, placements, cfg);
}

/** `group` の各 box と、`group` に属さない box との最大縦重なり量 (logical, X が重なる対のみ)。 */
function crossOverlapMax(group: Placement[], all: Placement[], cfg: PieLayoutConfig): number {
  const inGroup = new Set(group);
  let m = 0;
  for (const g of group) {
    const a = placementBox(g, cfg);
    for (const o of all) {
      if (inGroup.has(o) || o.insideSlice) continue;
      const b = placementBox(o, cfg);
      const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const oy = Math.min(a.top, b.top) - Math.max(a.bottom, b.bottom);
      if (ox > 0 && oy > 0) m = Math.max(m, oy);
    }
  }
  return m;
}

/**
 * 右上へ逃がした lifted ラベルの縦スロットが**重なっている**場合に、上端から「箱高 + 最小ギャップ」で
 * 積み直す。`topRightLiftedRimDraft` は全 escapee に同じ初期 Y (pie キャップ直上) を与えるため、
 * 冠〜viewBox 上端に 2 枚分の余白が無いチャートでは cascade の重なり解消でも分離しきれず、
 * 文字同士が重なって残る。
 *
 * 下段は pie キャップより下へ降りることを許す。**その高さでは円の幅が細くなる**ので、箱が円から
 * 十分離れていれば (箱の最近点と円中心の距離 ≥ pieRadius) 干渉しない — 冠より上という位置ではなく
 * 「円に当たらない」という条件そのもので判定する。円へ食い込む位置しか取れない段は動かさない
 * (`topRightLiftedRimDraft` が横押し出しを避けている前提を壊さないため)。
 *
 * 全体は do-no-harm: 積み直しても**チャート全体の最大重なりが厳密に減らない**なら丸ごと revert する。
 * 降ろした先が別のラベル群と干渉して、逃がし先の重なりを他所の重なりへ移すだけになる構成があるため
 * (実測: 合成入力 `gen_short_12_other` で上左のラベル群が潰れた)。
 */
function restackLiftedIfOverlapping(
  ordered: Placement[],
  all: Placement[],
  cfg: PieLayoutConfig,
): void {
  const boxes = ordered.map((p) => placementBox(p, cfg));
  const overlapping = ordered.some((_, i) => {
    if (i === 0) return false;
    const a = boxes[i - 1];
    const b = boxes[i];
    return Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0 && b.top > a.bottom;
  });
  if (!overlapping) return;
  const snapshot = all.map((p) => p.y);
  // escapee 同士の重なり (減らしたい量) と、escapee ↔ その他のラベルの重なり (増やしてはいけない量)
  // を別々に測る。チャート全体の最大重なりで見ると、無関係な別の重なりが最大値を握っている構成で
  // 「厳密減」が成立せず、余地があるのに諦めてしまう。
  const escOverlapBefore = boxOverlapMax(ordered, cfg);
  const crossOverlapBefore = crossOverlapMax(ordered, all, cfg);
  const intrusionBefore = boxPieIntrusionMax(all, cfg);
  for (let i = 1; i < ordered.length; i += 1) {
    const p = ordered[i];
    const prevBottom = placementBox(ordered[i - 1], cfg).bottom;
    const box = placementBox(p, cfg);
    const need = box.top - (prevBottom - cfg.scaledMinGap);
    if (need <= 0) continue;
    // 必要量を一度に下げると円へ食い込むことがあるので、**降りられる分だけ降りる**部分適用にする
    // (「全部やるか諦めるか」にすると余地があるチャートでも重なりが残る)。
    const before = p.y;
    for (let step = RESTACK_DROP_STEPS; step >= 1; step -= 1) {
      p.y = before - (need * step) / RESTACK_DROP_STEPS;
      clampPlacement(p);
      const moved = placementBox(p, cfg);
      const nx = Math.max(moved.left, Math.min(moved.right, 0));
      const ny = Math.max(moved.bottom, Math.min(moved.top, 0));
      if (Math.hypot(nx, ny) >= cfg.pieRadius) break;
      p.y = before;
      clampPlacement(p);
    }
  }
  // do-no-harm: 逃がし先の重なりを他所の重なりへ移すだけなら丸ごと戻す。
  if (
    boxOverlapMax(ordered, cfg) >= escOverlapBefore - 1e-9 ||
    crossOverlapMax(ordered, all, cfg) > crossOverlapBefore + 1e-9 ||
    boxPieIntrusionMax(all, cfg) > intrusionBefore + 1e-9
  ) {
    all.forEach((p, i) => {
      p.y = snapshot[i];
      clampPlacement(p);
    });
  }
}

/**
 * 右上へ逃がした escapee (「その他」以外の `forceTopRight` ラベル) と「その他」の右上スタックを
 * 整える仕上げ (do-no-harm)。手は 2 つで、それぞれ独立にゲートして採否を決める:
 *
 * (1) **縦**: escapee と同段積みになった「その他」が cascade の重なり解消で pie キャップより下へ
 *     押し下げられている場合、「その他」を draft の定位置 (箱下端 = pieRadius + capClear、
 *     `topRightLiftedRimDraft` と同じ) へ戻し、上に積まれた escapee 側を必要量だけ上へ積み直す。
 *     重なり解消は下のラベルを下げるのでなく上のラベルを上げるのが正しい形 —
 *     `leader_invariants` オラクルが「その他 box 下端 ≤ pie キャップ」を要求する
 *     (実測退行: pdf_510037_07 で「その他」が 8px 降下しオラクル抵触)。
 * (2) **横**: escapee の書き出し x を「その他」の x へ寄せる。escapee は横幅が広いと canvasXlim
 *     (端マージン) の右限界で左へクランプされ、「その他」より書き出しが大きく左へずれる
 *     (例 currency_many_small_10 の「ノルウェークローネ」)。箱は pie キャップより完全に上で円と
 *     干渉しないため、可動域を実 viewBox 端 (数 px 内側) まで広げてよい。目標まで届かない幅広
 *     ラベルは「viewBox に収まる最右」への部分適用 (目標と viewBox キャップの min)。
 *
 * ⚠ どの手でも `clampPlacement` は呼ばない: escapee の placement には draft 由来の `minTextX`
 * (右側ラベルの下限) が残っており、前段パスが x をその下限より左へ確定させている。クランプを通すと
 * x が古い下限へ引き戻され、viewBox キャップを飛び越えて見切れを作る — しかも revert 経路でも同じ
 * 引き戻しが起きて do-no-harm ゲートの外で退行する (実測: ノルウェークローネ 右 22px 見切れ)。
 * 座標は直接動かし、revert も直接戻す。
 *
 * do-no-harm: `countDefects` 全カテゴリ非増加 + 貫通/交差の **新規対なし** + 角度順逆転
 * (`countAngularDiscordantPairs`) 非増加。二級 defect (through/inv) は `countDefects` が数えない前提
 * なのでゲートへ明示的に足す。悪化したら手ごとに幾何を revert する。
 */
export function tidyTopRightEscapeeStack(
  placements: Placement[],
  cfg: PieLayoutConfig,
  coord: Coord,
): void {
  const sono = placements.find(
    (p) =>
      !p.insideSlice && p.forceTopRight && p.anchor === 'start' && isOtherCategory(p.item.name),
  );
  if (!sono) return;
  const escapees = placements.filter(
    (p) =>
      !p.insideSlice && p.forceTopRight && p.anchor === 'start' && !isOtherCategory(p.item.name),
  );
  if (escapees.length === 0) return;
  const boxCenter = (p: Placement): number => {
    const b = placementBox(p, cfg);
    return (b.top + b.bottom) / 2;
  };

  // ── 手(1) 縦: 押し下げられた「その他」を pie キャップへ戻す (グループごと同量シフト) ──
  // 縦順序は box 中心で判定 (p.y は baseline 向きに依存して視覚順と食い違う)。escapee との相対
  // 間隔は cascade が解消済みなので崩さず、スタック全体を同量だけ上へ戻す。全量だと最上段が
  // viewBox 上端を割るチャートでは、上端 (数 px 内側) に当たる手前で止める部分適用にする
  // (「全部やるか諦めるか」にしない — 部分復帰でもキャップ許容 (+2px) に入れば十分)。
  const above = escapees.filter((p) => boxCenter(p) > boxCenter(sono));
  const capClear = radialFraction(cfg, 0.012, 0.12);
  const idealBottom = cfg.pieRadius + capClear;
  const sonoBox = placementBox(sono, cfg);
  if (above.length > 0 && sonoBox.bottom < idealBottom - 1e-9) {
    const group = [sono, ...above];
    // 論理 y の viewBox 上端 (数 px 内側)。
    const hardTop = logicalYAtViewBoxYPx(coord, 4);
    const maxTop = Math.max(...group.map((p) => placementBox(p, cfg).top));
    const delta = Math.min(idealBottom - sonoBox.bottom, hardTop - maxTop);
    if (delta > 1e-9) {
      const snapshot = group.map((p) => p.y);
      const before = captureEmitDefectVec(placements, cfg, coord);
      for (const p of group) p.y += delta;
      if (emitDefectsWorsened(before, placements, cfg, coord)) {
        group.forEach((p, i) => (p.y = snapshot[i]));
      }
    }
  }

  // ── 手(2) 横: escapee の書き出し x を「その他」へ寄せる (viewBox 収まりキャップ付き) ──
  // 実 viewBox 端の数 px 内側 (`unsqueezeCondensedByShiftTowardPie` と同じ hard 限界)。
  const hardHalf = cfg.svgWidthPx / 2 / cfg.pxPerUnit - 4 / cfg.pxPerUnit;
  for (const p of escapees) {
    if (p.x >= sono.x - 1e-9) continue;
    const box = placementBox(p, cfg);
    if (boxCenter(p) <= boxCenter(sono)) continue; // 「その他」より上の段のみ
    // 箱全体が pie キャップより上にあるラベルのみ (円と干渉せず右可動域を viewBox 端へ広げられる)。
    if (box.bottom < cfg.pieRadius - 1e-9) continue;
    const width = box.right - box.left;
    // (p.x - box.left) は anchor=start でも box 左端と書き出し x の微差 (padding 等) を吸収する補正。
    const targetX = Math.min(sono.x, hardHalf - width + (p.x - box.left));
    if (targetX <= p.x + 1e-9) continue;
    const beforeX = p.x;
    const before = captureEmitDefectVec(placements, cfg, coord);
    p.x = targetX;
    if (emitDefectsWorsened(before, placements, cfg, coord)) p.x = beforeX;
  }
}

/**
 * leftStackMode 専用の最終手段: 左上クラスタを角度順に**高さ考慮で組み直し**、幅広ラベルは長体圧縮
 * して収める。untangle の (y,baseline) スワップは同一 footprint しか扱えず、幅広 (ニュージーランド
 * 133px) や 1 行/2 行混在 (中国 1 行 / オランダ 2 行) の逆転を直せない (動かすと重なり/見切れ)。
 *
 * 手順: クラスタ (side=left・isUpperLeft・baseline=bottom・x<0・非その他) を sin(midAngle) 降順に並べ、
 * 現在の列上端 (spanTop) を固定して**下方向のみ**へ box 高+minGap 間隔でスロット割当 → 各ラベルを新 Y で
 * 左 rim にハグ (X=-sqrt(r²-y²) 起点に nudge) → applyFinalCondenseToFit で幅広を viewBox に収める →
 * resolveLabelOverlaps で整定。各ラベルが自前の高さ枠を得るので混在行でも縦重なりを生まない。
 *
 * do-no-harm: 角度順 discordant が厳密減少し、かつ交差/重なり/pie/leader貫通が非増加・viewBox 増が上限
 * 内のときだけ採用、そうでなければ全 revert (退行0)。確定 placement への純後処理で cascade は再実行しない
 * (= 過去の whole-stack spread 案が生んだ leader 貫通/巻き添えを避ける)。emit でのみ呼ぶ。
 */
export function reorderLeftStackWithCondense(
  placements: Placement[],
  cfg: PieLayoutConfig,
  coord: Coord,
): void {
  // flip フラグは実描画サイドと乖離し得るため見ない (separateCrossingPairs と同理由)。
  // クラスタ所属は実描画 (x<0・isUpperLeft・baseline) で判定する。
  const stack = placements.filter(
    (p) =>
      p.item.isUpperLeft === true &&
      !p.item.clusterTopBand &&
      !p.insideSlice &&
      p.baseline === 'bottom' &&
      !isOtherCategory(p.item.name) &&
      p.x < 0,
  );
  if (stack.length < 4) return;

  const tol = pxToLogical(cfg, 2);
  const pieR = cfg.pieRadius;

  const maxOverlap = (): number => boxOverlapMax(placements, cfg);
  const maxPieIntrusion = (): number => boxPieIntrusionMax(placements, cfg);
  const maxViewOverflow = (): number => boxViewOverflowMax(placements, cfg, coord);

  const beforeInv = countAngularDiscordantPairs(placements, cfg, coord);
  if (beforeInv === 0) return; // 逆転が無ければ触らない (OK チャートを乱さない)。
  const beforeCross = countLeaderCrossings(placements, cfg, coord);
  const beforeOverlap = maxOverlap();
  const beforePie = maxPieIntrusion();
  const beforeThrough = countLeaderThroughLabels(placements, cfg, coord);
  const beforeView = maxViewOverflow();
  const snapshot = placements.map((p) => ({
    p,
    x: p.x,
    y: p.y,
    baseline: p.baseline,
    skipLeader: p.skipLeader,
    nameScaleX: p.nameScaleX,
  }));

  // 各ラベルを自然 rim Y (sin*r = 角度順に単調・スライス直近) へ再アンカー。spanTop から詰めると低角度
  // ラベルがスライスから離れ leader が円を貫く (pie 侵入) ため、必ず自然 rim 高さに戻す。
  const byAngle = [...stack].sort(
    (a, b) => Math.sin(degToRad(b.item.midAngle ?? 0)) - Math.sin(degToRad(a.item.midAngle ?? 0)),
  );
  for (const p of byAngle) p.y = Math.sin(degToRad(p.item.midAngle ?? 0)) * pieR;
  // 角度順を保ったまま隣接を box 高+minGap に広げる (spreadLeftStackByAngle と同手・上下均等割り)。
  for (let iter = 0; iter < 8; iter += 1) {
    let moved = false;
    for (let i = 0; i + 1 < byAngle.length; i += 1) {
      const u = byAngle[i];
      const l = byAngle[i + 1];
      const bu = placementBox(u, cfg);
      const need = bu.top - bu.bottom + cfg.scaledMinGap;
      const cur = u.y - l.y;
      if (cur < need - 1e-6) {
        const d = need - cur;
        u.y += d / 2;
        l.y -= d / 2;
        moved = true;
      }
    }
    if (!moved) break;
  }
  // 各ラベルを新 Y で左 rim にハグ (X=-sqrt(r²-y²) 起点に pie nudge) → leader を短く保つ。
  for (const p of byAngle) {
    const rimXmag = Math.sqrt(Math.max(0, pieR * pieR - p.y * p.y));
    const measured = placementExtent(p, cfg);
    const nudged = nudgeTextAwayFromPie(-rimXmag, p.y, p.anchor, p.baseline, measured, cfg);
    p.x = nudged.x;
    p.y = nudged.y;
    clampPlacement(p);
  }
  // 幅広ラベルを viewBox に収める長体圧縮 (per-member・横のみ・下限 0.7)。
  // resolveLabelOverlaps は呼ばない: 箱中心押しが確定した角度順を再反転させるため (spread が既に
  // box 高+minGap で重なりを排除済み)。stack 外との重なりは下の maxOverlap ゲートで弾く。
  applyFinalCondenseToFit(stack, cfg);

  // 採用条件 (全成立で採用・一つでも崩れたら全 revert):
  // - 角度順 discordant が厳密減少 (順序が実際に改善)
  // - leader 交差 / box 重なり / pie 侵入 / leader 貫通 (= ユーザが不可とした defect) を増やさない
  // - viewBox はみ出しは上限内 (ユーザ承認の soft cost)。leader inside pie も WARN 級 soft 扱いで許容
  //   (verify も WARN 止まり・既存チャートに多数あり)。
  const afterInv = countAngularDiscordantPairs(placements, cfg, coord);
  const harm =
    afterInv >= beforeInv ||
    countLeaderCrossings(placements, cfg, coord) > beforeCross ||
    maxOverlap() > beforeOverlap + tol ||
    maxPieIntrusion() > beforePie + tol ||
    countLeaderThroughLabels(placements, cfg, coord) > beforeThrough ||
    maxViewOverflow() > beforeView + VIEW_OVERFLOW_CAP_PX;
  if (harm) {
    for (const s of snapshot) {
      s.p.x = s.x;
      s.p.y = s.y;
      s.p.baseline = s.baseline;
      s.p.skipLeader = s.skipLeader;
      s.p.nameScaleX = s.nameScaleX;
    }
  }
}

/**
 * leftStackMode 専用の後処理: 左列全体 (上の baseline=bottom クラスタ + 下の baseline=top メンバ) を
 * 角度順 (上→下) に通し、隣接 box が縦に重なる箇所だけを順序保存で下方向へ引き離す。
 *
 * 背景: 1強+多数小型 (stress_one_dominant_9) では左に 7 ラベルが寄り、上クラスタ
 * (reorderLeftStackWithCondense / spreadLeftStackByAngle) と下メンバが別系統で配置されるため、両者の
 * 境目 (9時直上の REIT↔新興国株, 新興国株↔外国債) で縦重なりが残る。上クラスタ4枚だけ広げると低角度の
 * 新興国株が下メンバ (外国債) へ食い込み、do-no-harm ゲートが revert する。本パスは下メンバも含めた
 * 左列を 1 本の縦列として、重なる対の下側 (とその下の全ラベル) を canvas 下スラックへ押し下げて解消する。
 *
 * 手順: 列を上→下 (box 中心 y 降順) に並べ、上から順に「上の box 底 − この box 天 の重なりが閾値
 * (6px) 以上」の対だけを sepGap まで引き離す下方向シフト s[i] を求める (上が押されたら下も同量 carry)。
 * 重なりの無い上クラスタは s=0 で不動。各シフト後ラベルは新 Y で左 rim にハグし直し
 * (円脇は X=-√(r²−y²)、円上下は X 維持)、clampPlacement で pie クリアランス/境界を吸収する。
 *
 * do-no-harm: 閾値以上の隣接重なりが無ければ無操作 (重なりの無い既存チャートは完全不変)。分離後に
 * 角度順逆転/leader 交差/box 重なり最大/pie 侵入/leader 貫通が悪化、または viewBox はみ出しが上限超で
 * 増えたら全 revert (退行0)。finalizeForScoring (採点) と emit の両方で reorderLeftStackWithCondense の
 * 直後に呼び、scorer ↔ emit の一致 (verify_consistency) を保つ。
 */
export function separateLeftColumnByHeight(
  placements: Placement[],
  cfg: PieLayoutConfig,
  coord: Coord,
): void {
  const col = placements.filter(
    (p) =>
      p.item.side === 'left' &&
      !p.insideSlice &&
      p.x < 0 &&
      !p.item.flipToRight &&
      !p.item.flipToLeft &&
      !p.item.bottomCenterBelow &&
      !p.item.clusterTopBand &&
      topBandSonohokaZone(p.item) === null &&
      !isOtherCategory(p.item.name),
  );
  if (col.length < 4) return;
  // 上 → 下 (box 中心 y 降順)。
  const cy = (p: Placement) => {
    const b = placementBox(p, cfg);
    return (b.top + b.bottom) / 2;
  };
  col.sort((a, b) => cy(b) - cy(a));

  const tol = pxToLogical(cfg, 2);
  const overlapThresh = pxToLogical(cfg, 6);
  const sepGap = pxToLogical(cfg, 6);

  // 角度順 (上→下) に「上 box 底 − 下 box 天」の重なりを検出。閾値以上が無ければ触らない。
  const boxes = col.map((p) => placementBox(p, cfg));
  let maxAdjOverlap = 0;
  for (let i = 0; i + 1 < col.length; i += 1) {
    const ov = boxes[i + 1].top - boxes[i].bottom; // >0 = 重なり
    if (ov > maxAdjOverlap) maxAdjOverlap = ov;
  }
  if (maxAdjOverlap < overlapThresh) return;

  const maxOverlap = (): number => boxOverlapMax(placements, cfg);
  const maxPieIntrusion = (): number => boxPieIntrusionMax(placements, cfg);
  const maxViewOverflow = (): number => boxViewOverflowMax(placements, cfg, coord);
  const beforeInv = countAngularDiscordantPairs(placements, cfg, coord);
  const beforeCross = countLeaderCrossings(placements, cfg, coord);
  const beforeOverlap = maxOverlap();
  const beforePie = maxPieIntrusion();
  const beforeThrough = countLeaderThroughLabels(placements, cfg, coord);
  const beforeView = maxViewOverflow();
  const snapshot = placements.map((p) => ({
    p,
    x: p.x,
    y: p.y,
    skipLeader: p.skipLeader,
    nameScaleX: p.nameScaleX,
  }));

  // box の天 (top) 目標位置を順序保存で求める。上から見て最初に閾値以上の隣接重なりが現れた所で
  // カスケードを発火し、以降は各 box を「上 box 底 − sepGap」以下へ押し下げて重なりを解消する。発火前
  // (重なりの無い上クラスタ) は現状維持で不動。最後に列の下端が canvas を割っていれば、上スラックの
  // 範囲で全体を上へ平行移動して吸収する。
  const yHi = cfg.canvasYlim[1] - cfg.canvasSafetyMargin;
  const yLo = cfg.canvasYlim[0] + cfg.canvasSafetyMargin;
  const heights = boxes.map((b) => b.top - b.bottom);
  const targetTop = boxes.map((b) => b.top);
  let active = false;
  for (let i = 1; i < col.length; i += 1) {
    if (!active && boxes[i].top - boxes[i - 1].bottom >= overlapThresh) active = true;
    if (!active) continue;
    const limit = targetTop[i - 1] - heights[i - 1] - sepGap; // 上 box 底 − gap
    if (targetTop[i] > limit) targetTop[i] = limit;
  }
  // 下端が canvas を割ったら、上端の余地ぶんだけ全体を上へ平行移動 (上スラックを使う)。収まり切らない
  // 残余は押し戻さず do-no-harm ゲート (viewBox はみ出し) に委ねる。
  const lastBottom = targetTop[col.length - 1] - heights[col.length - 1];
  if (lastBottom < yLo) {
    const lift = Math.min(yLo - lastBottom, Math.max(0, yHi - targetTop[0]));
    for (let i = 0; i < col.length; i += 1) targetTop[i] += lift;
  }

  // box.top を targetTop へ。y と box.top の関係 (baseline により y=top か y=top−h) は不変なので、
  // box.top の変位 = y の変位。X は維持し、pie クリアランス/境界は clampPlacement に委ねる。
  for (let i = 0; i < col.length; i += 1) {
    const dy = targetTop[i] - boxes[i].top;
    if (Math.abs(dy) <= tol) continue;
    col[i].y += dy;
    clampPlacement(col[i]);
  }

  const afterInv = countAngularDiscordantPairs(placements, cfg, coord);
  const harm =
    afterInv > beforeInv ||
    countLeaderCrossings(placements, cfg, coord) > beforeCross ||
    maxOverlap() > beforeOverlap + tol ||
    maxPieIntrusion() > beforePie + tol ||
    countLeaderThroughLabels(placements, cfg, coord) > beforeThrough ||
    maxViewOverflow() > beforeView + VIEW_OVERFLOW_CAP_PX;
  if (harm) {
    for (const s of snapshot) {
      s.p.x = s.x;
      s.p.y = s.y;
      s.p.skipLeader = s.skipLeader;
      s.p.nameScaleX = s.nameScaleX;
    }
  }
}

/** 過大ギャップ判定の倍率。隣接ギャップ中央値の本倍率を超えるギャップのみ詰める。 */
const LEFT_STACK_GAP_EXCESS_FACTOR = 1.6;

/**
 * leftStackMode 専用の後処理: 左上スタックの「突出して大きい縦ギャップ」だけを詰め、
 * カスケードの連続性を回復する。
 *
 * 背景: leftStackMode では上左ラベルが自然 rim Y (sin*r) 起点で de-collision 分離される。
 * 高 sin (天井寄り) のラベルは密集して上方へ押し上げられ密スタックになるが、低 sin
 * (9時寄り = オランダ/中国 等) のラベルは自然 rim 付近に残り、密スタックとの間に大きな空隙が
 * できて「下に下がりすぎ」て見える。useStackRimY を leftStackMode へ流用して縦スタック Y を
 * カスケードに食わせる手は、rim anchor が円から外れて pie/overlap 失敗 → rank9 leader へ
 * 過剰降格し破綻するため採らない。代わりに確定済み placement に対し純粋な後処理で詰める。
 *
 * 手順: 占有ラベルを上→下 (logical y 降順) に並べ、隣接 box 中心間ステップの中央値を基準に、
 * median*EXCESS を超える過大ステップ分だけ、その下のサブスタックを上方向へ平行移動する
 * (通常ステップは保存)。box 端ギャップは密スタックでほぼ 0 になり中央値が機能しないため、
 * ほぼ一様な中心間距離で判定する。移動ラベルは新 Y で左 rim にハグし直し (X を rim から再計算 + pie
 * nudge)、rim 位置になるため leader は省く。最大縦重なりが悪化したら全 revert (do-no-harm)。
 * applyOutsideLeaderAngularOrder の後 (角度順確定後の最終 Y 上) に呼ぶ。
 */
function applyLeftStackGapClose(placements: Placement[], cfg: PieLayoutConfig): void {
  const stack = placements.filter(
    (p) =>
      p.item.side === 'left' &&
      p.item.isUpperLeft === true &&
      !p.item.flipToRight &&
      !p.insideSlice &&
      p.baseline === 'bottom' &&
      p.x < 0,
  );
  if (stack.length < 3) return;
  stack.sort((a, b) => b.y - a.y); // 上 → 下 (logical y 降順)

  // box 中心間ステップで判定する。box 端ギャップは密スタックでほぼ 0 (箱が接する) になり
  // 中央値が機能しないため、ほぼ一様な中心間距離を使う。
  const cy = stack.map((p) => {
    const b = placementBox(p, cfg);
    return (b.top + b.bottom) / 2;
  });
  const steps: number[] = [];
  for (let i = 1; i < stack.length; i += 1) steps.push(cy[i - 1] - cy[i]);
  const sorted = [...steps].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const tol = pxToLogical(cfg, 2);
  if (median <= tol) return;

  // 過大ステップ (= median*EXCESS 超) 分を累積し、その下のラベルを上 (logical y 増) へ。
  const shift: number[] = new Array(stack.length).fill(0);
  let cum = 0;
  for (let i = 1; i < stack.length; i += 1) {
    if (steps[i - 1] > median * LEFT_STACK_GAP_EXCESS_FACTOR) cum += steps[i - 1] - median;
    shift[i] = cum;
  }
  if (cum <= tol) return;

  // do-no-harm 採点: 全 placement 横断の最大縦重なり (X が重なる対のみ)。
  const maxOverlap = (): number => boxOverlapMax(placements, cfg);
  const before = maxOverlap();
  const origY = stack.map((p) => p.y);
  const origX = stack.map((p) => p.x);
  const origSkip = stack.map((p) => Boolean(p.skipLeader));

  const pieR = cfg.pieRadius;
  for (let i = 0; i < stack.length; i += 1) {
    if (shift[i] <= tol) continue;
    const p = stack[i];
    const newY = p.y + shift[i];
    // 新 Y で左 rim にハグする X (= -sqrt(r^2 - y^2)) を起点に pie クリアランス nudge。
    const rimXmag = Math.sqrt(Math.max(0, pieR * pieR - newY * newY));
    const measured = placementExtent(p, cfg);
    const nudged = nudgeTextAwayFromPie(-rimXmag, newY, p.anchor, p.baseline, measured, cfg);
    p.x = nudged.x;
    p.y = nudged.y;
    clampPlacement(p);
    p.skipLeader = true; // rim ハグ位置に詰めたので leader は不要 (はみ出し防止)
  }

  if (maxOverlap() > before + tol) {
    stack.forEach((p, i) => {
      p.y = origY[i];
      p.x = origX[i];
      p.skipLeader = origSkip[i];
    });
  }
}

/**
 * `relieveLeftStackSpacing` の整え係数。
 *   EQUATOR_EXTRA_CLEARANCE: 円縁を最も左へ張り出す「リムにハグした」密集側行に与える追加
 *     クリアランス (論理単位)。`豪ドル`/`カナダドル` 等を円から少し離す。
 *   RIM_HUG_MAX_GAP: ラベル右辺 (pie 側) と円縁の隙間がこの値 (論理単位) 以下のものだけ
 *     「リムにハグ」とみなして (2) の押し出し対象にする (= 既に十分離れた行は無変更)。
 */
const LEFT_STACK_EQUATOR_EXTRA_CLEARANCE = 0.12;
const LEFT_STACK_RIM_HUG_MAX_GAP = 0.2;

/**
 * leftStackMode 専用の最終整え (emit 最終段・全パス後)。確定済み placement への純後処理として、
 * 2 つの独立した do-no-harm 変換を順に試す (各ラベル単位で `countDefects` 採否、悪化は個別 revert)。
 *
 *   (1) 水平デクリップ: 左端で viewBox を見切れる左上ラベル (例 `currency_many_small_10` の長名
 *       `スウェーデンクローナ`) を、box 左辺が枠内に収まるまで pie 寄り (右) へ寄せる。pie への食い込みは
 *       `nudgeTextAwayFromPie` で防ぐ (収まらない分は残す = 部分緩和)。横方向のみで縦は不変。
 *   (2) リムハグ行の押し出し: 円縁を左へ最も張り出す密集側 (`denseSideOutsidePush`) のうち、ラベル
 *       右辺が円縁に近接 (隙間 ≤ RIM_HUG_MAX_GAP) する行を追加クリアランス分だけ円から離す
 *       (例 `豪ドル`/`カナダドル`)。既に離れている行や非密集側は対象外。
 *
 * いずれも左上スタック (4 件以上 = leftStackMode 相当) にのみ作用し、新たな見切れ/重なり/交差/
 * 貫通を生む移動は採らないため、収まっている図は無変更 (退行0)。`relieveLeaderNeighborContact`
 * の後 (全 hard-defect パス後) に呼び、ここでの位置が最終配置となる (leader は emit Pass 1 で追従)。
 */
export function relieveLeftStackSpacing(
  placements: Placement[],
  cfg: PieLayoutConfig,
  coord: Coord,
): void {
  const stack = placements.filter(
    (p) =>
      p.item.side === 'left' &&
      p.item.isUpperLeft === true &&
      !p.item.flipToRight &&
      !p.insideSlice &&
      p.baseline === 'bottom' &&
      p.x < 0,
  );
  if (stack.length < 4) return;
  stack.sort((a, b) => b.y - a.y); // 上 → 下 (logical y 降順)
  // 論理→px の横スケール (右ほど大。線形なので 2 点差で求まる)。見切れ量から右シフト量を逆算する。
  const pxPerUnitX = coord.xScale(1) - coord.xScale(0);

  // 採否: clips/crossings/pie/total のどれも増やさなければ採用 (= 退行0、等値は許容)。
  const notWorse = (before: DefectCounts): boolean => {
    const after = countDefects(placements, cfg, coord);
    return (
      after.clips <= before.clips &&
      after.crossings <= before.crossings &&
      after.pie <= before.pie &&
      after.total <= before.total
    );
  };

  // (1) 水平デクリップ: 左端で見切れるラベルを「pie に食い込まない右端 (= pie ハグ天井)」まで右へ
  // 寄せて見切れ量を減らす (縦移動はしない — 上には隣ラベルが詰まり overlap になるため)。確定済みの
  // 古い `maxTextX` は右寄せを引き戻すので一時的に外し、`clampPlacement` には pie 天井だけを効かせる
  // (text の pie 侵入はここで防ぐ。`countDefects` は leader の pie 貫通しか見ないため)。退行 (新たな
  // overlap/clip 等) があれば revert。完全には収まらなくても見切れが減れば採用 (clips は等値で許容)。
  //
  // 右寄せは隣ラベルの leader 縦回廊を跨いで貫通 (through) を生みうるが、through は `countDefects`
  // に入らず `notWorse` を素通りする (currency_many_small_10: スウェーデンクローナの full-fit 右寄せが
  // ノルウェークローネ leader を跨いだ退行)。through 非増加をガードに加え、full-fit で跨ぐ場合は
  // シフトを 1 割刻みで縮めて「回廊の手前で止まる部分デクリップ」に落とす (見切れ僅少残り > 貫通)。
  for (const m of stack) {
    const box = placementBox(m, cfg);
    const leftPx = Math.min(coord.xScale(box.left), coord.xScale(box.right));
    if (leftPx >= 1 || pxPerUnitX <= 0) continue; // 見切れていない
    const before = countDefects(placements, cfg, coord);
    const beforeThrough = countLeaderThroughLabels(placements, cfg, coord);
    const origX = m.x;
    const fullShift = (2 - leftPx) / pxPerUnitX; // box 左辺が +2px に来る理想シフト (full-fit)
    for (let frac = 1; frac >= 0.1 - 1e-9; frac -= 0.1) {
      const adopted = tryMoveWithGuard(
        m,
        () => {
          const origMaxTextX = m.maxTextX;
          m.maxTextX = undefined; // 古い右寄せ上限を外し pie 天井のみ効かせる
          m.x = origX + fullShift * frac;
          clampPlacement(m, cfg); // 左ラベルは pie 天井 (pieMaxTextX) まで右寄せに引き戻される
          m.maxTextX = origMaxTextX;
        },
        // 実際に右へ動き・見切れが 0.5px 超減り・退行なし (through 含む)、の全てを満たす時だけ採用。
        () => {
          const movedBox = placementBox(m, cfg);
          const movedLeftPx = Math.min(coord.xScale(movedBox.left), coord.xScale(movedBox.right));
          return (
            m.x > origX + 1e-4 &&
            movedLeftPx > leftPx + 0.5 &&
            notWorse(before) &&
            countLeaderThroughLabels(placements, cfg, coord) <= beforeThrough
          );
        },
      );
      if (adopted) break;
    }
  }

  // (2) リムハグ行の押し出し (赤道寄りで円縁に近接した密集側行を円から離す)。キャンバス端で
  // 見切れない範囲で、追加クリアランスを大きい順に試して入る分だけ離す (部分押し出し)。
  for (const m of stack) {
    if (!m.item.denseSideOutsidePush) continue;
    const rimGap = -m.x - cfg.pieRadius; // anchor=end・x<0 ゆえ右辺=-m.x。円縁との隙間。
    if (rimGap < 0 || rimGap > LEFT_STACK_RIM_HUG_MAX_GAP) continue;
    const before = countDefects(placements, cfg, coord);
    const origX = m.x;
    for (let push = LEFT_STACK_EQUATOR_EXTRA_CLEARANCE; push >= 0.04 - 1e-9; push -= 0.04) {
      m.x = origX - push;
      clampPlacement(m);
      if (notWorse(before)) break; // この押し出し量で収まった
      m.x = origX; // 戻して次のより小さい量を試す
    }
  }
}

/**
 * placement を左 rim ハグの正準フォーム (anchor=end/baseline=bottom) へ整える。Y は引数で固定し
 * (等間隔スタックを崩さないため nudge を使わず)、anchor=end の右端 X を「box 下端 (中心に最も近い辺)
 * がパイ外になる位置」へ直接計算する。leader は、anchor→ラベルの直線がパイを貫く構成員のみ
 * `upperLeftBendPoint` で1点曲げ (アンカーから水平に出て曲げる L 字) にし、それ以外は degenerate (直線)。
 */
export function reshapeToLeftRimHug(p: Placement, cfg: PieLayoutConfig, y: number): void {
  const pieR = cfg.pieRadius;
  p.anchor = 'end';
  p.baseline = 'bottom';
  p.forceTopRight = false;
  p.dominantOutsideEdge = true;
  p.skipLeader = false;
  p.maxTextX = undefined;
  p.minTextX = undefined;
  p.maxTextY = undefined;
  p.minTextY = undefined;
  // Y 固定で rim ハグ: box 下端 (baseline=bottom の最下辺=中心に最も近い辺) の高さでパイ縁 X を出し、
  // その外側 (+ clearance) に右端を置く。これで Y を動かさずにパイ侵入を避け、等間隔が保たれる。
  const measured = placementExtent(p, cfg);
  const edgeY = Math.max(0, y - measured.height);
  const rimXmag = Math.sqrt(Math.max(0, pieR * pieR - edgeY * edgeY));
  p.x = -(rimXmag + radialFraction(cfg, 0.02, 0.2));
  p.y = y;
  p.origTextX = p.x;
  p.origTextY = p.y;
  // leader 形状: anchor→ラベルの直線がパイ (中心からの距離 < pieClear) を貫くなら1点曲げ。
  // 終点は実描画 leader が接続する box 縦中央 (右端 X, top−height/2) を使う (box 上端だと浅く誤判定)。
  const a = p.leaderAnchor;
  const pieClear = pieR - pxToLogical(cfg, 2);
  const straightDist = distPointToSegment(0, 0, a.x, a.y, p.x, p.y - measured.height / 2);
  p.leaderEndpoint = { x: p.x, y: p.y };
  p.leaderBendFollowsEndpointY = false;
  p.leaderBendFollowsEndpointX = false;
  if (straightDist < pieClear) {
    // 1点曲げ: アンカーから水平に左へ出た屈曲点 (y=anchorY)。computeDrawnLeader が anchor→bend→
    // ラベル の L 字を描き、水平区間 (y=anchorY, x≤anchorX) も続く下り区間もパイ外を通る。
    const bend = upperLeftBendPoint(a.x, a.y, p.item.midAngle ?? 0, cfg, p.item);
    p.leaderBend = { x: bend.x, y: bend.y };
  } else {
    // degenerate: bend≒endpoint。computeDrawnLeader が bend を anchor へ畳んで直線にする。
    p.leaderBend = { x: p.x, y: p.y };
  }
}

/**
 * 12時シーム近傍の左トップバンド・クラスタ (シーム逃がし後に左帯へ残った小スライス群) を、
 * 角度順 (sin(midAngle) 降順 = 上→下) に rim ハグで再積み上げして同一側 leader の交差/角度順逆転を
 * 解消する。reorderLeftStackWithCondense と同手だが leftStackMode に依存せず、トップバンド左クラスタへ
 * 幾何で発火する。do-no-harm: 交差/角度順逆転/重なり/パイ侵入/viewBox/leader貫通が悪化したら全 revert。
 */
export function reorderTopBandLeftClusterByAngle(
  placements: Placement[],
  cfg: PieLayoutConfig,
  coord: Coord,
): void {
  // 交差だけでなく角度順逆転 (例 page16: ジャージー右逃がし後の ケイマン×アイルランド。交差は
  // 無いが上左クラスタの上下が反転) も対象にする。どちらも無ければ何もしない。
  if (
    countLeaderCrossings(placements, cfg, coord) === 0 &&
    countAngularDiscordantPairs(placements, cfg, coord) === 0
  )
    return;
  const cx = coord.xScale(0);
  const pieR = cfg.pieRadius;
  const tol = pxToLogical(cfg, 2);
  const cluster = placements.filter(
    (p) =>
      !p.insideSlice &&
      !p.forceTopRight &&
      !isOtherCategory(p.item.name) &&
      coord.xScale(p.x) < cx &&
      (p.item.midAngle ?? 0) > 90 &&
      angleInBand(normalizeAngle(p.item.midAngle ?? 0), 90, TOP_SEAM_ESCAPE_HALF_WIDTH_DEG),
  );
  if (cluster.length < 2) return;

  const maxOverlap = (): number => boxOverlapMax(placements, cfg);
  const maxPieIntrusion = (): number => boxPieIntrusionMax(placements, cfg);
  const maxViewOverflow = (): number => boxViewOverflowMax(placements, cfg, coord);

  // 実描画 leader のパイ貫通最大量 (logical, 中心=原点)。computeDrawnLeader の pieClear 判定と同基準。
  const maxLeaderPie = (): number => {
    let m = 0;
    for (const p of placements) {
      const r = computeDrawnLeader(p, cfg, false);
      if (r.skipLeader) continue;
      for (let k = 0; k + 1 < r.pathPoints.length; k += 1) {
        const d = distPointToSegment(
          0,
          0,
          r.pathPoints[k].x,
          r.pathPoints[k].y,
          r.pathPoints[k + 1].x,
          r.pathPoints[k + 1].y,
        );
        m = Math.max(m, pieR - d);
      }
    }
    return m;
  };

  const beforeCross = countLeaderCrossings(placements, cfg, coord);
  const beforeDisc = countAngularDiscordantPairs(placements, cfg, coord);
  const beforeOverlap = maxOverlap();
  const beforePie = maxPieIntrusion();
  const beforeView = maxViewOverflow();
  const beforeThrough = countLeaderThroughLabels(placements, cfg, coord);
  const beforeLeaderPie = maxLeaderPie();

  trySeamMutation(
    placements,
    () => {
      // 角度順 (上→下 = sin 降順) に並べ、最上段を天井 (viewBox 上端) へアンカーして上から詰める。
      // 中央寄せだと下段に大きな空きが残るため、上端基準でタイトに積む。間隔は上ラベルの実 box 高 +
      // クラスタ専用の小ギャップ (scaledMinGap より狭く詰める=ユーザー指摘「もう少し上に詰めて」)。
      // ラベルを上げると box 下端が上がり rim ハグがパイへ近づく → リーダーが短く接続が締まる。
      const byAngle = [...cluster].sort(
        (a, b) =>
          Math.sin(degToRad(b.item.midAngle ?? 0)) - Math.sin(degToRad(a.item.midAngle ?? 0)),
      );
      const scaleY = Math.abs(coord.yScale(0) - coord.yScale(1));
      // 天井 (box 上端=textY が viewBox 上端 +1px に来る logical Y)。baseline=bottom なので box 上端=textY。
      const ceilTopY = scaleY > 1e-9 ? (coord.yScale(0) - 1) / scaleY : pieR;
      const clusterGap = radialFraction(cfg, 0.07, 0.7);
      const yOf: number[] = [];
      for (let i = 0; i < byAngle.length; i += 1) {
        if (i === 0) yOf[i] = ceilTopY;
        else yOf[i] = yOf[i - 1] - (placementExtent(byAngle[i - 1], cfg).height + clusterGap);
      }
      byAngle.forEach((p, i) => reshapeToLeftRimHug(p, cfg, yOf[i]));
      applyFinalCondenseToFit(cluster, cfg);
    },
    () => {
      // viewBox はみ出しは soft cost (WARN 級)。reorderLeftStackWithCondense と同じく交差/逆転 (hard)
      // を消すためなら 1 行高 (VIEW_OVERFLOW_CAP_PX) までの増加を許容する。重なり/パイ侵入/leader貫通/
      // leader貫通(box)は非悪化必須。leader のパイ貫通も非悪化必須 (ルクセンブルクの1点曲げ化で減る)。
      const afterCross = countLeaderCrossings(placements, cfg, coord);
      const afterDisc = countAngularDiscordantPairs(placements, cfg, coord);
      // 交差を厳密に減らす、または (交差を増やさずに) 角度順逆転を厳密に減らす時だけ採用する。
      // 後者は page16 のような「交差は無いが上左クラスタが反転」を直すための経路。
      const improved =
        afterCross < beforeCross || (afterCross <= beforeCross && afterDisc < beforeDisc);
      const harm =
        !improved ||
        afterDisc > beforeDisc ||
        maxOverlap() > beforeOverlap + tol ||
        maxPieIntrusion() > beforePie + tol ||
        maxViewOverflow() > beforeView + VIEW_OVERFLOW_CAP_PX ||
        countLeaderThroughLabels(placements, cfg, coord) > beforeThrough ||
        maxLeaderPie() > beforeLeaderPie + tol;
      return !harm;
    },
  );
}

/**
 * 確定済 placement を「右上逃がし (topBandSmallRight と同一フォーム)」へ破壊的に変形する。
 * slice から縦に抜けて右へ折れる L 字 leader (forceTopRight) + anchor=start/baseline=bottom。
 * 座標は `label_placement.ts` の `topBandSmallRight` と一致させ、`computeDrawnLeader` の `forceTopRight`
 * 分岐 (キャップ越え水平区間) に乗せる。labelY を yOffset 分だけ上へずらせば複数枚を縦に重ねられる。
 */
function reshapeToTopRightEscape(p: Placement, cfg: PieLayoutConfig, yOffset = 0): void {
  const anchorX = p.leaderAnchor.x;
  const labelX = Math.abs(anchorX) + radialFraction(cfg, 0.12, 1.5);
  const labelY = cfg.pieRadius + radialFraction(cfg, 0.04, 0.4) + yOffset;
  p.anchor = 'start';
  p.baseline = 'bottom';
  p.x = labelX;
  p.y = labelY;
  p.origTextX = labelX;
  p.origTextY = labelY;
  p.leaderBend = { x: anchorX, y: labelY };
  p.leaderEndpoint = { x: labelX, y: labelY };
  p.leaderBendFollowsEndpointY = false;
  p.leaderBendFollowsEndpointX = false;
  p.forceTopRight = true;
  p.dominantOutsideEdge = true;
  p.skipLeader = false;
  // 左配置由来のクランプ境界は右逃がし/縦積みを引き戻すため解除する。真のはみ出しは
  // 呼び出し側の do-no-harm (maxViewOverflow) ゲートが弾く。
  p.maxTextX = undefined;
  p.minTextX = undefined;
  p.maxTextY = undefined;
  p.minTextY = undefined;
}

/**
 * 12時シーム (midAngle≈90) に最も近い小スライスのラベルが左帯へ押し出され、その near-horizontal な
 * leader が同一側の隣 leader を跨ぐ交差を、当該スライスを右上空白へ "up-and-over" で逃がして解消する。
 *
 * escapeUpperLeftTinyLeaders (9時帯・2枚の near-vertical) と対になるトップバンド版。データ名や枚数では
 * なく **幾何 (midAngle が 90°近傍 / isSmall / 実描画 leader の交差が実在)** で発火するため、該当しない
 * チャートは完全無変更。逃がす候補をシーム最寄り順に 1 枚ずつ試し、毎回「交差が厳密減・重なり/パイ侵入/
 * viewBox/leader貫通が非悪化」の do-no-harm を満たす時だけ採用、崩れたらその 1 枚を全 revert する
 * (退行0)。判定は computeDrawnLeader / countLeaderCrossings (emit と同一) なので verify と一致する。
 */
export function escapeTopBandSeamLeader(
  placements: Placement[],
  cfg: PieLayoutConfig,
  coord: Coord,
  // thorough=false (採点・finalizeForScoring): 従来の greedy (候補単独 do-no-harm・2 行のまま)。
  // thorough=true (emit 最終段のみ): 累積プレフィックス探索 + 1 行化フォールバック。採点に thorough を
  // 入れるとチャート単位の候補選択が「emit で直る前提」のスコアへ寄ってしまい、修復しきれない別候補を
  // 選ぶ退行が出る (例 currency_many_small_10) ため、探索強化は emit 限定にする。
  thorough = false,
): void {
  if (countLeaderCrossings(placements, cfg, coord) === 0) return;
  const tol = pxToLogical(cfg, 2);
  const tolPx = 2;
  const cx = coord.xScale(0);
  const maxOverlap = (): number => boxOverlapMax(placements, cfg);
  const maxPieIntrusion = (): number => boxPieIntrusionMax(placements, cfg);
  const maxViewOverflow = (): number => boxViewOverflowMax(placements, cfg, coord);

  // 逃がし候補: 円外・小・トップシーム帯・「その他」でなく・現在左帯に描画・未 forceTopRight。
  // シーム最寄り (|mid-90| 最小) から順に試す。各採用後に交差が残れば次候補へ (複数枚逃がしも可)。
  const isCandidate = (p: Placement): boolean =>
    !p.insideSlice &&
    p.item.isSmall === true &&
    !isOtherCategory(p.item.name) &&
    !p.forceTopRight &&
    coord.xScale(p.x) < cx &&
    angleInBand(normalizeAngle(p.item.midAngle ?? 0), 90, TOP_SEAM_ESCAPE_HALF_WIDTH_DEG);
  const candidates = placements
    .filter(isCandidate)
    .sort((a, b) => Math.abs((a.item.midAngle ?? 0) - 90) - Math.abs((b.item.midAngle ?? 0) - 90));

  // 1 件のエスケープ実体: 右上へ reshape (+thorough 時は必要なら 1 行化) → 冠クリアランス nudge →
  // 既存エスケープとの重なりを上方向プッシュで分離。プッシュ間隔は thorough 時のみ最小限 (≈3px) に
  // 詰める (右上の縦余白は冠〜viewBox 上端の約 2 箱分しかなく、scaledMinGap だと 2 枚目が見切れる。
  // escape は全て leader 付きで帰属が自明なので詰めても判読性は落ちない)。
  const escapeOne = (c: Placement, oneLine: boolean): void => {
    reshapeToTopRightEscape(c, cfg);
    if (oneLine && c.lines.length >= 2) {
      c.lines = [c.lines.join(' ')];
    }
    const measured = placementExtent(c, cfg);
    const nudged = nudgeTextAwayFromPie(c.x, c.y, c.anchor, c.baseline, measured, cfg);
    c.x = nudged.x;
    c.y = nudged.y;
    clampPlacement(c);
    const stackGap = thorough ? radialFraction(cfg, 0.019, 0) : cfg.scaledMinGap;
    for (let it = 0; it < 6; it += 1) {
      const cb = placementBox(c, cfg);
      let pushed = false;
      for (const e of placements) {
        if (e === c || !e.forceTopRight || e.insideSlice) continue;
        const eb = placementBox(e, cfg);
        const ox = Math.min(cb.right, eb.right) - Math.max(cb.left, eb.left);
        const oy = Math.min(cb.top, eb.top) - Math.max(cb.bottom, eb.bottom);
        if (ox > 0 && oy > 0) {
          c.y += eb.top - cb.bottom + stackGap; // c を e の上端の上へ (y 増 = 上方向)
          clampPlacement(c);
          pushed = true;
          break;
        }
      }
      if (!pushed) break;
    }
  };

  let adoptedAny = false;
  if (!thorough) {
    // greedy (採点用・従来挙動): 候補単独で試し「交差が厳密減・重なり/pie/viewBox/貫通 非悪化」
    // のときだけ採用。崩れたらその 1 枚を revert (退行0)。
    for (const c of candidates) {
      const beforeCross = countLeaderCrossings(placements, cfg, coord);
      if (beforeCross === 0) break;
      const beforeOverlap = maxOverlap();
      const beforePie = maxPieIntrusion();
      const beforeView = maxViewOverflow();
      const beforeThrough = countLeaderThroughLabels(placements, cfg, coord);
      const adopted = trySeamMutation(
        placements,
        () => escapeOne(c, false),
        () => {
          const harm =
            countLeaderCrossings(placements, cfg, coord) >= beforeCross ||
            maxOverlap() > beforeOverlap + tol ||
            maxPieIntrusion() > beforePie + tol ||
            maxViewOverflow() > beforeView + tolPx ||
            countLeaderThroughLabels(placements, cfg, coord) > beforeThrough;
          return !harm;
        },
      );
      if (adopted) adoptedAny = true;
    }
  } else {
    // 累積プレフィックス探索 (emit 限定): 候補をシーム最寄り順に 1 枚ずつ「追加で」逃がし、各
    // プレフィックスの不具合ベクトルを記録して最良地点のスナップショットを採用する。greedy では
    // 「1 枚目で交差が一時的に増え、2 枚目を重ねて初めて 0 になる」谷を越えられない (例 page16:
    // アイルランド単独は through 2→0 だが cross 1→2 で却下、ケイマンを重ねると全て解消)。
    // `RepairVec` の射影 (pie = boxPie)。フィールド名は betterVec 述語の従来表記を保つ。
    interface SeamVec {
      cross: number;
      through: number;
      inv: number;
      clips: number;
      oob: number;
      ovl: number;
      pie: number;
      view: number;
    }
    const vecOf = (): SeamVec => {
      const m = measureRepairVec(placements, cfg, coord);
      return {
        cross: m.cross,
        through: m.through,
        inv: m.inv,
        clips: m.clips,
        oob: m.oob,
        ovl: m.ovl,
        pie: m.boxPie,
        view: m.view,
      };
    };
    // a が b より厳密に良い: 交差+貫通の総数が減り交差単独でも非増加、かつ逆転/見切れ箱数/leader
    // はみ出し本数/重なり/pie/viewBox 深さの全てが非悪化。max 深さだけでなく件数も見る (深さが同じ
    // でも見切れるラベルが増える逃がしを弾く)。
    const betterVec = (a: SeamVec, b: SeamVec): boolean =>
      a.cross + a.through < b.cross + b.through &&
      a.cross <= b.cross &&
      a.inv <= b.inv &&
      a.clips <= b.clips &&
      a.oob <= b.oob &&
      a.ovl <= b.ovl + tol &&
      a.pie <= b.pie + tol &&
      a.view <= b.view + tolPx;

    const snap0 = seamSnapshot(placements);
    let bestVec = vecOf();
    let bestSnap: SeamSnap[] | null = null;
    const explorePrefix = (oneLineEscapes: boolean): void => {
      seamRestore(snap0);
      for (const c of candidates) {
        const cur = vecOf();
        if (cur.cross + cur.through === 0) break;
        escapeOne(c, oneLineEscapes);
        const after = vecOf();
        if (process.env.PIE_CHART_DEBUG_REPAIR) {
          console.error(
            `[seamEscape${oneLineEscapes ? '/1line' : ''}] +"${c.item.name}": cross ${cur.cross}->${after.cross}, through ${cur.through}->${after.through}, ` +
              `inv ${cur.inv}->${after.inv}, clips ${cur.clips}->${after.clips}, oob ${cur.oob}->${after.oob}, ` +
              `view ${cur.view.toFixed(1)}->${after.view.toFixed(1)} (best ${betterVec(after, bestVec) ? 'UPDATED' : 'kept'})`,
          );
        }
        if (betterVec(after, bestVec)) {
          bestVec = after;
          bestSnap = seamSnapshot(placements);
        }
      }
    };
    explorePrefix(false);
    // 2 行のままで完治しない時だけ 1 行化プレフィックスも探索する (2 行優先 = 既存の見た目を保つ)。
    if (bestVec.cross + bestVec.through > 0) explorePrefix(true);
    // 最良プレフィックスへ巻き戻す (改善が無ければ全 revert)。
    seamRestore(bestSnap ?? snap0);
    adoptedAny = bestSnap !== null;
  }
  // シーム最寄りを右へ逃がして左帯が空いた後、残る同一側交差/角度順逆転を掃除する (各 do-no-harm)。
  // ① 既存の角度順整列 (縦引き離し + footprint 同形スワップ)、② 直らない場合は左トップバンドクラスタを
  // 角度順 rim へ再積み上げ。例: ジャージー逃がし後の ケイマン×アイルランド (ケイマンが天頂へ逆転配置)。
  if (adoptedAny) {
    applyOutsideLeaderAngularOrder(placements, cfg, coord, thorough);
    reorderTopBandLeftClusterByAngle(placements, cfg, coord);
  }
}

/**
 * leftStackMode で「1 行に降格して viewBox 左端を見切れている」幅広左ラベルの LayoutItem を返す。
 * 最終配置 (nudge/condense/relax 適用済コピー) で判定するので、verify の見切れ判定と一致する。
 * 既に 2 行のラベル / 1 行で収まる短名 (preferOneLineCascade) / flip 済は対象外。
 */
function leftStackOverflowItems(result: Placement[], cfg: PieLayoutConfig): LayoutItem[] {
  const copy = result.map((p) => ({ ...p }));
  applyVisualViewBoxNudge(copy, cfg);
  applyFinalCondenseToFit(copy, cfg);
  relaxNameCondense(copy, cfg);
  const viewBoxLeft = -cfg.svgWidthPx / 2 / cfg.pxPerUnit;
  const tol = 1 / (cfg.svgUnitsPerMm * cfg.mmPerUnit + 1e-9); // ≈ 1 SVG px
  const out: { item: LayoutItem; over: number }[] = [];
  for (const p of copy) {
    if (p.insideSlice) continue;
    if (p.item.side !== 'left') continue;
    if (p.item.flipToRight || p.item.flipToLeft) continue;
    if (p.lines.length >= 2) continue;
    if (p.item.preferOneLineCascade) continue;
    const box = placementBox(p, cfg);
    const over = viewBoxLeft - box.left;
    if (over > tol) out.push({ item: p.item, over });
  }
  // 見切れが大きい順 (最も目立つ見切れから 2 行化を試す)。採否は do-no-harm なので順序は
  // 安全性に影響せず、結果の優先順位付けのみ。
  out.sort((a, b) => b.over - a.over);
  return out.map((e) => e.item);
}

/** 全ラベルを①〜⑨カスケードで配置する。上部「その他」は右上(第一優先)/左上をチャート単位で選ぶ。 */
function runLabelCascade(
  labels: LayoutItemReady[],
  cfg: PieLayoutConfig,
  coord: Coord,
  diagnostics?: Diagnostics,
): Placement[] {
  overrideOverflowPreferOneLine(labels, cfg);
  // 現在の item フラグでの最良配置。leftStackMode は左列順序保存 spread を「不具合数が厳密に
  // 減る時だけ」採る (chart 単位 do-no-harm)。spread が悪化する他チャートは既存配置を維持 (退行0)。
  const lsm = diagnostics?.leftStackMode ?? false;
  const twoLineLeftStack = diagnostics?.twoLineLeftStackMode ?? false;
  // twoLineLeftStackMode: 左列メンバを全て 2 行起点へ固定 (1 行降格・左端見切れを防ぐ)。
  // 縦の収まりは後段 applyTwoLineLeftColumn が canvas 全高の密ピッチ列で担保する。
  if (twoLineLeftStack) {
    for (const it of labels) {
      if (
        it.side === 'left' &&
        !it.flipToRight &&
        !it.flipToLeft &&
        !it.bottomCenterBelow &&
        topBandSonohokaZone(it) === null &&
        !isOtherCategory(it.name)
      ) {
        it.keepTwoLineLeftStack = true;
      }
    }
  }
  const bestResult = (): Placement[] => {
    const off = cascadeWithSonohokaPick(labels, cfg, coord, false, lsm);
    if (!lsm) return off;
    const spread = cascadeWithSonohokaPick(labels, cfg, coord, true, lsm);
    return countVerifyIssues(spread, cfg, coord, lsm) < countVerifyIssues(off, cfg, coord, lsm)
      ? spread
      : off;
  };
  let result = pickCapClearanceParity(labels, cfg, coord, lsm, bestResult);
  // leftStackMode 限定の 2 行維持 (do-no-harm): 1 行降格で viewBox 左端を見切れる幅広左ラベルを
  // keepTwoLineLeftStack で 2 行 (rank ≤ 4) に留めて再走させ、chart の不具合数が厳密に減る時だけ
  // 採用する。減らなければフラグを戻して既存配置を維持する (leftStackMode は useStackRimY 対象外
  // なので、その代替として 2 行維持を実現)。例: fidelity 外債通貨の イギリス・ポンド/オフショア・人民元。
  if (diagnostics?.leftStackMode) {
    const overflowItems = leftStackOverflowItems(result, cfg);
    // greedy fixpoint: 見切れの大きいラベルから順に 2 行化を試す。採否は「総不具合数 (total) を
    // 絶対に増やさない」ことを第一条件にし (= 他 leftStackMode チャートで 2 行化が交差/重なりを
    // 増やす場合は不採用 → 退行0)、total が同数の時だけ clips (文字が枠外で切れる最も目立つ
    // defect) が減る方を採る。これにより「62px 見切れ ↔ 軽微な重なり/グレーズ1件」の等価トレードは
    // 見切れを消す側に倒しつつ、total が増える 2 行化は拒否する。1 パスでは早期に評価したラベルが
    // 後続の採用後に有利化しても拾えないので、採用が止まるまでパスを繰り返す (順序依存の局所解を
    // 回避)。採用済フラグは保持し、不採用なら 1 行へ戻す (do-no-harm)。
    let best = countVerifyIssuesDetailed(result, cfg, coord, lsm);
    let changed = true;
    while (changed && best.clips > 0) {
      changed = false;
      for (const it of overflowItems) {
        if (it.keepTwoLineLeftStack) continue;
        it.keepTwoLineLeftStack = true;
        const variant = bestResult();
        const v = countVerifyIssuesDetailed(variant, cfg, coord, lsm);
        // 採否方針: 見切れ (clips=文字が枠外で切れる最重要 defect) の解消を最優先にしつつ、交差
        // (crossings) と円内貫通 (pie) という質の悪い defect は決して増やさない、をハード制約にする。
        //  - ガード: crossings/pie を増やさない (増やすなら不採用 → 他チャートで交差を増やさない退行0)。
        //  - 目的: ガード下で (clips, total) の辞書順が改善するなら採用。clips を減らせるなら total が
        //    軽微な重なりで +1 する事は許す (見切れ ≫ 重なり)。clips 同数なら total 厳密減のみ採用。
        // 隣接する幅広左ラベルは 2 行同士が縦に押し合うため、結果的に「見切れを交差/貫通へ悪化させ
        // ずに 2 行化できるラベル」だけが確定する (例 fidelity 外債通貨では オフショア・人民元)。
        const guard = v.crossings <= best.crossings && v.pie <= best.pie;
        const better =
          guard && (v.clips < best.clips || (v.clips === best.clips && v.total < best.total));
        if (better) {
          result = variant;
          best = v;
          changed = true;
        } else {
          it.keepTwoLineLeftStack = false;
        }
      }
    }
  }
  if (diagnostics?.topBandClusterMode) {
    applyTopBandClusterReorder(result, cfg, coord, lsm);
  }
  if (diagnostics?.leftStackMode) {
    stackTopRightLiftedLabels(result, cfg);
    applyLeftStackGapClose(result, cfg);
  }
  if (diagnostics?.twoLineLeftStackMode) {
    applyTwoLineLeftColumn(result, cfg);
  }
  return result;
}

/**
 * メインエントリ: 入力 items から最終 SVG 文字列を組み立てて返す。
 */
/**
 * 入力を正規化し、有限かつ |value|>0 のスライスのみ残して「その他」末尾・値降順に整列する。
 * レンダラの描画順 ([[graph2-renderer-sorts-slices]]) を決める前処理。
 */
export function normalizeAndSortItems(rawItems: unknown): LayoutItem[] {
  return normalizeInputItems(rawItems)
    .filter((item) => Number.isFinite(Number(item.value)) && Math.abs(Number(item.value)) > 0)
    .map((item) => ({
      name: item.name,
      value: Math.abs(Number(item.value)),
      signedValue: Number(item.value),
    }))
    .sort((a, b) => {
      const aOther = isOtherCategory(a.name);
      const bOther = isOtherCategory(b.name);
      if (aOther !== bOther) return aOther ? 1 : -1;
      return b.value - a.value;
    });
}

/**
 * multi-slice の最終 layout を選ぶ。single-slice では null。
 * 左下密集回避でラベルを回したときは do-no-harm: 回転版と非回転版を **最終配置の不具合数** で比較し、
 * 回転が悪化させる(交差/円貫通/見切れ/重なりが増える)なら非回転へ自動フォールバックする。これで
 * 「あるサンプルに効く回転量が別サンプルを壊す」退行を判定ロジック側で吸収する(同 family の 10
 * スライス版など)。スコアリングは labels を破壊する runLabelCascade を clone 上で走らせ、採用側の
 * labels は無傷のまま emit へ渡す。
 */
function selectFinalLayout(
  items: LayoutItem[],
  cfg: PieLayoutConfig,
  coord: Coord,
): LayoutResult | null {
  if (items.length <= 1) return null;
  let finalLayout = layoutLabels(items, cfg);
  // 逃がし枚数の探索で同じレイアウトを再現するため、採用した回転オーバーライドを覚えておく
  // (非回転を採った時だけ 0。それ以外は自動判定に任せる = undefined)。
  let rotateOverride: number | undefined;
  const labelOffset = cfg.counterclock
    ? 0
    : labelCongestionOffsetDeg(
        items.map((it) => Math.abs(Number(it.value))),
        items.map((it) => it.name),
        cfg,
      );
  if (labelOffset > 0) {
    // emit と同じ最終配置で不具合を数える。`finalizeForScoring` は候補選択用に修復を除外するため、
    // ここでは emit 最終段の修復(`repairResidualLeaderDefects`/`enforceFinalPieClearance`)も足して、
    // 「修復で消える一時不具合」を回転版の過小評価にしない。
    const scoreLayout = (layout: LayoutResult): number => {
      const labelsCopy = structuredClone(layout.labels) as typeof layout.labels;
      const placements = runLabelCascade(labelsCopy, cfg, coord, layout.diagnostics);
      const finalized = finalizeForScoring(
        placements,
        cfg,
        coord,
        layout.diagnostics.leftStackMode,
      );
      repairResidualLeaderDefects(finalized, cfg, coord);
      enforceFinalPieClearance(finalized, cfg, coord);
      // countDefects(交差/円貫通/見切れ/重なり)に加え角度順逆転も数える(verify の隣接逆転に対応)。
      // これを入れないと「幾何交差0 だが順序だけ逆転」を回転版が見逃され採用される(10スライス版)。
      return (
        countDefects(finalized, cfg, coord).total +
        countAngularDiscordantPairs(finalized, cfg, coord)
      );
    };
    // 回転を採用したチャートに限り、回したラベルを円から少し離す。距離は `pieLabelClearance`
    // (円とラベルの最小クリアランス、`nudgeTextAwayFromPie` が使用) で決まるのでこれを広げる。
    // do-no-harm: 押し出しで不具合 (見切れ等) が増えるなら一段弱い量を試し、全滅なら元のクリアランスへ戻す。
    // ⚠ 採用時は cfg.pieLabelClearance を origClearance + push のまま**意図的に残す**: emit 後段の
    // `nudgeTextAwayFromPie` が広げたクリアランスで動くことまで含めて採用後の挙動。「常に復元」へ
    // 直すと出力が変わるため、この cfg への永続化は仕様として保持する。
    const adoptRotatedWithClearancePush = (rotated: LayoutResult): LayoutResult => {
      const rotScore = scoreLayout(rotated);
      const origClearance = cfg.pieLabelClearance;
      for (const push of [0.16, 0.12, 0.09, 0.06]) {
        cfg.pieLabelClearance = origClearance + push;
        const pushed = layoutLabels(items, cfg);
        if (scoreLayout(pushed) <= rotScore) return pushed; // 採用: clearance は広げたまま
        cfg.pieLabelClearance = origClearance; // 悪化 → 次の弱い量を試す (全滅なら元クリアランス)
      }
      return rotated;
    };
    const baseLayout = layoutLabels(items, cfg, 0);
    if (scoreLayout(finalLayout) > scoreLayout(baseLayout)) {
      finalLayout = baseLayout; // 回転が不具合を増やすなら非回転を採用
      rotateOverride = 0;
    } else {
      finalLayout = adoptRotatedWithClearancePush(finalLayout);
    }
  }
  return pickUpperEscapeCount(items, cfg, coord, finalLayout, rotateOverride);
}

/** `pickUpperEscapeCount` の採点ベクトル。`countDefects` が数えない二級 defect を併載する。 */
function upperEscapeScore(
  layout: LayoutResult,
  cfg: PieLayoutConfig,
  coord: Coord,
): DefectCounts & {
  through: number;
  stubs: number;
  boxPie: number;
  throughPairs: Set<string>;
  crossPairs: Set<string>;
} {
  const labelsCopy = structuredClone(layout.labels) as typeof layout.labels;
  const placements = runLabelCascade(labelsCopy, cfg, coord, layout.diagnostics);
  // **emit と同一の後段列** (`applyEmitRepairPasses`) を通してから数える。`finalizeForScoring` は
  // 候補選択用に修復を除外するので、それで採点すると「逃がし先で実際には重なるのに採点上は同点」に
  // なり、実描画でだけ退行する構成を採用してしまう (実測: 逃がした先で『その他』と 30px 重なる)。
  // 逃がしは箱を新しい場所へ移す変更なので、修復まで含めた最終形で判断する必要がある。
  const finalized = placements.map((p) => ({ ...p }));
  applyEmitRepairPasses(finalized, cfg, coord, layout.diagnostics);
  const throughPairs = leaderThroughPairs(finalized, cfg, coord);
  const crossPairs = leaderCrossingPairs(finalized, cfg, coord);
  return {
    ...countDefects(finalized, cfg, coord),
    through: throughPairs.size,
    stubs: countBundledRimStubs(finalized, cfg),
    // 逃がしはラベル箱を pie キャップ近傍へ積み直すため、箱の円内侵入 (`countDefects` は数えない
    // 二級 defect) を新規に作りうる (実測: 3 枚逃がしで最下段が cap 下へ押されて 21px 侵入)。
    boxPie: boxPieIntrusionMax(finalized, cfg),
    throughPairs,
    crossPairs,
  };
}

/**
 * 上左ラベルを何枚 右上へ逃がすか (`layout.ts` の `markLeftStackUpperEscapeRight`) をチャート単位で
 * 決める do-no-harm 探索。0 枚から候補数まで再レイアウトし、最も良い枚数を採る。
 *
 * 狙いは「束になった rim 貼り付き短 leader」(`countBundledRimStubs`) の解消。これは `countDefects`
 * が数えない二級 defect なので、ここで明示的に採点へ足す。ラベル箱貫通 (`countLeaderThroughLabels`)
 * も同様に足す — 逃がしは箱の配置を変えるため貫通を増やしうる。
 *
 * 採否は `pickCapClearanceParity` と同じ hard > soft の辞書順:
 *  - hardGuard: 交差 / 円内貫通 / ラベル箱貫通 を 1 つも増やさない。ただし **合計ではなく対の集合** で
 *    見て、base に無い交差/貫通の対が 1 つでも新たに生じたら不採用にする。合計だけだと「ある貫通を
 *    消して別の貫通を作る」局所入替が総和据え置きで通り、実描画で退行する (stress_top_cluster_8 の
 *    D-through-E)。円内貫通 (pie) は per-pair 化しにくいので合計で押さえる。
 *  - その下で **束スタブ / 交差 / 貫通 のいずれかが純減** し、見切れ (clips) と総数 (total) が悪化
 *    しないなら採用。目的関数を束スタブだけに絞らないのは、逃がしが解くのは束スタブとは限らず、
 *    「逃がさないと出る貫通」の解消 (stress_top_cluster_8 の D-through-E) も同じ機構が担うため。
 *  - **packing 枝**: 左列が縦に入りきらない (`leftColumnPackingRatio` > 1) チャートでは、計量
 *    defect がどれも動かなくても「逃がしで左列が実際に緩む (packing 厳密減)」ことを採用根拠に
 *    できる。ただし **最初の 1 手に限る** (最小逃がし則) — packing は 1 枚逃がすたび自明に減る
 *    ため、これを単独根拠にした累積逃がしを許すと候補を使い切るまで逃がし続けてしまう。
 *    2 手目以降は従来どおり defect の純減が必要。stubs/clips/total の非悪化ガードは共通。
 *  - 同点は 0 枚 (既存挙動) を維持する。
 *
 * 枚数を固定しないのが要点 — 右上の縦余白は約 2 箱分しかなく、詰め込みすぎれば clips が増えて
 * このゲート自身が弾く。「何枚入るか」をチャートごとに判断させる。
 *
 * 2 つの基準を使い分ける: 新規対ゼロの **hardGuard は base (0 枚) 固定** (best を動かすと「直前の
 * 採用形」相対になり base に無い対を見逃す)、純減の **improves は best 相対** (単調改善)。
 */
function pickUpperEscapeCount(
  items: LayoutItem[],
  cfg: PieLayoutConfig,
  coord: Coord,
  base: LayoutResult,
  rotateOverride: number | undefined,
): LayoutResult {
  const maxCount = base.diagnostics.upperEscapeCandidateCount ?? 0;
  if (maxCount <= 0) return base;
  const baseScore = upperEscapeScore(base, cfg, coord);
  let best = base;
  let bestScore = baseScore;
  for (let count = 1; count <= maxCount; count += 1) {
    const variant = layoutLabels(items, cfg, rotateOverride, count);
    const score = upperEscapeScore(variant, cfg, coord);
    // hardGuard: base に無い交差/貫通の対を 1 つも作らない (合計据え置きの局所入替を弾く)。
    // boxPie (箱の円内侵入) は verify の "label inside pie" と同じ二級 defect で、逃がし枚数が
    // 増えるほど最下段が pie キャップ下へ押されて起きる。許容は verify と同じ 2px。
    const hardGuard =
      score.pie <= bestScore.pie &&
      score.boxPie <= bestScore.boxPie + pxToLogical(cfg, 2) &&
      !hasNewPair(score.crossPairs, baseScore.crossPairs) &&
      !hasNewPair(score.throughPairs, baseScore.throughPairs);
    // improves: 束スタブ / 交差対 / 貫通対 のいずれかが直前の best より純減。hardGuard が新規対ゼロを
    // 保証するので、対の純減は「悪化を伴わない真の解消」になる。
    const improves =
      score.stubs < bestScore.stubs ||
      hasNewPair(bestScore.crossPairs, score.crossPairs) ||
      hasNewPair(bestScore.throughPairs, score.throughPairs);
    // packing 枝: 左列 overpack (>1) の緩和 (厳密減) を「最初の 1 手」(best === base) に限り採用根拠に
    // 加える。stubs 非悪化を明示するのは、improves 枝と違い stubs 減が根拠に含まれないため。
    // 欠損 (?? ) は枝不成立へ倒す。
    const basePack = base.diagnostics.leftColumnPackingRatio ?? 0;
    const variantPack = variant.diagnostics.leftColumnPackingRatio ?? Infinity;
    const packBranch =
      best === base && basePack > 1 && variantPack < basePack && score.stubs <= bestScore.stubs;
    const better =
      hardGuard &&
      (improves || packBranch) &&
      score.clips <= bestScore.clips &&
      score.total <= bestScore.total;
    if (process.env.PIE_CHART_DEBUG_ESCAPE) {
      console.error(
        `[upper-escape] count=${count}: clips ${bestScore.clips}->${score.clips} ` +
          `stubs ${bestScore.stubs}->${score.stubs} through ${bestScore.through}->${score.through} ` +
          `cross ${bestScore.crossings}->${score.crossings} pie ${bestScore.pie}->${score.pie} ` +
          `boxPie ${bestScore.boxPie.toFixed(3)}->${score.boxPie.toFixed(3)} ` +
          `total ${bestScore.total}->${score.total} ` +
          `pack ${basePack.toFixed(3)}->${variantPack.toFixed(3)} => ${better ? 'ADOPT' : 'REJECT'}`,
      );
    }
    if (better) {
      best = variant;
      bestScore = score;
    }
  }
  return best;
}

export async function renderPdfStylePieToSvg(
  rawItems: unknown,
  options: Partial<PieLayoutConfig> & { compactLabel?: boolean } = {},
): Promise<RenderResult> {
  const cfg = createPieLayoutConfig(options);
  const items: LayoutItem[] = normalizeAndSortItems(rawItems);
  if (items.length === 0) {
    // 上の filter で |value| > 0 のみ残るため、件数が残れば総和は必ず正。
    throw new Error('At least one item with a non-zero value is required.');
  }

  if (options.compactLabel === undefined) {
    runCompactCascade(items, cfg);
  }

  // 最終 layoutLabels (multi-slice 分岐で再利用)。pie 中心は常にキャンバス中央
  // (オフセットしない — createCoordinateSystem の対称ドメインで中央が保証される)。
  const coord = createCoordinateSystem(cfg);
  const { width, height, xScale, yScale } = coord;

  const finalLayout: LayoutResult | null = selectFinalLayout(items, cfg, coord);
  const colors = makeColors(items.length, cfg);
  const arcs = computeArcs(items, cfg);
  const totalValue = items.reduce((sum, item) => sum + Math.abs(Number(item.value)), 0);
  const percentOf = (value: number) =>
    totalValue > 0 ? (Math.abs(Number(value)) / totalValue) * 100 : 0;

  // ── 1. スライス本体の描画 ──
  const sliceGroups = arcs
    .map((arc, index) => {
      if (Math.abs(Number(arc.value)) === 0) return '';
      const path = `<path d="${buildSlicePath(arc.startAngle, arc.endAngle, cfg.pieRadius, xScale, yScale)}" fill="${colors[index]}" />`;
      const pct = percentOf(arc.value).toFixed(1);
      return `<g class="slice" data-name="${escapeXml(arc.name)}" data-percent="${pct}">${path}</g>`;
    })
    .filter(Boolean);

  // ── 2. ラベルの描画 ──
  const labelGroups: string[] = [];
  let diagnostics: Diagnostics | null = null;
  const usedChars = new Set<string>();
  const collectChars = (lines: string[]) => {
    for (const line of lines) for (const ch of String(line)) usedChars.add(ch);
  };
  if (items.length === 1) {
    const item = items[0];
    const lines = [item.name, cfg.percentFormat(item.signedValue ?? item.value)];
    collectChars(lines);
    const lineHeightLogical = cfg.lineHeightPx / cfg.pxPerUnit;
    const desiredTextY =
      -(cfg.pieRadius + cfg.singleSliceLabelOffset) - (lines.length - 1) * lineHeightLogical;
    const minTextY = cfg.canvasYlim[0] + cfg.canvasSafetyMargin;
    const labelY = Math.max(desiredTextY, minTextY);
    const text = textFragment(
      xScale,
      yScale,
      0,
      labelY,
      lines,
      { anchor: 'middle', baseline: 'top' },
      cfg,
    );
    const pct = percentOf(item.value).toFixed(1);
    labelGroups.push(
      `<g class="label" data-name="${escapeXml(item.name)}" data-percent="${pct}">${text}</g>`,
    );
  } else {
    const layout = finalLayout!;
    diagnostics = layout.diagnostics;
    const labels = layout.labels;
    // 統一カスケード (①〜⑨) でテキスト配置を確定。inside は wedge 中心で leader なし、
    // 外側は rim 配置 + overlap/pie nudge 反復 + 失敗ラベルの段階降格。leader は最終手段。
    // 上部「その他」は runLabelCascade 内で右上 vs 左上 をチャート単位で選択済 (採点のみ最終化
    // 後のコピーで実施)。最終化は下で 1 回だけ適用する。
    const textPlacements = runLabelCascade(
      labels,
      cfg,
      { xScale, yScale, width, height },
      diagnostics ?? undefined,
    );

    // 名前 → 実際に割り当てた塗り色。makeColors の末尾色ずらしを反映するため
    // index の剰余ではなく確定済み colors[] を引く。
    const colorByName = new Map<string, string>();
    items.forEach((it, idx) => {
      if (!colorByName.has(it.name)) colorByName.set(it.name, colors[idx]);
    });

    // emit 採用配置に対する最終修復パス列 (do-no-harm・順序依存)。詳細は applyEmitRepairPasses 内。
    applyEmitRepairPasses(textPlacements, cfg, { xScale, yScale, width, height }, diagnostics);

    // emit 実配置 (最終化済 textPlacements) を内部スコアラで数え diagnostics に残す。後段は再適用
    // しない (countDefects はカウントのみ)。verify_consistency が emit SVG と突き合わせ、配置判断の
    // 基準 (countDefects) が実描画と一致し続けることをアサートする。
    if (diagnostics) {
      diagnostics.finalScore = countDefects(textPlacements, cfg, { xScale, yScale, width, height });
    }

    // 確定配置 (全パス適用後) に対し、実 viewBox (`svgWidthPx`) を超える真の見切れだけを 1 回ずつ警告する。
    // `applyFinalCondenseToFit` は scoring 候補ごとにも走るため、そこで warn すると最終でない候補の超過まで
    // 大量に出て紛らわしい。ここは最終 placements かつ実 viewBox 基準 (coord) なので、件数・値が verify の
    // "label out of viewBox" (tolerance 1px) と一致する。
    for (const p of textPlacements) {
      if (p.insideSlice) continue;
      const overPx = boxViewOverflowOf(p, cfg, { xScale, yScale, width, height });
      if (overPx > 1) {
        console.warn(`[svg_export] viewBox見切れ: "${p.item.name}" 約${Math.round(overPx)}px`);
      }
    }

    // ── Pass 1: 各 placement の最終 pathPoints・暫定 skipLeader・pixel bbox を確定 ──
    // leader 形状計算は computeDrawnLeader に集約 (conflict scorer と共有し形状を一致させる)。
    const prepared = textPlacements.map((placement: Placement) => {
      const { pathPoints, detectPathPoints, skipLeader } = computeDrawnLeader(placement, cfg);

      // leader 貫通判定用に bbox / leader 点を pixel 空間へ変換 (verify と同座標系)。
      const lb = placementBox(placement, cfg);
      const pixelBox = {
        left: Math.min(xScale(lb.left), xScale(lb.right)),
        right: Math.max(xScale(lb.left), xScale(lb.right)),
        top: Math.min(yScale(lb.top), yScale(lb.bottom)),
        bottom: Math.max(yScale(lb.top), yScale(lb.bottom)),
      };
      return {
        placement,
        pathPoints,
        detectPathPoints,
        skipLeader,
        pixelBox,
        topCenterApplied: false,
      };
    });

    // ── Pass 1b: 側辺中央 leader を「上辺中央」へ寄せる (do-no-harm; ラベル位置は不変) ──
    // computeDrawnLeader は既定 (allowTopCenter=false) で side-center を返すので、上の Pass 1・採点・
    // realLeaderPaths 経由の各 metric/layout do-no-harm は全て baseline と同一幾何 = ラベル位置不変。
    // ここ (最終描画のみ) で top-center 候補 (`qualifiesTopCenterAttach`: アンカーが box 上辺より上) を
    // allowTopCenter=true で再計算し、その実描画 leader が **他ラベル box を一つも貫かず・他 leader との
    // 交差を新規に作らない** 場合に限り採用する。貫く/交差する密集ケースは side-center を維持するため、
    // leader×box の新規貫通も leader×leader の新規交差も生じない (退行0)。交差・pie 条件は近平行
    // leader が並ぶスタック (例 spreadLeftStackFullHeight 後の左列) で、接続点の付け替えだけで交差や
    // 円食い込みが生まれるのを防ぐ — metric 層 (realLeaderPaths) は side-center 幾何で測るため、
    // ここで作った交差/食い込みはどの採否ゲートにも映らず verify / verify:consistency にだけ出る。
    const toPixPts = (pts: Pt[]): Pt[] => pts.map((p) => ({ x: xScale(p.x), y: yScale(p.y) }));
    // countDefects.pie / verify:consistency の countParsedPie と同条件 (中心距離 < r − 1px)。
    const dipsIntoPie = (pts: Pt[]): boolean => {
      const limit = cfg.pieRadius - pxToLogical(cfg, 1);
      for (let k = 0; k + 1 < pts.length; k += 1) {
        const d = distPointToSegment(0, 0, pts[k].x, pts[k].y, pts[k + 1].x, pts[k + 1].y);
        if (d < limit) return true;
      }
      return false;
    };
    for (const entry of prepared) {
      if (entry.skipLeader) continue;
      if (!qualifiesTopCenterAttach(entry.placement, cfg)) continue;
      const tc = computeDrawnLeader(entry.placement, cfg, false, true);
      if (tc.skipLeader) continue;
      const tcPix = toPixPts(tc.pathPoints);
      const sidePix = toPixPts(entry.pathPoints);
      let harmful = dipsIntoPie(tc.pathPoints) && !dipsIntoPie(entry.pathPoints);
      for (let j = 0; j < prepared.length && !harmful; j += 1) {
        if (prepared[j] === entry) continue;
        if (leaderCrossesBox(tcPix, prepared[j].pixelBox)) harmful = true;
        if (!harmful && !prepared[j].skipLeader) {
          const other = toPixPts(prepared[j].pathPoints);
          if (!pathsCross(sidePix, other) && pathsCross(tcPix, other)) harmful = true;
        }
      }
      if (!harmful) {
        entry.pathPoints = tc.pathPoints;
        entry.detectPathPoints = tc.detectPathPoints;
        entry.topCenterApplied = true;
      }
    }

    // ── Pass 1c: 円周に接する 3 点 rim leader を W リルートで持ち上げる (描画のみ; ラベル位置不変) ──
    // computeDrawnLeader は既定 (allowGrazeLift=false) で rim/side-center 形状を返すため、Pass 1・採点・
    // realLeaderPaths 経由の各 metric/layout do-no-harm は全て baseline と同一幾何 = ラベル位置不変。ここ
    // (最終描画のみ) で allowGrazeLift=true で再計算し、先頭セグメントが円周をなぞる leader を二等分接線
    // 交点 W へ持ち上げる。持ち上げ後に **他 leader との交差関係が一切変わらず・他ラベル box を貫かない**
    // 場合に限り採用する (verify:consistency の crossings/pie 数を baseline 内部スコアと一致させるため)。
    // top-center 化済み (Pass 1b) は構造上 rim に接しないため対象外。
    // allowTopCenter は Pass 1b で採用した値を踏襲し (top-center 化済みなら再現した上で持ち上げる)、
    // allowGrazeLift=true で先頭セグメントの円周グレイズを W へ持ち上げる。top-center leader も先頭
    // セグメントが rim をなぞり得る (例 イギリスポンド) ため topCenterApplied も対象に含める。
    for (const entry of prepared) {
      if (entry.skipLeader) continue;
      const gl = computeDrawnLeader(entry.placement, cfg, false, entry.topCenterApplied, true);
      if (gl.skipLeader) continue;
      const before = toPixPts(entry.pathPoints);
      const after = toPixPts(gl.pathPoints);
      const unchanged =
        before.length === after.length &&
        before.every((p, i) => p.x === after[i].x && p.y === after[i].y);
      if (unchanged) continue; // グレイズ条件に当たらず持ち上げ無し
      // do-no-harm: どの他 leader とも交差の有無が変化せず、どの他 box も貫かず、円への食い込み
      // (中心距離 < r − 1px) を新規に作らないことを確認する (verify:consistency の crossings/pie 数を
      // baseline 内部スコアと一致させ、ラベルへの新規貫通も防ぐ)。
      let harmful = dipsIntoPie(gl.pathPoints) && !dipsIntoPie(entry.pathPoints);
      for (let j = 0; j < prepared.length && !harmful; j += 1) {
        if (prepared[j] === entry) continue;
        if (!prepared[j].skipLeader) {
          const other = toPixPts(prepared[j].pathPoints);
          if (pathsCross(before, other) !== pathsCross(after, other)) harmful = true;
        }
        if (!harmful && leaderCrossesBox(after, prepared[j].pixelBox)) harmful = true;
      }
      if (!harmful) {
        entry.pathPoints = gl.pathPoints;
        entry.detectPathPoints = gl.detectPathPoints;
      }
    }

    // ── Pass 1d: 水平先行 L 字 leader を斜め直線へ畳む (描画のみ; ラベル位置不変) ──
    // 「アンカー高さで水平 → ラベル手前で垂直」の 3 点 L 字は 2 折れが遠回りに見えるため、
    // allowDiagonal=true で bend をアンカーへ畳んだ 2 点の斜め直線を試す。対象は 2 系統:
    // `leaderBendFollowsEndpointX` (例 country_balanced_6 の上部ラベル) と `declipBottomLeader` の
    // 縁中央接続 (例 currency_europe_heavy_8 ノルウェー/デンマーク)。W 弦リルートが 3 点テントへ
    // 戻した (= 斜線が円へ食い込む) 場合は不採用にして現形状を維持する。do-no-harm は Pass 1c と
    // 同一セット: 他 leader との交差関係不変・他ラベル box 非貫通・円食い込み非悪化 (verify /
    // verify:consistency との整合)。lowerLeftDrop / forceTopRight の L 字は意図的形状 (bend チェーン
    // の先行分岐 or 明示除外) で対象外。scorer / realLeaderPaths は既定 false のままなので採点・
    // レイアウト選択は不変。
    for (const entry of prepared) {
      if (entry.skipLeader) continue;
      const p = entry.placement;
      const diagonalTarget = p.leaderBendFollowsEndpointX || p.declipBottomLeader === true;
      if (!diagonalTarget || p.forceTopRight || p.insideSlice) continue;
      if (entry.pathPoints.length !== 3) continue; // 既に 2 点 (縮退直線) やテント再構成は対象外
      const dg = computeDrawnLeader(p, cfg, false, entry.topCenterApplied, false, true);
      if (dg.skipLeader || dg.pathPoints.length !== 2) continue;
      const before = toPixPts(entry.pathPoints);
      const after = toPixPts(dg.pathPoints);
      let harmful = dipsIntoPie(dg.pathPoints) && !dipsIntoPie(entry.pathPoints);
      for (let j = 0; j < prepared.length && !harmful; j += 1) {
        if (prepared[j] === entry) continue;
        if (!prepared[j].skipLeader) {
          const other = toPixPts(prepared[j].pathPoints);
          if (pathsCross(before, other) !== pathsCross(after, other)) harmful = true;
        }
        if (!harmful && leaderCrossesBox(after, prepared[j].pixelBox)) harmful = true;
      }
      if (!harmful) {
        entry.pathPoints = dg.pathPoints;
        entry.detectPathPoints = dg.detectPathPoints;
      }
    }

    // ── Pass 1e: アンカーが自 box 水平範囲内へ食い込む側辺 leader を書き出し側の縦縁・縦中央
    // (9 時/3 時) 接続へ付け替える (描画のみ) ──
    // rim 縮退 placement が横シフトされアンカー x が自 box の水平範囲内に食い込むと、既定の側辺
    // 接続は「アンカー x で縦降下 → 近縁へ後退する水平尾」になり、縦区間が自ラベルをかすめ/貫き
    // 水平尾がラベルの伸長方向と逆へ伸びて見える (例 country_long_labels_9 ドイツ連邦共和国 /
    // country_12_europe_heavy デンマーク)。発火は defect 述語そのもの (`qualifiesSideEdgeCenterAttach`:
    // アンカー x が自 box 水平範囲内。own-box 貫通判定は `leaderCrossesBox` の 2px pad で 1px 未満の
    // かすめを取り逃がすため使わない)。allowSideEdgeCenter=true で書き出し側の縦縁 (start=左縁の
    // 9 時 / end=右縁の 3 時) の縦中央へ近縁外側 x の横優先 L 字で接続する形 (ユーザー選定) を試し、
    // 自 box を貫かない場合のみ採用する。do-no-harm は Pass 1c/1d と同一セット (他 leader との
    // 交差関係不変・他ラベル box 非貫通・円食い込み非悪化)。scorer / realLeaderPaths は既定 false の
    // ままなので採点・レイアウト選択は不変 (ラベル位置は動かない)。
    for (const entry of prepared) {
      if (entry.skipLeader) continue;
      const p = entry.placement;
      if (!qualifiesSideEdgeCenterAttach(p, cfg)) continue;
      const before = toPixPts(entry.pathPoints);
      const se = computeDrawnLeader(p, cfg, false, entry.topCenterApplied, false, false, true);
      if (se.skipLeader) continue;
      const after = toPixPts(se.pathPoints);
      if (leaderCrossesBox(after, entry.pixelBox)) continue; // 付け替えで自 box を貫く形は維持
      let harmful = dipsIntoPie(se.pathPoints) && !dipsIntoPie(entry.pathPoints);
      for (let j = 0; j < prepared.length && !harmful; j += 1) {
        if (prepared[j] === entry) continue;
        if (!prepared[j].skipLeader) {
          const other = toPixPts(prepared[j].pathPoints);
          if (pathsCross(before, other) !== pathsCross(after, other)) harmful = true;
        }
        if (!harmful && leaderCrossesBox(after, prepared[j].pixelBox)) harmful = true;
      }
      if (!harmful) {
        entry.pathPoints = se.pathPoints;
        entry.detectPathPoints = se.detectPathPoints;
      }
    }

    // ── Pass 1.5: 1 強スライスの冗長な rim leader を省く (ALWAYS_DRAW でも常時実行) ──
    // `buildOutsideRimDraft` 由来の rim ラベルは draft では `skipLeader=true` を意図しているが、
    // `ALWAYS_DRAW_OUTSIDE_LEADERS` 下では `computeDrawnLeader` が一律 leader を描く。そのうち 1 強
    // (≥50%) スライスの自スライス外縁に隣接する冗長な短い leader (例 アメリカ・ドル58%) は線のみ削る。
    // 採点より後段なのでレイアウト選択にも他 leader の交差解決にも影響しない (ラベル位置は不変)。
    // ラベルを貫く leader は削除せず `computeDrawnLeader` の declip 分岐が近端 (pie 側縦縁) へ接続して回避する。
    for (const entry of prepared) {
      if (entry.skipLeader) continue;
      if (isRedundantDominantRimLeader(entry.placement, entry.pathPoints, cfg)) {
        entry.skipLeader = true;
      }
    }

    // 常時描画方針 (ALWAYS_DRAW_OUTSIDE_LEADERS) のとき、以下の leader 省略 (Pass 2/2.5/2.6) は
    // 全てバイパスする。inside のみ leaderless、円外は描いた leader をそのまま残す。
    if (!ALWAYS_DRAW_OUTSIDE_LEADERS) {
      // ── Pass 2: leader が他ラベルの text bbox を貫く場合はその leader を省略 ──
      // 判定は detectPathPoints (端点を bbox 縁へ寄せる前の到達域) で行う。これにより
      // 「描画される leader の集合」が短縮前と一致し、隠れていた leader が現れて新たな
      // 交差を生むことを防ぐ。
      for (let i = 0; i < prepared.length; i += 1) {
        const entry = prepared[i];
        if (entry.skipLeader) continue;
        const pixelPts = entry.detectPathPoints.map((p: { x: number; y: number }) => ({
          x: xScale(p.x),
          y: yScale(p.y),
        }));
        for (let j = 0; j < prepared.length; j += 1) {
          if (j === i) continue;
          if (leaderCrossesBox(pixelPts, prepared[j].pixelBox)) {
            entry.skipLeader = true;
            break;
          }
        }
      }

      // ── Pass 2.5: leader 同士が交差する場合は長い方を省略 (verify の "leader crossing" と同条件) ──
      // 描画される pathPoints を pixel 空間へ変換して判定。chartConflicts と同ロジック (採点と一致)。
      {
        const lskip = prepared.map((e) => e.skipLeader);
        const pixPaths = prepared.map((e, idx) =>
          lskip[idx]
            ? null
            : e.pathPoints.map((p: { x: number; y: number }) => ({
                x: xScale(p.x),
                y: yScale(p.y),
              })),
        );
        resolveLeaderCrossings(
          pixPaths,
          prepared.map((e) => e.placement.item.name),
          lskip,
        );
        for (let i = 0; i < prepared.length; i += 1) prepared[i].skipLeader = lskip[i];
      }

      // ── Pass 2.6: 上左・小スライスの短い leader を省く (線のみ削除) ──
      // 採点 (computeDrawnLeader/chartConflicts) より後段なのでレイアウト選択にも他 leader の
      // 交差解決にも影響しない = ラベル位置は不変、対象の leader 線だけが消える。
      for (const entry of prepared) {
        if (entry.skipLeader) continue;
        if (isRedundantUpperLeftSmallLeader(entry.placement, entry.pathPoints, cfg)) {
          entry.skipLeader = true;
        }
      }
    }

    // ── Pass 3: leader / text を emit ──
    for (const { placement, pathPoints, skipLeader } of prepared) {
      const leader = skipLeader ? '' : leaderPath(xScale, yScale, pathPoints, cfg);
      // インサイド配置 & dark slice (fill index >= darkSliceFillIndexMin) なら text を白に。
      let textCfg: PieLayoutConfig = cfg;
      if (placement.insideSlice && cfg.darkSliceTextColor) {
        const fillColor = colorByName.get(placement.item.name);
        const minIdx = cfg.darkSliceFillIndexMin ?? 2;
        const fillIdx = fillColor ? cfg.grayScale4.indexOf(fillColor) : -1;
        if (fillIdx >= minIdx) {
          textCfg = { ...cfg, textColor: cfg.darkSliceTextColor };
        }
      }
      const sx = placement.nameScaleX ?? 1;
      const condense =
        sx < 1
          ? {
              nameScaleX: sx,
              // 名前分割ラベルは上行 (lines[0]=名前前半) を長体対象にする。通常ラベルは item.name。
              name: placement.nameSplit ? placement.lines[0] : placement.item.name,
              rest: placement.lines.length >= 2 ? '' : ` ${placement.item.percentText ?? ''}`,
            }
          : undefined;
      const text = textFragment(
        xScale,
        yScale,
        placement.x,
        placement.y,
        placement.lines,
        { anchor: placement.anchor, baseline: placement.baseline },
        textCfg,
        condense,
      );
      collectChars(placement.lines);
      const item = placement.item;
      const pct = percentOf(item.value).toFixed(1);
      const insideAttr = placement.insideSlice ? ` data-inside-slice="true"` : '';
      const lineCountAttr = ` data-line-count="${placement.lines.length >= 2 ? 2 : 1}"`;
      const scaleAttr = sx < 1 ? ` data-name-scale-x="${sx}"` : '';
      labelGroups.push(
        `<g class="label" data-name="${escapeXml(item.name)}" data-percent="${pct}"${insideAttr}${lineCountAttr}${scaleAttr}>${leader}${text}</g>`,
      );
    }
  }

  // ── 3. SVG 全体を結合 ──
  const fontDefs = await buildFontFaceDefs(cfg, usedChars);
  const svg = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${cfg.svgWidthPx}px" height="${cfg.svgHeightPx}px" shape-rendering="geometricPrecision">`,
    fontDefs,
    `<rect width="${width}" height="${height}" fill="${cfg.backgroundColor}" />`,
    `<g id="slices">${sliceGroups.join('')}</g>`,
    `<g id="labels">${labelGroups.join('')}</g>`,
    `</svg>`,
  ].join('');

  return { svg, diagnostics: diagnostics!, config: cfg };
}
