// =============================================================================
// svg_export/index.ts — renderPdfStylePieToSvg (public API, orchestrator)
// -----------------------------------------------------------------------------
// 入力 items → 最終 SVG 文字列を組み立てる本ライブラリの最終出力点。
// サブモジュールの責務:
//   - rendering.ts   : 座標変換 + スライス path + text 要素 + 視覚 em 推定
//   - post_layout.ts : overlap 解消 / compactify cascade / 半角カナ fallback /
//                      視覚 viewBox nudge
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

export { escapeXml } from './rendering.js';
export { distPointToSegment, pathsCross } from './leader_geometry.js';

// twoLineLeftStackMode の左列ラベルを円縁 (rim) からどれだけ外側へ離すかの mid-angle 放射係数。
// 1.0 で円ハグ (旧)。参考 PDF はラベルと円の間に ~0.3R の隙間を空け、リーダー線が長い斜め線として
// 明確に見える。anchor は rim のまま (この係数は box 位置のみに効く) なので、リーダーは rim→box の
// 長い斜め直線になる。円侵入は起きないため verify/スコアラへの影響はない。
const TWO_LINE_LEFT_OUT_FACTOR = 1.28;

// 9時線 (midAngle≈180) を挟んで縦に重なる左小スライスを「左上へ逃がす」対象とみなす帯の半幅。
// イギリス(≈189.5°)/イタリア(≈175.2°) の様に 9時線近傍で near-vertical leader が重なる対を拾う。
const NINE_OCLOCK_ESCAPE_HALF_WIDTH_DEG = 30;
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
 * `spreadLeftStackFullHeight` の整え係数。
 *   EDGE_INSET_PX: viewBox 上下端からの内側マージン (px)。右上逃がしスタックの上端
 *     (`tidyTopRightEscapeeStack` の hardTop) と揃える。
 *   MIN_GAP_FRACTION: 発火判定。隣接エアギャップの最小値が `scaledMinGap` のこの割合を下回る
 *     (= 箱がほぼ接触する) 列だけを広げる。健全に空いている列は対象外。
 *   MAX_GAP_FACTOR: 等配分ギャップの上限 (`scaledMinGap` の倍数)。少件数 × 高キャンバスで
 *     列が間延びするのを防ぐ (上限到達時は下端に届かず上端優先で止まる)。
 */
const LEFT_STACK_SPREAD_EDGE_INSET_PX = 4;
const LEFT_STACK_SPREAD_MIN_GAP_FRACTION = 0.25;
const LEFT_STACK_SPREAD_MAX_GAP_FACTOR = 2;

/**
 * leftStackMode の左列が接触級に詰まり viewBox の上下に余白を残すとき、列全体を縦全域
 * (上下端の EDGE_INSET_PX 内側) へ等エアギャップで展開する (`applyLeftStackGapClose` の広げる版)。
 *
 * 背景: 左列の積み上げ (`assignUpperLeftRenderY`) は天井超過時に圧縮する一方、収まっている時に
 * 余白へ広げる機構が無く、小スライス連続チャート (例 currency 系 10 スライス) では隣接箱が接触
 * したまま上下に余白が残る。ここで最上箱を上端へ・最下箱を下端へ届かせ、間を均等配分する。
 *
 * 手順: 箱中心の縦順 (上→下。p.y は baseline 向き混在で視覚順と食い違い得る) に、最上箱の上端 =
 * hardTop から 箱高 + airGap で下へ積む (airGap = 残余等分を scaledMinGap×MAX_GAP_FACTOR で
 * キャップ)。y は箱中心オフセット保存で移動し baseline 向き差を吸収、目標列が縦に単調なので
 * 角度順 (=値順) は構成的に保たれる。X は新しい y 区間が円と重なるラベルのみ左 rim へハグし直し
 * (`applyLeftStackGapClose` と同じ rim + pie nudge)、円キャップより完全に上/下のラベルは現状維持
 * (rim が無く、stale minTextX の clamp 引き戻しも避ける — `tidyTopRightEscapeeStack` の ⚠ 参照)。
 * 移動ラベルは skipLeader を解除し、leader は emit の描画段が最終 box から再計算して追従する。
 * do-no-harm: `emitDefectsWorsened` (一級 + through/cross 新規対 + inv) 悪化で全 revert。
 */
function spreadLeftStackFullHeight(
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
  if (minAir >= cfg.scaledMinGap * LEFT_STACK_SPREAD_MIN_GAP_FRACTION) return;

  const hardTop = logicalYAtViewBoxYPx(coord, LEFT_STACK_SPREAD_EDGE_INSET_PX);
  const hardBottom = logicalYAtViewBoxYPx(coord, cfg.svgHeightPx - LEFT_STACK_SPREAD_EDGE_INSET_PX);
  const sumH = heights.reduce((s, h) => s + h, 0);
  const airGap = Math.min(
    (hardTop - hardBottom - sumH) / (n - 1),
    cfg.scaledMinGap * LEFT_STACK_SPREAD_MAX_GAP_FACTOR,
  );
  const tol = pxToLogical(cfg, 1);
  if (airGap <= tol || airGap <= minAir + tol) return; // 広がらない再配分はしない

  const before = captureEmitDefectVec(placements, cfg, coord);
  const origX = stack.map((p) => p.x);
  const origY = stack.map((p) => p.y);
  const origSkip = stack.map((p) => Boolean(p.skipLeader));

  const pieR = cfg.pieRadius;
  let topEdge = hardTop;
  for (let i = 0; i < n; i += 1) {
    const p = stack[i];
    const h = heights[i];
    const newTop = topEdge;
    const newBottom = topEdge - h;
    // baseline (top/bottom) と y の関係を保つため、現在の y−箱中心オフセットを維持して中心を移す。
    const newY = p.y + ((newTop + newBottom) / 2 - (boxes[i].top + boxes[i].bottom) / 2);
    if (newBottom >= pieR || newTop <= -pieR) {
      // 円キャップより完全に上/下: rim が無いので X 現状維持。
      p.y = newY;
    } else {
      // 新しい y 区間が円と重なる: 左 rim へハグし直す。rim X は箱の赤道寄り端で測る
      // (baseline 直用だと |y| ≥ r 付近で x が 0 へ潰れて箱が円上へ飛ぶ)。
      const yRef = newBottom > 0 ? newBottom : newTop < 0 ? newTop : 0;
      const rimXmag = Math.sqrt(Math.max(0, pieR * pieR - yRef * yRef));
      const measured = placementExtent(p, cfg);
      const nudged = nudgeTextAwayFromPie(-rimXmag, newY, p.anchor, p.baseline, measured, cfg);
      p.x = nudged.x;
      p.y = nudged.y;
    }
    // ⚠ どちらの枝でも `clampPlacement` は呼ばない: 静的 pie クランプ (scaledLabelRadius 基準) が
    // 極寄りの新 y でも旧位置相当まで x を左へ引き戻し、箱左端が viewBox を割る clips を新規に作る
    // (`tidyTopRightEscapeeStack` の stale minTextX と同型)。pie クリアランスは上の
    // `nudgeTextAwayFromPie` が現在 y で保証し、その他の悪化は下の do-no-harm ゲートが拾う。
    // 前段 gap-close が rim ハグ前提で立てた leader 抑制を解除 (縮退判定は leader 再計算が行う)。
    p.skipLeader = false;
    topEdge = newBottom - airGap;
  }

  if (emitDefectsWorsened(before, placements, cfg, coord)) {
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
 * verify と同基準 (ALWAYS_DRAW: leader を抑制せず実描画) で最終不具合数を数える。chartConflicts は
 * 交差 leader を skipLeader 抑制して数えないため、ALWAYS_DRAW 描画で実際に出る交差を取りこぼす
 * (= spread が直す交差を off 側で 0 と誤評価する)。spread 採否は実描画基準で比較する必要があるので
 * 専用に数える。コピーを実 render と同じ後段 (nudge/condense/relax/交差引き離し/9時逃がし) で
 * 最終化してから、交差・円内貫通・viewBox 見切れ・box 重なりを数える。off/on を同関数で比較する。
 */
function countVerifyIssues(
  placements: Placement[],
  cfg: PieLayoutConfig,
  coord: Coord,
  leftStackMode = false,
): number {
  return countVerifyIssuesDetailed(placements, cfg, coord, leftStackMode).total;
}

export interface DefectCounts {
  clips: number;
  crossings: number;
  pie: number;
  total: number;
}

/**
 * placements を **emit と同一の後段** で最終化したコピーを返す (採点を実描画基準へ揃える)。
 * 後段順は `EMIT_REPAIR_PASSES` の stage='both'/'scoring' エントリをテーブル順に適用したもので、
 * emit 列と同一テーブルから生成される (パス追加時の scoring↔emit drift を構造的に防ぐ)。
 * leftStackMode を渡さないと leftStackMode 限定の最終 re-stack を取りこぼし採点が emit とズレる。
 *
 * 修復系・fallback 系 (stage 無指定 = emit 限定。`repairResidualLeaderDefects` 等) はここに入れない。
 * 採点へ入れると「修復で直る前提」のスコアでチャート単位の候補選択 (ソノホカ右/左・spread 等) が
 * 動き、修復しきれない別候補を選ぶ退行を生む (例 currency_many_small_10)。finalScore は emit 後の
 * 同一 placements から数えるため scorer ↔ emit の整合 (verify_consistency) はこの除外でも崩れない。
 */
function finalizeForScoring(
  placements: Placement[],
  cfg: PieLayoutConfig,
  coord: Coord,
  leftStackMode = false,
): Placement[] {
  const copy = placements.map((p) => ({ ...p }));
  // `when` 述語は leftStackMode しか読まないため、採点側は最小の Diagnostics 形で受け渡す。
  const diag = leftStackMode ? ({ leftStackMode: true } as Diagnostics) : null;
  for (const pass of EMIT_REPAIR_PASSES) {
    if (pass.stage !== 'both' && pass.stage !== 'scoring') continue;
    if (pass.when && !pass.when(diag)) continue;
    (pass.scoringRun ?? pass.run)(copy, cfg, coord);
  }
  return copy;
}

/**
 * **最終化済み** placements の不具合を数える (パスは再適用しない)。verify と同基準
 * (ALWAYS_DRAW: leader を抑制せず実描画)。clips=viewBox 見切れ、crossings=leader 交差数、
 * pie=leader 円内貫通数、total=総不具合数。emit 実配置 (diagnostics.finalScore) と採点の双方が
 * これを共有し、scorer ↔ emit SVG の一致 (verify_consistency) を担保する。
 */
function countDefects(finalized: Placement[], cfg: PieLayoutConfig, coord: Coord): DefectCounts {
  const { xScale, yScale, width, height } = coord;
  const pboxes = finalized.map((p) => {
    const lb = placementBox(p, cfg);
    return {
      left: Math.min(xScale(lb.left), xScale(lb.right)),
      right: Math.max(xScale(lb.left), xScale(lb.right)),
      top: Math.min(yScale(lb.top), yScale(lb.bottom)),
      bottom: Math.max(yScale(lb.top), yScale(lb.bottom)),
    };
  });
  let clips = 0;
  let issues = 0;
  for (let i = 0; i < finalized.length; i += 1) {
    const b = pboxes[i];
    if (b.left < -1 || b.right > width + 1 || b.top < -1 || b.bottom > height + 1) {
      issues += 1;
      clips += 1;
    }
  }
  for (let i = 0; i < finalized.length; i += 1) {
    for (let j = i + 1; j < finalized.length; j += 1) {
      const a = pboxes[i];
      const b = pboxes[j];
      const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (ox > 0 && oy >= 6) issues += 1;
    }
  }
  const crossings = countLeaderCrossings(finalized, cfg, coord);
  issues += crossings;
  const paths = realLeaderPaths(finalized, cfg, coord);
  const cx = xScale(0);
  const cy = yScale(0);
  const pieR = Math.abs(xScale(cfg.pieRadius) - xScale(0));
  let pie = 0;
  for (const path of paths) {
    if (!path) continue;
    for (let k = 0; k + 1 < path.length; k += 1) {
      if (
        distPointToSegment(cx, cy, path[k].x, path[k].y, path[k + 1].x, path[k + 1].y) <
        pieR - 1
      ) {
        issues += 1;
        pie += 1;
        break;
      }
    }
  }
  return { clips, crossings, pie, total: issues };
}

/**
 * countVerifyIssues の内訳版。placements を emit と同一後段で最終化してから不具合を数える。
 * 2 行維持の採否で「clips を減らすが crossings/pie は増やさない」判定等に使う。
 */
function countVerifyIssuesDetailed(
  placements: Placement[],
  cfg: PieLayoutConfig,
  coord: Coord,
  leftStackMode = false,
): DefectCounts {
  return countDefects(finalizeForScoring(placements, cfg, coord, leftStackMode), cfg, coord);
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
function applyTwoLineNameFallback(
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
function applyVerticalDeclipFallback(
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
function applyLowerLeftDropFallback(
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
 */
function applyTopBandClusterReorder(placements: Placement[], cfg: PieLayoutConfig): void {
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
function stackTopRightLiftedLabels(placements: Placement[], cfg: PieLayoutConfig): void {
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
 * emit 修復パス共通の defect スナップショット。一級 (`countDefects` の clips/crossings/pie/total) に
 * 加え、`countDefects` が数えない二級 defect (leader のラベル箱貫通 through / leader 同士の交差
 * cross / 角度順逆転 inv) を持つ。ゲートは `emitDefectsWorsened` と対で使う。
 */
interface EmitDefectVec {
  defects: ReturnType<typeof countDefects>;
  through: Set<string>;
  cross: Set<string>;
  inv: number;
}

/** 現在の placements から `EmitDefectVec` を採取する (do-no-harm ゲートの before 側)。 */
function captureEmitDefectVec(
  placements: Placement[],
  cfg: PieLayoutConfig,
  coord: Coord,
): EmitDefectVec {
  return {
    defects: countDefects(placements, cfg, coord),
    through: leaderThroughPairs(placements, cfg, coord),
    cross: leaderCrossingPairs(placements, cfg, coord),
    inv: countAngularDiscordantPairs(placements, cfg, coord),
  };
}

/**
 * before 採取時より defect が悪化したか (do-no-harm ゲートの after 側)。一級は各カテゴリ非増加、
 * 二級の through/cross は**新規対なし** (件数同数でも別の対へ移れば悪化)、inv は非増加を要求する。
 */
function emitDefectsWorsened(
  before: EmitDefectVec,
  placements: Placement[],
  cfg: PieLayoutConfig,
  coord: Coord,
): boolean {
  const after = countDefects(placements, cfg, coord);
  return (
    after.clips > before.defects.clips ||
    after.crossings > before.defects.crossings ||
    after.pie > before.defects.pie ||
    after.total > before.defects.total ||
    hasNewPair(leaderThroughPairs(placements, cfg, coord), before.through) ||
    hasNewPair(leaderCrossingPairs(placements, cfg, coord), before.cross) ||
    countAngularDiscordantPairs(placements, cfg, coord) > before.inv
  );
}

/** viewBox の縦 px 位置に対応する論理 y。yScale は線形なので 2 点から逆算する。 */
function logicalYAtViewBoxYPx(coord: Coord, yPx: number): number {
  const yA = coord.yScale(0);
  const yB = yA - coord.yScale(1); // 1 論理単位あたりの px (y 下向き)
  return (yA - yPx) / yB;
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
function tidyTopRightEscapeeStack(
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

// leader メトリクス層 (pathsCross / realLeaderPaths / countLeaderCrossings /
// countLeaderThroughLabels / box*Max / projectBoxesToPixels / oobLeaderCount / angularStacks /
// countAngularDiscordantPairs) は ./leader_geometry.js へ分離した。

/**
 * 同一側 (left/right) の外側 leader が交差するとき、交差ペアを縦に引き離してから既存の box ベース
 * de-collision (resolveLabelOverlaps) で隣接ラベルへ波及解消させ、交差を解く。
 *
 * 背景: ラベルは概ね角度順に並ぶが、9時/3時線を跨ぐ2枚 (例 カナダ sin<0 / イタリア sin>0) は
 * 自然 rim Y が共に≈0 で同じ高さに重なり、baseline が逆向き (上箱/下箱) で box が重ならないため
 * de-collision が効かず、短い L 字 leader が中心付近で絡んで交差する。縦順の入れ替えでは直らない
 * (スロットが同一高) ため、角度の高い方を上・低い方を下へ box が干渉しない中心間距離まで実際に
 * 引き離す。引き離しで隣接 box が重なるが、それは resolveLabelOverlaps が X を考慮して波及分離
 * する (角度方向に異なる X のラベルは縦に重なってよい = 1次元 spread と違い viewBox を破綻させない)。
 *
 * 判定・採用は emit と同じ実描画パス (computeDrawnLeader, pixel) の交差数で行う (proxy 直線では
 * L 字折れ由来の交差を取りこぼす)。交差が減り・既存重なり非悪化・viewBox 内のときだけ採用、
 * そうでなければ side の全ラベルを revert (do-no-harm, 退行0)。交差が無い側は一切触らない。
 */
function separateCrossingPairs(
  placements: Placement[],
  cfg: PieLayoutConfig,
  coord: Coord,
  side: 'left' | 'right',
): void {
  // side は実描画 (p.x の符号) で判定する。item.side / flipToRight / flipToLeft は logical layout
  // のフラグで、cascade の rim 配置はこれらを無視して midAngle で置くため実描画サイドと乖離し得る
  // (例: flipToRight=true のまま左に描かれたラベルが修復対象から漏れ、交差が直せない)。
  const stack = placements.filter(
    (p) => !p.item.clusterTopBand && !p.insideSlice && (side === 'left' ? p.x < 0 : p.x > 0),
  );
  if (stack.length < 2) return;
  const inStack = new Set(stack);
  const tol = pxToLogical(cfg, 2);
  const yLo = cfg.canvasYlim[0];
  const yHi = cfg.canvasYlim[1];
  // 全 placement 対の最大縦重なり (X が重なる対のみ)。resolveLabelOverlaps が他ラベルも動かすため
  // stack 内に閉じず全体で測る。
  const maxOverlap = (): number => boxOverlapMax(placements, cfg);
  const anyOutOfView = (): boolean =>
    placements.some((p) => {
      const bx = placementBox(p, cfg);
      return bx.top > yHi + tol || bx.bottom < yLo - tol;
    });
  // 円外ラベル box の pie 円 (中心=logical 原点) への最大侵入量。引き離しで縦に動いた box が
  // 円へ食い込むのを do-no-harm で弾くため (maxOverlap は box×box のみで pie 侵入を見ない)。
  const maxPieIntrusion = (): number => boxPieIntrusionMax(placements, cfg);

  const beforeCross = countLeaderCrossings(placements, cfg, coord);
  if (beforeCross === 0) return; // 交差が無ければ触らない (OK チャートを乱さない)
  const beforeOverlap = maxOverlap();
  const beforeOutOfView = anyOutOfView();
  const beforePie = maxPieIntrusion();
  const snapshot = placements.map((p) => ({ p, x: p.x, y: p.y }));
  const sinOf = (p: Placement) => Math.sin(degToRad(p.item.midAngle ?? 0));

  // 交差ペア (両方 stack 内) を 1 つずつ引き離し、毎回 resolveLabelOverlaps で波及解消。
  for (let pass = 0; pass < stack.length; pass += 1) {
    const paths = realLeaderPaths(placements, cfg, coord);
    let pair: [Placement, Placement] | null = null;
    for (let i = 0; i < placements.length && !pair; i += 1) {
      const pa = paths[i];
      if (!pa || !inStack.has(placements[i])) continue;
      for (let j = i + 1; j < placements.length; j += 1) {
        const pb = paths[j];
        if (pb && inStack.has(placements[j]) && pathsCross(pa, pb)) {
          pair = [placements[i], placements[j]];
          break;
        }
      }
    }
    if (!pair) break;
    const a = sinOf(pair[0]) >= sinOf(pair[1]) ? pair[0] : pair[1]; // 角度が高い (上) 側
    const b = a === pair[0] ? pair[1] : pair[0]; // 低い (下) 側
    const ba = placementBox(a, cfg);
    const bb = placementBox(b, cfg);
    const offA = (ba.top + ba.bottom) / 2 - a.y;
    const offB = (bb.top + bb.bottom) / 2 - b.y;
    const reqGap = (ba.top - ba.bottom) / 2 + (bb.top - bb.bottom) / 2 + cfg.scaledMinGap;
    const sum = a.y + b.y;
    const diff = reqGap - (offA - offB); // box 中心間を reqGap にする y 差 (a を上, b を下)
    a.y = (sum + diff) / 2;
    b.y = (sum - diff) / 2;
    // 引き離しで生じた box 重なりを既存 de-collision で波及解消 (X 考慮で縦詰めしすぎない)。
    resolveLabelOverlaps(stack, cfg);
  }

  const afterCross = countLeaderCrossings(placements, cfg, coord);
  const afterOverlap = maxOverlap();
  const harm =
    afterCross >= beforeCross ||
    afterOverlap > beforeOverlap + tol ||
    maxPieIntrusion() > beforePie + tol ||
    (anyOutOfView() && !beforeOutOfView);
  if (harm) {
    for (const { p, x, y } of snapshot) {
      p.x = x;
      p.y = y;
    }
  }
}

/**
 * 同一側 (left/right) の外側 leader ラベルの「縦順 != 角度順」逆転を、隣接ペアの (y, baseline)
 * スワップで解消する。separateCrossingPairs は交差の厳密減少を要求するため、leader が平行で
 * 幾何交差0 のまま順序だけ逆転している対 (例: その他末尾固定により 香港ドル(2.0%) が スイスフラン
 * (2.5%) より上の角度に居るのに下に置かれる) を直せない。本パスは交差非増加 + 重なり/pie/viewBox
 * 非悪化を条件に、角度順 (sin(midAngle) 降順 = 上) へ近づける隣接スワップだけを採用する。
 *
 * 手順: 側のラベルを box 縦中心で上→下に並べ、隣接で上が低 sin の対を見つけたら (y, baseline) を
 * 交換し、両者を新 Y で左/右 rim にハグし直して (computeDrawnLeader の rim 端点はラベルと同 delta で
 * 動くだけなので X 再ハグが必須)、resolveLabelOverlaps で波及解消する。スワップ単体を do-no-harm
 * 判定し、悪化したらそのスワップだけ revert。各成功スワップは逆転数を厳密に減らすので必ず停止する。
 * 逆転が無い側は内ループで該当0 → 無変更 (verifier-clean チャートは不変, 退行0)。
 */
function untangleAngularOrderBySwap(
  placements: Placement[],
  cfg: PieLayoutConfig,
  coord: Coord,
  side: 'left' | 'right',
  // nudgeBeforeGate=true (emit 最終段のみ): swap 適用後、当事者 2 枚を viewBox 内へ水平に
  // 引き戻してから do-no-harm を判定する。swap 直後の生配置は幅広ラベルが狭い側の x スロットを
  // 継承して viewBox を割り、正しいスワップが view 悪化で却下される (country_12_europe_heavy:
  // デンマーク↔ノルウェー、view 0→48.5px)。上段スロットは円頂上より上で pie 制約が無く全量
  // 引き戻せるため、採否は引き戻し後の実 emit 相当の姿で測る。採点列に入れない理由は
  // escapeTopBandSeamLeader の thorough と同じ (修復前提のスコアが候補選択を歪める)。
  nudgeBeforeGate = false,
): void {
  // side は実描画 (p.x の符号) で判定 (separateCrossingPairs と同理由: flip フラグは実描画
  // サイドと乖離し得るため、フラグ持ちを除外すると逆転ペアが修復対象から漏れる)。
  const stack = placements.filter(
    (p) =>
      !p.item.clusterTopBand &&
      !p.insideSlice &&
      // 意図的に角度順を破る/固定する その他 (コア帯右上逃がし・左拡張帯の真上垂直固定・
      // forceTopRight) のみ除外 (angularStacks と同条件)。帯外 (>122°) で左右スタックに通常
      // 配置された その他 は逆転修復の対象に含める。
      !(
        isOtherCategory(p.item.name) &&
        (topBandSonohokaZone(p.item) !== null || p.forceTopRight)
      ) &&
      (side === 'left' ? p.x < 0 : p.x > 0),
  );
  if (stack.length < 2) return;

  const tol = pxToLogical(cfg, 2);
  const tolPx = 2;
  const yLo = cfg.canvasYlim[0];
  const yHi = cfg.canvasYlim[1];
  const pieR = cfg.pieRadius;
  const sinOf = (p: Placement) => Math.sin(degToRad(p.item.midAngle ?? 0));
  const centerY = (p: Placement): number => {
    const b = placementBox(p, cfg);
    return (b.top + b.bottom) / 2;
  };

  // do-no-harm 指標 (separateCrossingPairs / escapeUpperLeftTinyLeaders と同性質, 全 placement 横断)。
  const maxOverlap = (): number => boxOverlapMax(placements, cfg);
  const maxPieIntrusion = (): number => boxPieIntrusionMax(placements, cfg);
  const maxViewOverflow = (): number => boxViewOverflowMax(placements, cfg, coord);
  const anyOutOfView = (): boolean =>
    placements.some((p) => {
      const bx = placementBox(p, cfg);
      return bx.top > yHi + tol || bx.bottom < yLo - tol;
    });

  const rehug = (p: Placement): void => {
    // 新 Y で rim にハグする X (= ±sqrt(r^2 - y^2)) を起点に pie クリアランス nudge。
    const rimXmag = Math.sqrt(Math.max(0, pieR * pieR - p.y * p.y));
    const measured = placementExtent(p, cfg);
    const nudged = nudgeTextAwayFromPie(
      side === 'left' ? -rimXmag : rimXmag,
      p.y,
      p.anchor,
      p.baseline,
      measured,
      cfg,
    );
    p.x = nudged.x;
    p.y = nudged.y;
    clampPlacement(p);
  };

  // swap 後の当事者を viewBox 内へ水平に引き戻す (nudgeBeforeGate 用)。`applyVisualViewBoxNudge` は
  // compact 1 行ラベルを対象外にするためここでは使えない (「デンマーク 2.0%」等が引き戻せない)。
  // 引き戻しで生じうる pie 食い込みは `nudgeTextAwayFromPie` が防ぎ、なお残る悪化は evalHarm が却下する。
  const pullIntoView = (p: Placement): void => {
    const halfW = cfg.svgWidthPx / 2 / cfg.pxPerUnit;
    const b = placementBox(p, cfg);
    let shift = 0;
    if (b.left < -halfW) shift = -halfW - b.left;
    else if (b.right > halfW) shift = halfW - b.right;
    if (shift === 0) return;
    const measured = placementExtent(p, cfg);
    const nudged = nudgeTextAwayFromPie(p.x + shift, p.y, p.anchor, p.baseline, measured, cfg);
    p.x = nudged.x;
    p.y = nudged.y;
  };

  for (let outer = 0; outer < stack.length; outer += 1) {
    stack.sort((a, b) => centerY(b) - centerY(a)); // 上 → 下 (logical y 降順)
    let swapped = false;
    for (let i = 0; i + 1 < stack.length; i += 1) {
      const up = stack[i]; // 上
      const lo = stack[i + 1]; // 下
      if (sinOf(up) >= sinOf(lo) - 1e-9) continue; // 既に正順 (上が高 sin)
      const beforeInv = countAngularDiscordantPairs(placements, cfg, coord);
      const beforeCross = countLeaderCrossings(placements, cfg, coord);
      const beforeOverlap = maxOverlap();
      const beforePie = maxPieIntrusion();
      const beforeView = maxViewOverflow();
      const beforeOutOfView = anyOutOfView();
      const snapshot = placements.map((p) => ({
        p,
        x: p.x,
        y: p.y,
        baseline: p.baseline,
        skipLeader: p.skipLeader,
      }));
      // 候補1: footprint 保存スワップ (x/y/baseline を丸ごと交換)。rehug は新 Y の rim X を
      // 再計算するため、円頂上より上のスロット (rimX=0) では幅広ラベルが viewBox を割り、
      // 正しいスワップが do-no-harm で却下される (例 usd_heavy_9 豪ドル↔スイスフラン)。
      // 既存スロットの X をそのまま使えば箱の占有域は対そのままで、はみ出しは生じない。
      const trySwap = (swapX: boolean): void => {
        const ty = up.y;
        up.y = lo.y;
        lo.y = ty;
        const tb = up.baseline;
        up.baseline = lo.baseline;
        lo.baseline = tb;
        if (swapX) {
          const tx = up.x;
          up.x = lo.x;
          lo.x = tx;
        } else {
          rehug(up);
          rehug(lo);
        }
        resolveLabelOverlaps(stack, cfg);
        if (nudgeBeforeGate) {
          pullIntoView(up);
          pullIntoView(lo);
        }
      };
      // 採用条件: 角度順 discordant 対 (Kendall) が厳密に減り、かつ交差/重なり/pie/viewBox が悪化しない
      // 時のみ。verify の隣接逆転指標だと 3 要素以上の乱れで逆転が別対へ移るだけで総数が減らず採用
      // されない (例 韓国/スペイン/NZ)。全対の discordant 数なら 1 スワップごとに厳密に減る。
      // rehug 後はアンカーがラベルに追随するため sin 順だけでは判定できず、実描画ベースの本指標が要る。
      const evalHarm = (): boolean => {
        const afterInv = countAngularDiscordantPairs(placements, cfg, coord);
        return (
          afterInv >= beforeInv ||
          countLeaderCrossings(placements, cfg, coord) > beforeCross ||
          maxOverlap() > beforeOverlap + tol ||
          maxPieIntrusion() > beforePie + tol ||
          maxViewOverflow() > beforeView + tolPx ||
          (anyOutOfView() && !beforeOutOfView)
        );
      };
      const restore = (): void => {
        for (const s of snapshot) {
          s.p.x = s.x;
          s.p.y = s.y;
          s.p.baseline = s.baseline;
          s.p.skipLeader = s.skipLeader;
        }
      };
      let adopted = false;
      for (const swapX of [true, false]) {
        trySwap(swapX);
        const harm = evalHarm();
        if (process.env.PIE_CHART_DEBUG_REPAIR) {
          console.error(
            `[untangle ${side}] swap${swapX ? '(footprint)' : '(rehug)'} "${up.item.name}"<->"${lo.item.name}": ` +
              `inv ${beforeInv}->${countAngularDiscordantPairs(placements, cfg, coord)}, ` +
              `cross ${beforeCross}->${countLeaderCrossings(placements, cfg, coord)}, ` +
              `ovl ${beforeOverlap.toFixed(3)}->${maxOverlap().toFixed(3)}, pie ${beforePie.toFixed(3)}->${maxPieIntrusion().toFixed(3)}, ` +
              `view ${beforeView.toFixed(1)}->${maxViewOverflow().toFixed(1)}, oov ${beforeOutOfView}->${anyOutOfView()} => ${harm ? 'REJECT' : 'ADOPT'}`,
          );
        }
        if (!harm) {
          adopted = true;
          break;
        }
        restore();
      }
      if (adopted) {
        swapped = true;
        break;
      }
    }
    if (!swapped) break;
  }
}

/** 左右両側で交差する外側 leader を、その側のラベルを角度順に並べ直して解消する。 */
function applyOutsideLeaderAngularOrder(
  placements: Placement[],
  cfg: PieLayoutConfig,
  coord: Coord,
  // thorough=true (emit のみ): untangle の swap 採否を nudge 後の姿で判定する (詳細は
  // `untangleAngularOrderBySwap` の nudgeBeforeGate コメント)。採点側は従来 (false) のまま。
  thorough = false,
): void {
  separateCrossingPairs(placements, cfg, coord, 'left');
  separateCrossingPairs(placements, cfg, coord, 'right');
  // 交差0 のまま順序だけ逆転している隣接対を (y, baseline) スワップで角度順へ寄せる (do-no-harm)。
  untangleAngularOrderBySwap(placements, cfg, coord, 'left', thorough);
  untangleAngularOrderBySwap(placements, cfg, coord, 'right', thorough);
}

/** reorderLeftStackWithCondense が許容する viewBox はみ出し増の上限 (px)。≈1 行高。 */
const VIEW_OVERFLOW_CAP_PX = 24;

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
function reorderLeftStackWithCondense(
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
function separateLeftColumnByHeight(
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
function relieveLeftStackSpacing(
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
 * 汎用: 外側ラベルの 1 列 (片側) で隣接 box が縦に **重なる** (中心間距離 < 両 box 高の平均 = 接する最小)
 * 箇所を、上下対称に拡げて解消する。`applyLeftStackGapClose` の逆操作 — あちらは過大ギャップを **縮める**
 * が、密スタックで L1 ラベルが box 高未満に詰まる (例 currency_many_small_10 の スイスフラン↔
 * スウェーデンクローナ ≈ 20px < 30px) ケースは拡げる処理が無く重なったまま残る。本処理がその過小ギャップ
 * 拡大を担う。`relieveOutsideColumnOverlap` が左右両列に対して呼ぶ (leftStackMode 非依存)。
 *
 * 縦のみ移動 (X は保持。leader は p.y 変更に追従して再描画される)。`clampPlacement` で viewBox 内へ収める
 * (天井/床で頭打ちなら不足分は残す = 部分緩和)。do-no-harm: この列内の最大縦重なりが厳密減少し、かつ
 * 全 placement 横断の重なり / pie 侵入 / leader 交差 / leader 貫通 / viewBox はみ出しのいずれも増やさない
 * 時だけ採用、でなければ列ごと revert (退行0)。emit でのみ呼ぶ。
 */
function relieveColumnOverlap(
  stack: Placement[],
  placements: Placement[],
  cfg: PieLayoutConfig,
  coord: Coord,
): void {
  if (stack.length < 2) return;
  stack.sort((a, b) => b.y - a.y); // logical y 降順 = 視覚 上 → 下

  const tol = pxToLogical(cfg, 2);
  const boxes = stack.map((p) => placementBox(p, cfg));
  const centers = boxes.map((b) => (b.top + b.bottom) / 2);
  const heights = boxes.map((b) => Math.abs(b.top - b.bottom));

  // 過小ギャップを **対称** に拡げる (上側を上・下側を下へ d/2 ずつ。reorderLeftStackWithCondense と同手)。
  // 片側押し上げだと最上段が天井 clamp に当たり実効改善が出ない (例 currency_many_small_10) ため、
  // 下段の余裕 (L2 間の広いギャップ) へも逃がせる対称分配にする。working `ys` (= 中心) を反復緩和し
  // 収束後の差分を shift とする。中心移動量 == p.y (anchor) 移動量なので shift をそのまま p.y に足せる。
  const ys = centers.slice();
  for (let iter = 0; iter < 16; iter += 1) {
    let moved = false;
    for (let i = 0; i + 1 < stack.length; i += 1) {
      const minCenterGap = (heights[i] + heights[i + 1]) / 2;
      const cur = ys[i] - ys[i + 1];
      if (cur < minCenterGap - tol) {
        const d = (minCenterGap - cur) / 2;
        ys[i] += d;
        ys[i + 1] -= d;
        moved = true;
      }
    }
    if (!moved) break;
  }
  const shift = ys.map((y, i) => y - centers[i]);
  const needAny = shift.some((s) => Math.abs(s) > tol);
  if (!needAny) return;

  // 局所 (スタック内) の重なりが改善したかを主指標にする。全 placement 横断の maxOverlap は他所の
  // tight 対が支配して局所改善を覆い隠す (例 currency_many_small_10 は別所に同等の tight があり全体
  // 最大が下がらない) ため、採否は「スタック内重なりが厳密減 かつ 全体を悪化させない」で判定する。
  const localOverlap = (): number => boxOverlapMax(stack, cfg);
  const maxOverlap = (): number => boxOverlapMax(placements, cfg);
  const maxPie = (): number => boxPieIntrusionMax(placements, cfg);
  const maxView = (): number => boxViewOverflowMax(placements, cfg, coord);
  const beforeLocal = localOverlap();
  const beforeOverlap = maxOverlap();
  const beforePie = maxPie();
  const beforeView = maxView();
  const beforeCross = countLeaderCrossings(placements, cfg, coord);
  const beforeThrough = countLeaderThroughLabels(placements, cfg, coord);
  const snapshot = stack.map((p) => ({ p, x: p.x, y: p.y }));

  // 縦のみ移動 (X は保持)。これらのラベルは declip 配置で rim ハグ位置に居ないため、X を rim へ
  // 再ハグすると横位置が乱れて新規重なりを生む (applyLeftStackGapClose は skipLeader=true で rim
  // ハグするが、本パスは leader を残すので X を動かさない)。leader は p.y 変更に追従して再描画される。
  for (let i = 0; i < stack.length; i += 1) {
    if (Math.abs(shift[i]) <= tol) continue;
    const p = stack[i];
    p.y += shift[i];
    clampPlacement(p);
  }

  const improved = localOverlap() < beforeLocal - tol;
  const harm =
    !improved ||
    maxOverlap() > beforeOverlap + tol ||
    maxPie() > beforePie + tol ||
    maxView() > beforeView + tol ||
    countLeaderCrossings(placements, cfg, coord) > beforeCross ||
    countLeaderThroughLabels(placements, cfg, coord) > beforeThrough;
  if (harm) {
    for (const s of snapshot) {
      s.p.x = s.x;
      s.p.y = s.y;
    }
  }
}

/**
 * 汎用: 左右両方の外側ラベル列について `relieveColumnOverlap` で過小ギャップ (縦重なり) を解消する。
 * 列の所属は実描画サイド (anchor=end かつ x<0 → 左列 / anchor=start かつ x>0 → 右列) で判定し flip 済も
 * 正しく拾う。各列は独立に do-no-harm 評価される。leftStackMode など特定モードに依存しない。
 */
function relieveOutsideColumnOverlap(
  placements: Placement[],
  cfg: PieLayoutConfig,
  coord: Coord,
): void {
  const left = placements.filter((p) => !p.insideSlice && p.anchor === 'end' && p.x < 0);
  const right = placements.filter((p) => !p.insideSlice && p.anchor === 'start' && p.x > 0);
  relieveColumnOverlap(left, placements, cfg, coord);
  relieveColumnOverlap(right, placements, cfg, coord);
}

/**
 * 汎用: viewBox 左右端を見切れる **外側ラベル** を、pie へ向けて寄せて見切れを減らす (左ラベルは右へ・
 * 右ラベルは左へ)。declip / cascade 配置で本来の rim ハグ位置より外へ押し出されたラベル (例
 * currency_many_small_10 の スウェーデンクローナ: 右端が隣の ノルウェークローネ より約 100px 左) を、pie
 * クリアランス限界 (= `nudgeTextAwayFromPie` が返す rim ハグ X = pie 側辺が pieRadius+clearance に接する
 * 最も pie 寄りの anchor 位置) まで戻す。これ以上 pie 側へは食い込むため寄せられない (= 横方向の上限)。
 *
 * 見切れの大きい順に 1 枚ずつ貪欲適用し、各手は do-no-harm: viewBox はみ出し最大が厳密減少し、かつ
 * pie 侵入 / 重なり / leader 交差 / leader 貫通 のいずれも増やさない時だけ採用、でなければその 1 枚を
 * revert (退行0)。縦位置は変えず X のみ動かす (leader は追従再描画)。emit でのみ呼ぶ。leftStackMode
 * など特定モードに依存せず、全チャートの外側ラベルへ働く (do-no-harm なので収まっている図は無変更)。
 */
function pullOutsideOverflowTowardPie(
  placements: Placement[],
  cfg: PieLayoutConfig,
  coord: Coord,
): void {
  const tol = pxToLogical(cfg, 2);
  const halfW = cfg.svgWidthPx / 2 / cfg.pxPerUnit;
  const pieR = cfg.pieRadius;
  // anchor=end → 左ラベル (pie 側辺=右端、右へ寄せる)。anchor=start → 右ラベル (pie 側辺=左端、左へ寄せる)。
  // middle (内側等) は対象外。flip 済みは実描画サイドが anchor と一致するのでそのまま扱える。
  const candidates = placements
    .map((p) => {
      if (p.insideSlice) return null;
      if (p.anchor !== 'end' && p.anchor !== 'start') return null;
      const b = placementBox(p, cfg);
      const over = p.anchor === 'end' ? -halfW - b.left : b.right - halfW;
      return over > tol ? { p, over } : null;
    })
    .filter((e): e is { p: Placement; over: number } => e !== null)
    .sort((a, b) => b.over - a.over); // 見切れ量の大きい順 (最も目立つ見切れから戻す)。
  if (candidates.length === 0) return;

  const maxOverlap = (): number => boxOverlapMax(placements, cfg);
  const maxPie = (): number => boxPieIntrusionMax(placements, cfg);
  const maxView = (): number => boxViewOverflowMax(placements, cfg, coord);

  for (const { p } of candidates) {
    // rim ハグ X (pie 側辺が pieRadius+clearance に接する最も pie 寄りの anchor 位置)。左ラベルは
    // pie 中心の左 (-rimXmag) 側、右ラベルは右 (+rimXmag) 側でハグする。
    const rimXmag = Math.sqrt(Math.max(0, pieR * pieR - p.y * p.y));
    const seedX = p.anchor === 'end' ? -rimXmag : rimXmag;
    const measured = placementExtent(p, cfg);
    const hugX = nudgeTextAwayFromPie(seedX, p.y, p.anchor, p.baseline, measured, cfg).x;
    // pie へ向かう向き (左ラベル=右/+、右ラベル=左/-) にのみ動かす。逆向き (外へ) は見切れを増やすので不可。
    const movesTowardPie = p.anchor === 'end' ? hugX > p.x + tol : hugX < p.x - tol;
    if (!movesTowardPie) continue;

    const beforeOverlap = maxOverlap();
    const beforePie = maxPie();
    const beforeView = maxView();
    const beforeCross = countLeaderCrossings(placements, cfg, coord);
    const beforeThrough = countLeaderThroughLabels(placements, cfg, coord);
    const origX = p.x;

    p.x = hugX;
    clampPlacement(p);

    const harm =
      maxView() >= beforeView - tol ||
      maxOverlap() > beforeOverlap + tol ||
      maxPie() > beforePie + tol ||
      countLeaderCrossings(placements, cfg, coord) > beforeCross ||
      countLeaderThroughLabels(placements, cfg, coord) > beforeThrough;
    if (harm) p.x = origX;
  }
}

/**
 * emit 専用: ソフトマージン (`canvasXlim` = viewBox 端から `marginCapHorizontalPx`) には長体下限
 * (`FINAL_CONDENSE_MIN_SCALE`) でも収まらない「構造的オーバーフロー」ラベル — percent 行だけで残り幅を
 * 食い切る短名 (例 currency の "ユーロ")、極端な長カタカナ、支配スライス右端 — を、**実 viewBox を
 * 見切らない範囲で**原寸 (sx=1) へ向けて緩和する。
 *
 * 背景: `applyFinalCondenseToFit` はソフトマージンに収めるため長体化し、収まらない構造ラベルは下限まで
 * 潰す。`relaxNameCondense` は「ソフトに収まる」分しか戻さないため、構造ラベルはソフト超過のまま下限で
 * 過圧縮されて残る。名前が短いラベルほど「どのみちマージンは超えるのに見た目だけ潰れる」損が大きい
 * (ユーロ)。本パスはソフト侵入を許容し、実 viewBox 見切れだけを上限に長体を緩める。
 *
 * anchor (pie 側の辺) 固定で far edge のみ外側へ動くので原理的に pie 侵入・新規重なりは増えないが、box が
 * 広がると他 leader が貫く/交差が増え得るため、`pullOutsideOverflowTowardPie` と同じ do-no-harm ゲート
 * (重なり / pie 侵入 / leader 交差 / leader 貫通 が開始時から非増加、かつ実 viewBox 見切れが増えない) で
 * 1 ステップずつ採否し、崩れる手は revert する。ソフト見切れ (`boxViewOverflowMax`) はゲートに入れない
 * (それを許すのが本パスの目的)。`relaxNameCondense` の後・finalScore の前に 1 回だけ呼ぶ。scoring
 * (`finalizeForScoring`) には入れない: 候補選択を乱さず、finalScore は本パス後の placements から数える
 * ため scorer ↔ emit 整合は保たれる (`applyTwoLineNameFallback` と同方針)。
 */
function relaxStructuralCondense(
  placements: Placement[],
  cfg: PieLayoutConfig,
  coord: Coord,
): void {
  const tol = pxToLogical(cfg, 2);
  const STEP = 0.025; // applyFinalCondenseToFit / relaxNameCondense と同じ格子
  const pieClearance = Math.max(cfg.pieLabelClearance, radialFraction(cfg, 0.01, 0.1));
  // 実 viewBox 端 (ハードリミット)。ソフトと違い `marginCapHorizontalPx` を引かない = 見切れる直前まで
  // 許す。端ぴったりはグリフが切れて見えるため数 px の安全代を残す。
  const hardHalf = cfg.svgWidthPx / 2 / cfg.pxPerUnit - 4 / cfg.pxPerUnit;
  const candidates = placements.filter((p) => !p.insideSlice && (p.nameScaleX ?? 1) < 1 - 1e-9);
  if (candidates.length === 0) return;

  // box が `hardHalf` (= 実 viewBox 端の数 px 内側) を越える量。ラベル単位で評価する (グローバル最大で
  // 測ると、既に見切れる別ラベルがある図で全ラベルをそこまで広げてしまう)。`hardHalf` で測るので、開始時
  // から増やさない限り実 viewBox (`realHalf`) は必ず数 px 余して割らない = verify の見切れ判定と整合する。
  const hardClip = (b: { left: number; right: number }): number =>
    Math.max(0, -hardHalf - b.left, b.right - hardHalf);
  const distToPie = (b: { left: number; right: number; top: number; bottom: number }): number => {
    const nx = Math.max(b.left, Math.min(0, b.right));
    const ny = Math.max(b.bottom, Math.min(0, b.top));
    return Math.hypot(nx, ny);
  };
  // 各候補の開始時 (relax 前) の見切れ量。見切れガードはこの絶対基準で測る (ステップごとの相対基準だと
  // 許容が毎ステップ累積し、収まっていたラベルが徐々に viewBox を割る)。
  const initialClip = new Map<Placement, number>(
    candidates.map((p) => [p, hardClip(placementBox(p, cfg))]),
  );
  // leader 交差 / 貫通は対の整数カウントなのでグローバルで「開始時から増えない」を見る。
  const beforeCross = countLeaderCrossings(placements, cfg, coord);
  const beforeThrough = countLeaderThroughLabels(placements, cfg, coord);

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
      // (a) このラベルの見切れを開始時から増やさない。収まっていれば収まったまま、既に見切れる真の
      //     クリップ floor ラベルは広げると悪化するので revert = floor 据え置き。
      let ok = hardClip(box) <= (initialClip.get(p) ?? 0) + 1e-9;
      // (b) pie 非侵入 (anchor=start/end は pie 側辺固定で自明・middle 用ガード)。
      if (ok) {
        const d = distToPie(box);
        ok = d >= cfg.pieRadius + pieClearance - 1e-9 || d >= beforePieDist - 1e-9;
      }
      // (c) 他 box との横重なりを増やさない (ラベル単位)。
      if (ok) {
        for (const q of placements) {
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
      // (d) leader 交差 / 貫通を増やさない (box 拡大で他 leader が貫く/交差し得るためグローバル確認)。
      if (ok) {
        ok =
          countLeaderCrossings(placements, cfg, coord) <= beforeCross &&
          countLeaderThroughLabels(placements, cfg, coord) <= beforeThrough;
      }
      if (ok) progressed = true;
      else p.nameScaleX = cur;
    }
  }
}

/**
 * emit 専用・最終手段: 長体 (nameScaleX<1) だが pie 側にまだ余白がある円外ラベルを、**pie 側へ
 * 必要最小限だけシフトしてから**原寸へ戻す。`relaxStructuralCondense` は anchor (pie 側辺) を固定
 * するため、左/右の viewBox 端にハグして縮んだラベル (例 `stress_right_cluster_8` の "C"/"D"、
 * `eleven_tiny_cluster` の "F") は「その場では戻せない」= 戻せるのに長体のまま残る。本パスは anchor
 * ごと pie 側へ寄せて far edge の viewBox 余白を稼ぎ、稼げた分だけ長体を解く。
 *
 * シフト量は full 化に必要な最小限のみ (余計に pie へ寄せて leader を詰めない)。pie 側辺は
 * `applyVisualViewBoxNudge` と同じく pie 円周 (`pieYAtX`) + クリアランスでキャップする
 * (countDefects は leader の pie 貫通しか見ず text box の pie 侵入を見ないため、ここで明示的に防ぐ)。
 * 採否は `relieveLeftStackSpacing` と同じ do-no-harm ゲート (clips/crossings/pie/total が開始時から
 * 非増加) かつ改善 (sx 増) があるときのみ。さもなくば全 revert。anchor=middle は pie 側辺が定まらない
 * ので対象外。位置確定後 (全 hard-defect パス後) に 1 回。emit 専用で finalScore は本パス後の
 * placements から数えるため scorer↔emit 整合は保たれる (`relaxStructuralCondense` と同方針)。
 */
function unsqueezeCondensedByShiftTowardPie(
  placements: Placement[],
  cfg: PieLayoutConfig,
  coord: Coord,
): void {
  const STEP = 0.025; // applyFinalCondenseToFit / relaxStructuralCondense と同じ格子
  const hardHalf = cfg.svgWidthPx / 2 / cfg.pxPerUnit - 4 / cfg.pxPerUnit; // 実 viewBox 端の数 px 内側
  const fitsView = (p: Placement): boolean => {
    const b = placementBox(p, cfg);
    return b.left >= -hardHalf - 1e-9 && b.right <= hardHalf + 1e-9;
  };
  const candidates = placements.filter(
    (p) =>
      !p.insideSlice &&
      (p.nameScaleX ?? 1) < 1 - 1e-9 &&
      (p.anchor === 'end' || p.anchor === 'start'),
  );
  if (candidates.length === 0) return;
  // do-no-harm ゲート: countDefects (clips/crossings/pie/total=見切れ+重なり) に加え、countDefects が
  // 数えない「leader が他ラベル box を貫通」(`countLeaderThroughLabels`) も非増加を要求する
  // (`relaxStructuralCondense` のガード(d)と同じ — シフトで leader 形状が変わり box 貫通し得るため)。
  const notWorse = (before: DefectCounts, beforeThrough: number): boolean => {
    const after = countDefects(placements, cfg, coord);
    return (
      after.clips <= before.clips &&
      after.crossings <= before.crossings &&
      after.pie <= before.pie &&
      after.total <= before.total &&
      countLeaderThroughLabels(placements, cfg, coord) <= beforeThrough
    );
  };

  for (const p of candidates) {
    const before = { x: p.x, sx: p.nameScaleX ?? 1, maxTextX: p.maxTextX, minTextX: p.minTextX };
    const beforeDefects = countDefects(placements, cfg, coord);
    const beforeThrough = countLeaderThroughLabels(placements, cfg, coord);

    // (1) full 幅にしたときの far edge の viewBox 超過分を測り、その分だけ pie 側へ寄せる。
    p.nameScaleX = 1;
    const fullBox = placementBox(p, cfg);
    // box が最接近する pie 上の y (applyVisualViewBoxNudge と同じ導出)。
    let closestPieY = 0;
    if (fullBox.bottom > cfg.pieRadius) closestPieY = fullBox.bottom;
    else if (fullBox.top < -cfg.pieRadius) closestPieY = fullBox.top;
    else
      closestPieY = Math.abs(fullBox.top) < Math.abs(fullBox.bottom) ? fullBox.top : fullBox.bottom;
    const pieSideCapped = Math.abs(closestPieY) < cfg.pieRadius;
    // 実効クリアランス (viewBox 収まりキャップ、full 幅基準)。狙い値のままだと幅広ラベルの
    // pie 側キャップが早く頭打ちになり、旧クリアランスなら解けた長体が残る。
    const pieClearance = pieClearanceWithinViewBox(
      cfg,
      pieSideCapped ? pieYAtX(closestPieY, cfg) : 0,
      fullBox.right - fullBox.left,
      radialFraction(cfg, 0.01, 0.1),
    );
    if (p.anchor === 'end') {
      // 左側ラベル: far edge=box.left。左超過分だけ右 (pie 側) へ。pie 側辺=box.right を pie 左縁でキャップ。
      let shift = Math.max(0, -hardHalf - fullBox.left);
      if (pieSideCapped) {
        const maxBboxRight = -pieYAtX(closestPieY, cfg) - pieClearance;
        shift = Math.min(shift, Math.max(0, maxBboxRight - fullBox.right));
      }
      if (shift > 0) {
        p.maxTextX = undefined; // 旧右寄せ上限を外す (pie キャップは上の shift 計算で担保済み)
        p.x += shift;
        p.maxTextX = before.maxTextX;
      }
    } else {
      // 右側ラベル: far edge=box.right。右超過分だけ左 (pie 側) へ。pie 側辺=box.left を pie 右縁でキャップ。
      let shift = Math.max(0, fullBox.right - hardHalf);
      if (pieSideCapped) {
        const minBboxLeft = pieYAtX(closestPieY, cfg) + pieClearance;
        shift = Math.min(shift, Math.max(0, fullBox.left - minBboxLeft));
      }
      if (shift > 0) {
        p.minTextX = undefined;
        p.x -= shift;
        p.minTextX = before.minTextX;
      }
    }

    // (2) シフト後の位置で full が収まらなければ、収まる最大 sx まで段階的に長体へ戻す。
    let sx = 1;
    while (!fitsView(p) && sx - STEP >= FINAL_CONDENSE_MIN_SCALE - 1e-9) {
      sx = Math.round((sx - STEP) * 1000) / 1000;
      p.nameScaleX = sx;
    }

    // (3) 改善 (sx 増) かつ do-no-harm のときだけ採用、さもなくば全 revert。
    if (!((p.nameScaleX ?? 1) > before.sx + 1e-9 && notWorse(beforeDefects, beforeThrough))) {
      p.x = before.x;
      p.nameScaleX = before.sx;
      p.maxTextX = before.maxTextX;
      p.minTextX = before.minTextX;
    }
  }
}

/**
 * 9時線 (midAngle≈180) を挟んで縦に重なる左側 small スライスの「ほぼ縦・平行」leader を、
 * スライス角度順に並べ直して左上の空きへわずかに逃がし、各 leader を明確な斜め線にする。
 *
 * 背景: イギリス(≈189.5°)/イタリア(≈175.2°) (世界債券IDX国別) の様に 9時線を挟む 2 枚の小スライスは、
 * 自然 rim Y が共に≈0 で同じ高さに重なり、ラベルが円の左端 (x≈円左端) に縦積みされる。leader は
 * anchor とラベル縦縁の X がほぼ一致して near-vertical になり、2 本が平行に重なって「どちらがどの
 * スライスか」分からない。さらにラベルの上下がスライス順と逆転しやすい。平行 leader は幾何交差しない
 * ため separateCrossingPairs (交差ベース) では解消されない。
 *
 * 手順: 対象群を sin(midAngle) 降順 (上スライス=上ラベル) に並べ、現在の縦中心の少し上を基準に
 * box+minGap 間隔で上→下スロットへ割当 (角度順=縦順に矯正) し、各ラベルを左 rim から dxLeft だけ
 * 左へ寄せる。これで rim から斜めに出る分離した leader になる。skipLeader は立てない (斜め leader を描く)。
 * do-no-harm: 重なり/pie 侵入/viewBox/leader 交差が悪化したら群を丸ごと revert (退行0)。判定は
 * computeDrawnLeader / countLeaderCrossings (emit と同一) なので verify と一致する。
 */
function escapeUpperLeftTinyLeaders(
  placements: Placement[],
  cfg: PieLayoutConfig,
  coord: Coord,
): void {
  const nearVerticalDx = radialFraction(cfg, 0.02, 0.18);
  const group = placements.filter((p) => {
    // ALWAYS_DRAW 方針下では rim ラベルの placement.skipLeader=true でも Pass 1 で leader は
    // 描かれる (skipLeader は insideSlice に上書き)。よって「描かれる」判定は !insideSlice。
    if (p.insideSlice) return false;
    const it = p.item;
    if (it.side !== 'left') return false;
    if (it.isSmall !== true) return false;
    if (p.anchor !== 'end') return false;
    if (it.flipToRight || it.flipToLeft) return false;
    if (!angleInBand(normalizeAngle(it.midAngle ?? 0), 180, NINE_OCLOCK_ESCAPE_HALF_WIDTH_DEG)) {
      return false;
    }
    // near-vertical = anchor とラベル縦縁の X がほぼ一致 (描画実体 pathPoints で判定)。
    const { pathPoints } = computeDrawnLeader(p, cfg);
    const a = pathPoints[0];
    const e = pathPoints[pathPoints.length - 1];
    return Math.abs(e.x - a.x) < nearVerticalDx;
  });
  // 単独 leader は曖昧でなく、3 枚以上は back-to-back でない別構成なので、ちょうど 2 枚 (対) のみ扱う。
  if (group.length !== 2) return;

  // do-no-harm 指標 (全 placement 横断。separateCrossingPairs / applyLeftStackGapClose と同性質)。
  const tol = pxToLogical(cfg, 2);
  const tolPx = 2;
  const maxOverlap = (): number => boxOverlapMax(placements, cfg);
  const maxPieIntrusion = (): number => boxPieIntrusionMax(placements, cfg);
  // viewBox はみ出し量 (px, 4 辺)。横移動 (dxLeft) で左へ押し出すため縦だけでなく横も測り、
  // verify と同じ pixel 空間 [0,width]×[0,height] で判定する。
  const maxViewOverflow = (): number => boxViewOverflowMax(placements, cfg, coord);

  const beforeOverlap = maxOverlap();
  const beforePie = maxPieIntrusion();
  const beforeView = maxViewOverflow();
  const beforeCross = countLeaderCrossings(placements, cfg, coord);
  const snapshot = group.map((p) => ({ p, x: p.x, y: p.y, baseline: p.baseline }));

  // 対象対は「2型」back-to-back (両者ほぼ同一 Y + 逆向き baseline で上下に伸びる) で上下が逆転している。
  // 上スライス (高 sin) を上ラベルにするため、必要なら 2 枚の (y, baseline) を丸ごと入れ替える。
  // 同幅 (4 文字名) の box 同士の交換なので union フットプリントは不変 = verify が既に許容済みの配置と
  // 同一 (新たな重なり/見切れを生まない)。さらに左へ少し寄せて左上の空きへ逃がす。離散スロットや
  // baseline 正規化 (middle 化) は verify の実グリフ高と box モデルがずれて誤判定を招くため採らない。
  const sorted = [...group].sort(
    (a, b) => Math.sin(degToRad(b.item.midAngle ?? 0)) - Math.sin(degToRad(a.item.midAngle ?? 0)),
  );
  const hi = sorted[0]; // 上に置きたい (高 sin = 上スライス)
  const lo = sorted[1];
  // 「2型」back-to-back の不変条件: 両者がほぼ同一 anchor Y かつほぼ同幅。これが成り立つ時だけ
  // (y, baseline) 交換が同一 box 同士の交換 = union フットプリント不変となり、verify が既に許容済みの
  // 配置に厳密一致する (退行0)。同幅でない/離れて積まれた対 (長名や別側構成) には介入しない。
  if (Math.abs(hi.y - lo.y) > tol) return;
  if (Math.abs(placementExtent(hi, cfg).width - placementExtent(lo, cfg).width) > tol) return;
  const hiBox = placementBox(hi, cfg);
  const loBox = placementBox(lo, cfg);
  const hiCenter = (hiBox.top + hiBox.bottom) / 2;
  const loCenter = (loBox.top + loBox.bottom) / 2;
  if (hiCenter <= loCenter) {
    // 現状 hi が下 (逆転) → (y, baseline) を交換して hi を上・lo を下にする。
    const ty = hi.y;
    hi.y = lo.y;
    lo.y = ty;
    const tb = hi.baseline;
    hi.baseline = lo.baseline;
    lo.baseline = tb;
  }
  // 左へ少し寄せて左上の空きへ逃がす (水平のみ。縦フットプリント不変なので縦重なりは増えない)。
  const dxLeft = radialFraction(cfg, 0.04, 0.45);
  for (const p of group) {
    p.x -= dxLeft;
    clampPlacement(p);
  }

  const harm =
    maxOverlap() > beforeOverlap + tol ||
    maxPieIntrusion() > beforePie + tol ||
    maxViewOverflow() > beforeView + tolPx ||
    countLeaderCrossings(placements, cfg, coord) > beforeCross;
  if (harm) {
    for (const { p, x, y, baseline } of snapshot) {
      p.x = x;
      p.y = y;
      p.baseline = baseline;
    }
  }
}

// ── near-contact (近接) 緩和 ──────────────────────────────────────────────────
// 既存の最終段パスは hard defect (leader 交差 / 箱貫通 / 箱重なり / 円侵入 / viewBox 見切れ /
// 角度順逆転) のみを検出・解消し、「交差・重なりには至らないが寄りすぎ」というサブ閾値の近接
// (自 leader が隣の box/leader に触れそう) を見ない。`relieveLeaderNeighborContact` はその近接量を
// 実描画と同じ pixel 空間で測り (`realLeaderPaths` / `placementBox`→px)、対象ラベルを微小ステップで
// 上へ逃がして deficit を減らす。他パスと同じ do-no-harm: hard defect 群を非増加に保ちつつ対象 deficit を
// 厳密減にしたときだけ採用し、悪化すれば元位置へ revert する。汎用に効く (特定サンプル決め打ちでない)
// が、近接の無い図は deficit≈0 で早期 continue するため無変更。以下は計測用の共有ヘルパと本体。

/** px 空間の矩形。`countDefects` の pbox と同じ作り (yScale 反転を min/max で吸収)。 */
interface PixRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** placement の box を pixel 矩形へ変換する。 */
function placementPixelRect(p: Placement, cfg: PieLayoutConfig, coord: Coord): PixRect {
  const lb = placementBox(p, cfg);
  return {
    left: Math.min(coord.xScale(lb.left), coord.xScale(lb.right)),
    right: Math.max(coord.xScale(lb.left), coord.xScale(lb.right)),
    top: Math.min(coord.yScale(lb.top), coord.yScale(lb.bottom)),
    bottom: Math.max(coord.yScale(lb.top), coord.yScale(lb.bottom)),
  };
}

/** non-clip/crossing/pie の純粋な box 重なり件数 (`countDefects` の分解)。 */
function overlapsOf(d: DefectCounts): number {
  return d.total - d.clips - d.crossings - d.pie;
}

/**
 * ローリング do-no-harm ゲートの複合測定 (`applyTwoLineNameFallback` /
 * `applyLowerLeftDropFallback` / `applyVerticalDeclipFallback` が共有)。countDefects に加え、
 * countDefects が数えない box 円侵入件数と leader box 貫通件数も 1 回で測る (全て純粋読み取り)。
 * through を読むかはパス固有 (declip 系のみ) — 測定は常に行うが述語には焼き込まない。
 */
interface DefectGate {
  d: DefectCounts;
  pieBox: number;
  through: number;
}
function measureDefectGate(
  placements: Placement[],
  cfg: PieLayoutConfig,
  coord: Coord,
): DefectGate {
  return {
    d: countDefects(placements, cfg, coord),
    pieBox: countBoxPieIntrusions(placements, cfg, coord),
    through: countLeaderThroughLabels(placements, cfg, coord),
  };
}

/**
 * do-no-harm 共通部品: clips 以外の共有カテゴリ (交差 / leader 円貫通 / box 重なり / box 円侵入)
 * の非悪化。clips の扱い (厳密減か非増加か)・through 非悪化・パス固有の改善条件は述語の仕様
 * そのものなので、呼び出し側が && で合成する。
 */
function gateNotWorseExceptClips(after: DefectGate, before: DefectGate): boolean {
  return (
    after.d.crossings <= before.d.crossings &&
    after.d.pie <= before.d.pie &&
    overlapsOf(after.d) <= overlapsOf(before.d) &&
    after.pieBox <= before.pieBox
  );
}

/**
 * pie 円に侵入している外側ラベル box の件数 (pixel 判定、`pieRpx-2` 余裕)。
 * 各 fallback の局所 `countBoxPie` を 1 か所へ集約したもの。
 */
function countBoxPieIntrusions(
  placements: Placement[],
  cfg: PieLayoutConfig,
  coord: Coord,
): number {
  const pieRpx = Math.abs(coord.xScale(cfg.pieRadius) - coord.xScale(0));
  const cxp = coord.xScale(0);
  const cyp = coord.yScale(0);
  let n = 0;
  for (const p of placements) {
    if (p.insideSlice) continue;
    const b = placementPixelRect(p, cfg, coord);
    const closestX = Math.max(b.left, Math.min(cxp, b.right));
    const closestY = Math.max(b.top, Math.min(cyp, b.bottom));
    if (Math.hypot(closestX - cxp, closestY - cyp) < pieRpx - 2) n += 1;
  }
  return n;
}

/** px 点と矩形の最短距離 (矩形内は 0)。 */
function pointToRectPx(px: number, py: number, r: PixRect): number {
  const dx = Math.max(r.left - px, 0, px - r.right);
  const dy = Math.max(r.top - py, 0, py - r.bottom);
  return Math.hypot(dx, dy);
}

/** px 線分と矩形の最短距離の近似 (矩形4隅→線分 と 線分2端→矩形 の最小)。交差時はほぼ 0。 */
function segToRectPx(ax: number, ay: number, bx: number, by: number, r: PixRect): number {
  let d = Math.min(pointToRectPx(ax, ay, r), pointToRectPx(bx, by, r));
  const corners: [number, number][] = [
    [r.left, r.top],
    [r.right, r.top],
    [r.left, r.bottom],
    [r.right, r.bottom],
  ];
  for (const [cx, cy] of corners) {
    d = Math.min(d, distPointToSegment(cx, cy, ax, ay, bx, by));
  }
  return d;
}

/** placement の描画 leader を pixel 折れ線へ。描かれない (inside / skip) は null。 */
function selfLeaderPathPx(
  p: Placement,
  cfg: PieLayoutConfig,
  coord: Coord,
): { x: number; y: number }[] | null {
  if (p.insideSlice) return null;
  const { pathPoints } = computeDrawnLeader(p, cfg);
  return pathPoints.map((pt) => ({ x: coord.xScale(pt.x), y: coord.yScale(pt.y) }));
}

// do-no-harm ゲートは **件数ベース** (`countDefects` = verify と同じ閾値で clip/重なり/交差/円侵入を計数)
// ＋角度順逆転 ＋ leader 箱貫通 を使う。max 量ベース (`box*Max`) だと「既に大きく見切れたラベルが1枚あると
// 別ラベルを新たに少し見切れさせても最大値が変わらず素通り」する穴があり、広く回す本パス群では退行を見逃す
// (実測 verify 11→27)。件数なら新規の見切れ/重なりは即 +1 で検出され verify と一致する。
/** do-no-harm ゲート用の defect 件数スナップショット。 */
interface HardDefects {
  total: number;
  through: number;
  inv: number;
}
function measureHardDefects(
  placements: Placement[],
  cfg: PieLayoutConfig,
  coord: Coord,
): HardDefects {
  return {
    total: countDefects(placements, cfg, coord).total,
    through: countLeaderThroughLabels(placements, cfg, coord),
    inv: countAngularDiscordantPairs(placements, cfg, coord),
  };
}
/** before から件数がどれか 1 つでも増えたか (整数なので厳密比較)。 */
function hardDefectsWorsened(
  before: HardDefects,
  placements: Placement[],
  cfg: PieLayoutConfig,
  coord: Coord,
): boolean {
  const a = measureHardDefects(placements, cfg, coord);
  return a.total > before.total || a.through > before.through || a.inv > before.inv;
}

/**
 * 自分の描画 leader が「隣の box / 隣の leader」に target_px 未満で接近するラベルを、上方向 (画面上)
 * へ微小ステップで逃がして接触を軽減する。上左帯は上に空きがある前提の素直なヒューリスティック。
 * 例: page16 ケイマン諸島の leader が隣に触れそう → 上へ逃がす。do-no-harm (悪化したら revert)。
 */
function relieveLeaderNeighborContact(
  placements: Placement[],
  cfg: PieLayoutConfig,
  coord: Coord,
): void {
  const pxPerUnit = Math.abs(coord.xScale(1) - coord.xScale(0));
  const targetPx = radialFraction(cfg, 0.03, 0.22) * pxPerUnit;
  const stepLogical = radialFraction(cfg, 0.01, 0.06);
  const tolPx = 1;
  const maxIter = 24;
  for (const p of placements) {
    if (p.insideSlice) continue;
    const measure = (): number => {
      const self = selfLeaderPathPx(p, cfg, coord);
      if (!self) return 0;
      const paths = realLeaderPaths(placements, cfg, coord);
      let minDist = Number.POSITIVE_INFINITY;
      for (let j = 0; j < placements.length; j += 1) {
        if (placements[j] === p) continue;
        const nb = placementPixelRect(placements[j], cfg, coord);
        for (let k = 0; k + 1 < self.length; k += 1) {
          minDist = Math.min(
            minDist,
            segToRectPx(self[k].x, self[k].y, self[k + 1].x, self[k + 1].y, nb),
          );
        }
        const np = paths[j];
        if (np) {
          // leader 対 leader は端点→相手線分の最小で近似 (両方向)。
          for (let k = 0; k + 1 < self.length; k += 1) {
            for (let m = 0; m + 1 < np.length; m += 1) {
              minDist = Math.min(
                minDist,
                distPointToSegment(
                  self[k].x,
                  self[k].y,
                  np[m].x,
                  np[m].y,
                  np[m + 1].x,
                  np[m + 1].y,
                ),
                distPointToSegment(
                  np[m].x,
                  np[m].y,
                  self[k].x,
                  self[k].y,
                  self[k + 1].x,
                  self[k + 1].y,
                ),
              );
            }
          }
        }
      }
      // minDist≈0 は交差/貫通 (hard defect) なので near-contact 対象外。
      if (!Number.isFinite(minDist) || minDist < 0.5) return 0;
      return Math.max(0, targetPx - minDist);
    };
    const startDef = measure();
    if (startDef <= tolPx) continue;
    const before = measureHardDefects(placements, cfg, coord);
    tryMoveWithGuard(
      p,
      () => {
        let iter = 0;
        let cur = startDef;
        while (cur > tolPx && iter < maxIter) {
          p.y += stepLogical; // 画面上方向 (logical y-up)
          clampPlacement(p, cfg);
          iter += 1;
          cur = measure();
        }
      },
      // 近接 deficit が厳密に減り (measure は移動後の再測定 = ループ最終値と同値)、hard defect 非悪化。
      () => measure() < startDef - tolPx && !hardDefectsWorsened(before, placements, cfg, coord),
    );
  }
}

/** placement の全可変フィールドのスナップショット (seam 系パスの全 revert 用・退行0 を担保)。 */
export interface SeamSnap {
  p: Placement;
  v: Partial<Placement>;
}

/**
 * `Placement` 全フィールドの seam-snapshot 分類 (コンパイル時網羅チェック)。`Placement` へ
 * フィールドを追加すると、本表に分類を書くまで tsc が落ちる。これで `seamSnapshot` への追加漏れ
 * (= seam 系パスの revert 不完全化) を静かに作れない。'snapshot' = `seamSnapshot` が保存・復元する。
 * 'static' = seam 系パスが変更しないため保存不要 (理由は各行コメント)。本表と実際の snapshot キーの
 * 一致は `seam_snapshot.test.ts` が検証する。
 */
export const PLACEMENT_SEAM_POLICY: Record<keyof Placement, 'snapshot' | 'static'> = {
  x: 'snapshot',
  y: 'snapshot',
  anchor: 'snapshot',
  baseline: 'snapshot',
  lines: 'snapshot',
  leaderBend: 'snapshot',
  leaderEndpoint: 'snapshot',
  leaderBendFollowsEndpointY: 'snapshot',
  leaderBendFollowsEndpointX: 'snapshot',
  forceTopRight: 'snapshot',
  dominantOutsideEdge: 'snapshot',
  skipLeader: 'snapshot',
  origTextX: 'snapshot',
  origTextY: 'snapshot',
  maxTextX: 'snapshot',
  minTextX: 'snapshot',
  maxTextY: 'snapshot',
  minTextY: 'snapshot',
  nameScaleX: 'snapshot',
  condenseNamePortionOnly: 'snapshot',
  item: 'static', // 入力スライスへの参照。seam 系パスは item を書き換えない
  measured: 'static', // 実測キャッシュ。読み手 (`placementExtent`) が都度再計算する
  leaderAnchor: 'static', // スライス rim 上のアンカー。seam 系パスは読み取りのみ
  upperLeftHairpinCheck: 'static', // cascade 確定時に決まり、以後不変
  insideSlice: 'static', // 内側/外側の別は seam 系パスで変わらない (候補フィルタで除外済み)
  nameSplit: 'static', // 語割れ廃止で常に未設定。2 行化は専用 revert (`restoreTwoLineNamePlacement`) 持ち
  pieClearance: 'static', // draft 由来の動的クランプ印。seam 系パスは変更しない
  twoLineLeftColumn: 'static', // `applyTwoLineLeftColumn` が一度だけ立てる。seam 系パスは変更しない
  declipBottomLeader: 'static', // `applyVerticalDeclipFallback` 採用分のみ。seam 系パスは変更しない
  bisectedSecondSliceNoLeader: 'static', // item から複写される固定印。seam 系パスは変更しない
};

export function seamSnapshot(placements: Placement[]): SeamSnap[] {
  return placements.map((p) => ({
    p,
    v: {
      x: p.x,
      y: p.y,
      anchor: p.anchor,
      baseline: p.baseline,
      leaderBend: { ...p.leaderBend },
      leaderEndpoint: { ...p.leaderEndpoint },
      leaderBendFollowsEndpointY: p.leaderBendFollowsEndpointY,
      leaderBendFollowsEndpointX: p.leaderBendFollowsEndpointX,
      forceTopRight: p.forceTopRight,
      dominantOutsideEdge: p.dominantOutsideEdge,
      skipLeader: p.skipLeader,
      origTextX: p.origTextX,
      origTextY: p.origTextY,
      maxTextX: p.maxTextX,
      minTextX: p.minTextX,
      maxTextY: p.maxTextY,
      minTextY: p.minTextY,
      nameScaleX: p.nameScaleX,
      condenseNamePortionOnly: p.condenseNamePortionOnly,
      // 配列は in-place 変更せず常に新配列で置き換える規約 (1 行化 escape 等) なので参照保存で足りる。
      lines: p.lines,
    },
  }));
}
export function seamRestore(snap: SeamSnap[]): void {
  for (const { p, v } of snap) Object.assign(p, v);
}

/**
 * seam 系 do-no-harm の単発形: `seamSnapshot` → mutate() → isBetter() が偽なら全 revert して
 * 採否を返す。before 側の測定は mutate 前に呼び出し側で済ませ isBetter へ閉じ込めること (採否述語は
 * パス仕様そのものなのでヘルパーは判定に関与しない)。複数 snapshot を管理する best-of-prefix 探索
 * (`escapeTopBandSeamLeader` の thorough) や「不採用でも一部変更を残す」変則形は対象外。
 */
function trySeamMutation(
  placements: Placement[],
  mutate: () => void,
  isBetter: () => boolean,
): boolean {
  const snap = seamSnapshot(placements);
  mutate();
  if (isBetter()) return true;
  seamRestore(snap);
  return false;
}

/**
 * 単一ラベル移動の do-no-harm 共通形: 対象の座標 (x, y) を snapshot して mutate() を実行し、
 * keep() が偽なら座標だけ戻して採否を返す。keep には「対象自身の指標が厳密に改善し、チャート全体の
 * hard defect が非悪化」等のパス固有述語を丸ごと渡す。座標以外も動かすパスは `trySeamMutation` を使う。
 */
function tryMoveWithGuard(target: Placement, mutate: () => void, keep: () => boolean): boolean {
  const snapX = target.x;
  const snapY = target.y;
  mutate();
  if (keep()) return true;
  target.x = snapX;
  target.y = snapY;
  return false;
}

/**
 * placement を左 rim ハグの正準フォーム (anchor=end/baseline=bottom) へ整える。Y は引数で固定し
 * (等間隔スタックを崩さないため nudge を使わず)、anchor=end の右端 X を「box 下端 (中心に最も近い辺)
 * がパイ外になる位置」へ直接計算する。leader は、anchor→ラベルの直線がパイを貫く構成員のみ
 * `upperLeftBendPoint` で1点曲げ (アンカーから水平に出て曲げる L 字) にし、それ以外は degenerate (直線)。
 */
function reshapeToLeftRimHug(p: Placement, cfg: PieLayoutConfig, y: number): void {
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
function reorderTopBandLeftClusterByAngle(
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
 * do-no-harm 採否ゲートが読む不具合スナップショットの統合測定。`escapeTopBandSeamLeader`
 * (thorough) の SeamVec と `repairResidualLeaderDefects` の Vec が共有する (各サイトは本 vec の
 * 射影を取る)。全フィールドが純粋読み取りで placements を変更しないため、測定の共有・追加は
 * 出力 byte に影響しない。比較述語はパスごとに意味が異なる (交差厳密減 / through 振替許容 /
 * crossPie 合算など) 仕様そのものなので統合せず、各パス側に残す。
 */
interface RepairVec {
  /** leader 同士の交差 件数。 */
  cross: number;
  /** leader の pie 円貫通 件数。 */
  pieCross: number;
  /** leader の他ラベル箱貫通 件数。 */
  through: number;
  /** 外側 leader の角度順逆転 対数。 */
  inv: number;
  /** viewBox を 1px 超見切れる箱数。 */
  clips: number;
  /** viewBox 外へ出る leader 本数。 */
  oob: number;
  /** 箱同士の重なり max 深さ (logical)。 */
  ovl: number;
  /** 箱の pie 円内侵入 max 深さ (logical)。verify の "label inside pie" に対応。 */
  boxPie: number;
  /** 箱の viewBox 超過 max (px)。 */
  view: number;
}

/** `RepairVec` の全フィールドを現在の placements から測る (純粋読み取り)。 */
function measureRepairVec(placements: Placement[], cfg: PieLayoutConfig, coord: Coord): RepairVec {
  return {
    cross: countLeaderCrossings(placements, cfg, coord),
    pieCross: leaderPieCrossCount(placements, cfg, coord),
    through: countLeaderThroughLabels(placements, cfg, coord),
    inv: countAngularDiscordantPairs(placements, cfg, coord),
    clips: placements.filter((p) => boxViewOverflowOf(p, cfg, coord) > 1).length,
    oob: oobLeaderCount(placements, cfg, coord),
    ovl: boxOverlapMax(placements, cfg),
    boxPie: boxPieIntrusionMax(placements, cfg),
    view: boxViewOverflowMax(placements, cfg, coord),
  };
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
function escapeTopBandSeamLeader(
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
 * 残余の leader 不具合 (交差 / 円内貫通 / 他ラベル箱貫通) を、当事者 leader の bend 再配置で
 * 解消する最終安全網。位置スワップや右逃がしで直らない交差は、多くの場合どちらかの leader の
 * 中継点 (bend) が相手の経路へ張り出していることが原因 (例 page16: ケイマンの接線迂回 W が
 * ルクセンブルクの flare と絡む)。bend を「アンカー角と接続点角の間の角度 × 円縁外クリアランス
 * 半径」の小さな格子から選び直し、実描画 (computeDrawnLeader) で
 * (交差+円貫通, 箱貫通) が辞書式に厳密改善し・逆転/重なり/箱円侵入/viewBox が非悪化の候補のみ
 * 採用する。発火は不具合が残るチャートだけなので清浄チャートは不変。決定的 (名前順・固定格子)
 * なので採点 (finalizeForScoring) と emit は一致する。
 */
/**
 * emit 最終段の安全網: 円外ラベル box が pie 円へ食い込む (verify の "label inside pie") のを、
 * 半径方向 nudge + 動的 pie クランプ (clampPlacement に cfg を渡し、現在 y で円クリアランス X 限界を
 * 再計算して viewBox 端制約より優先) で円外へ押し出す。
 *
 * 背景: cascade の各 pass は nudgeTextAwayFromPie で円外へ押し出すが、直後の clampPlacement が
 * draft 時点の静的 minTextX (viewBox floor) へ引き戻すため、draft より大きい |y| (円が太い高さ) へ
 * 動いたラベルは円内に残る (例 stress_top_cluster_8 の "F")。本段は確定 placement に対し**現在の y**で
 * 押し出し、衝突する viewBox floor を外して円外へ逃がすことで、その取りこぼしを最終的に解消する。
 *
 * do-no-harm: pie 侵入が厳密に減り、かつ box 重なり / leader 交差 / leader 貫通 / viewBox はみ出し
 * (1 行高 VIEW_OVERFLOW_CAP_PX 内) を悪化させない時だけ採用、悪化したら全 revert (退行0)。侵入が
 * 無いチャートは早期 return で完全無変更 (= 既存 OK チャートを乱さない)。判定は placementBox /
 * countLeaderCrossings / countLeaderThroughLabels (emit と同一)。採点 (finalizeForScoring) には
 * 入れない: repairResidualLeaderDefects と同理由で、修復前提のスコアが候補選択を歪めるのを避ける。
 * finalScore は本段適用後の同一 placements から数えるため scorer ↔ emit の一致は保たれる。
 */
function enforceFinalPieClearance(
  placements: Placement[],
  cfg: PieLayoutConfig,
  coord: Coord,
): void {
  const tol = pxToLogical(cfg, 2);
  const pieR = cfg.pieRadius;
  const maxPieIntrusion = (): number => boxPieIntrusionMax(placements, cfg);
  const beforePie = maxPieIntrusion();
  if (beforePie <= tol) return; // 円内侵入なし → 無変更 (OK チャートを乱さない)。

  const maxOverlap = (): number => boxOverlapMax(placements, cfg);
  const maxViewOverflow = (): number => boxViewOverflowMax(placements, cfg, coord);

  const beforeOverlap = maxOverlap();
  const beforeView = maxViewOverflow();
  const beforeCross = countLeaderCrossings(placements, cfg, coord);
  const beforeThrough = countLeaderThroughLabels(placements, cfg, coord);
  const snapshot = placements.map((p) => ({ p, x: p.x, y: p.y }));

  for (const p of placements) {
    if (p.insideSlice) continue;
    const bx = placementBox(p, cfg);
    const nx = Math.max(bx.left, Math.min(bx.right, 0));
    const ny = Math.max(bx.bottom, Math.min(bx.top, 0));
    if (pieR - Math.hypot(nx, ny) <= tol) continue; // このラベルは侵入していない。
    const ext = placementExtent(p, cfg);
    const nudged = nudgeTextAwayFromPie(p.x, p.y, p.anchor, p.baseline, ext, cfg);
    p.x = nudged.x;
    p.y = nudged.y;
    clampPlacement(p, cfg); // cfg 渡し = 動的 pie クランプ (viewBox floor を外して円外を維持)。
  }

  const harm =
    maxPieIntrusion() > beforePie - tol || // 侵入が厳密に減っていない
    maxOverlap() > beforeOverlap + tol ||
    countLeaderCrossings(placements, cfg, coord) > beforeCross ||
    countLeaderThroughLabels(placements, cfg, coord) > beforeThrough ||
    maxViewOverflow() > beforeView + VIEW_OVERFLOW_CAP_PX;
  if (harm) {
    for (const s of snapshot) {
      s.p.x = s.x;
      s.p.y = s.y;
    }
  }
}

/** leader path が pie 円に侵入している本数 (pieRPx-1 余裕)。 */
function leaderPieCrossCount(placements: Placement[], cfg: PieLayoutConfig, coord: Coord): number {
  const paths = realLeaderPaths(placements, cfg, coord);
  const cx = coord.xScale(0);
  const cy = coord.yScale(0);
  const pieRPx = Math.abs(coord.xScale(cfg.pieRadius) - coord.xScale(0));
  let c = 0;
  for (const path of paths) {
    if (!path) continue;
    for (let k = 0; k + 1 < path.length; k += 1) {
      if (
        distPointToSegment(cx, cy, path[k].x, path[k].y, path[k + 1].x, path[k + 1].y) <
        pieRPx - 1
      ) {
        c += 1;
        break;
      }
    }
  }
  return c;
}

/**
 * 不具合 (leader 交差 / 円貫通 / box 貫通 / box の円内侵入) に関与する placement の index を
 * 決定的順序 (名前順) で列挙する。{order, involved} を返す。
 */
function collectDefectInvolved(
  placements: Placement[],
  cfg: PieLayoutConfig,
  coord: Coord,
  tol: number,
): { order: number[]; involved: Set<number> } {
  const paths = realLeaderPaths(placements, cfg, coord);
  const boxes = projectBoxesToPixels(placements, cfg, coord);
  const cx = coord.xScale(0);
  const cy = coord.yScale(0);
  const pieRPx = Math.abs(coord.xScale(cfg.pieRadius) - coord.xScale(0));
  const involved = new Set<number>();
  for (let i = 0; i < paths.length; i += 1) {
    const pa = paths[i];
    if (!pa) continue;
    for (let j = i + 1; j < paths.length; j += 1) {
      const pb = paths[j];
      if (pb && pathsCross(pa, pb)) {
        involved.add(i);
        involved.add(j);
      }
    }
    for (let k = 0; k + 1 < pa.length; k += 1) {
      if (distPointToSegment(cx, cy, pa[k].x, pa[k].y, pa[k + 1].x, pa[k + 1].y) < pieRPx - 1) {
        involved.add(i);
        break;
      }
    }
    for (let j = 0; j < placements.length; j += 1) {
      if (j !== i && leaderCrossesBox(pa, boxes[j])) {
        involved.add(i);
        involved.add(j); // 貫通の被害者 (箱側) も対象: 箱の再配置 (rim 再ハグ) で回廊を開けられる
      }
    }
  }
  // 箱が円に食い込むラベルも対象 (verify "label inside pie")。rim 再ハグ候補で外へ出す。
  for (let i = 0; i < placements.length; i += 1) {
    const p = placements[i];
    if (p.insideSlice) continue;
    const bx = placementBox(p, cfg);
    const nx = Math.max(bx.left, Math.min(bx.right, 0));
    const ny = Math.max(bx.bottom, Math.min(bx.top, 0));
    if (cfg.pieRadius - Math.hypot(nx, ny) > tol) involved.add(i);
  }
  const order = [...involved].sort((a, b) =>
    placements[a].item.name.localeCompare(placements[b].item.name, 'ja'),
  );
  return { order, involved };
}

// `RepairVec` の射影 (crossPie = cross + pieCross の合算)。フィールド名は `residualBetter` 述語の
// 従来表記を保つ。boxPie は verify の "label inside pie" に対応する非悪化ゲート。
interface ResidualVec {
  crossPie: number;
  through: number;
  inv: number;
  clips: number;
  oob: number;
  ovl: number;
  view: number;
  boxPie: number;
}

/**
 * `repairResidualLeaderDefects` の各修復手 (単独手/複合手) が共有するコンテキスト。tol/tolPx/pxUnit
 * は同関数冒頭の導出値、vecOf は現在の placements の `ResidualVec` 採点、better は採否述語
 * (辞書式改善 + 非悪化)。クロージャで束ねず引数で渡すことで各手を単体テスト可能にする。
 */
interface ResidualRepairCtx {
  placements: Placement[];
  cfg: PieLayoutConfig;
  coord: Coord;
  tol: number;
  tolPx: number;
  pxUnit: number;
  vecOf: () => ResidualVec;
  better: (a: ResidualVec, b: ResidualVec) => boolean;
}

// p の bend を格子から選び直し、cur より良くなる候補があれば適用したまま true を返す。
// 無ければ元の bend/フラグへ戻して false。 (単独手・複合手の両方から使う)
function tryBendGridOn(ctx: ResidualRepairCtx, p: Placement): boolean {
  const { cfg, pxUnit, vecOf, better } = ctx;
  const drawn2 = computeDrawnLeader(p, cfg, false);
  if (drawn2.skipLeader || drawn2.pathPoints.length < 2) return false;
  const a2 = drawn2.pathPoints[0];
  const e2 = drawn2.detectPathPoints[drawn2.detectPathPoints.length - 1];
  const tA = Math.atan2(a2.y, a2.x);
  const tE = Math.atan2(e2.y, e2.x);
  let dT = tE - tA;
  while (dT > Math.PI) dT -= 2 * Math.PI;
  while (dT < -Math.PI) dT += 2 * Math.PI;
  if (Math.abs(dT) < 0.05 || Math.abs(dT) > LEADER_MAX_ANGULAR_DIFF_RAD) return false;
  const sv = {
    bend: { ...p.leaderBend },
    fy: p.leaderBendFollowsEndpointY,
    fx: p.leaderBendFollowsEndpointX,
  };
  const cur2 = vecOf();
  for (const f of [0.5, 0.35, 0.65, 0.2, 0.8]) {
    for (const rPx of [2.5, 5, 9, 14, 22, 34]) {
      const th = tA + dT * f;
      const rr = cfg.pieRadius + rPx * pxUnit;
      p.leaderBend = { x: rr * Math.cos(th), y: rr * Math.sin(th) };
      p.leaderBendFollowsEndpointY = false;
      p.leaderBendFollowsEndpointX = false;
      if (better(vecOf(), cur2)) return true;
    }
  }
  p.leaderBend = sv.bend;
  p.leaderBendFollowsEndpointY = sv.fy;
  p.leaderBendFollowsEndpointX = sv.fx;
  return false;
}

// 単独手: 関与 leader を名前順に、bend 格子 → 水平 pie-clear シフト → 左 rim 再ハグ の順で試し、
// cur を辞書式に改善する最初の 1 手を採用して true を返す (採用ゼロなら false)。
function tryRebendInvolved(ctx: ResidualRepairCtx, order: number[], cur: ResidualVec): boolean {
  const { placements, cfg, coord, pxUnit, vecOf, better } = ctx;
  for (const i of order) {
    const p = placements[i];
    if (p.insideSlice || p.forceTopRight) continue;
    let adopted = false;
    const drawn = computeDrawnLeader(p, cfg, false);
    const a = drawn.pathPoints[0];
    const e = drawn.detectPathPoints[drawn.detectPathPoints.length - 1];
    const thA = Math.atan2(a.y, a.x);
    const thE = Math.atan2(e.y, e.x);
    let dTh = thE - thA;
    while (dTh > Math.PI) dTh -= 2 * Math.PI;
    while (dTh < -Math.PI) dTh += 2 * Math.PI;
    // 角度差が小さい leader は bend の置き場が無く、大きすぎると 1 曲げで円を回り込めない。
    const bendFeasible =
      !drawn.skipLeader &&
      drawn.pathPoints.length >= 2 &&
      Math.abs(dTh) >= 0.05 &&
      Math.abs(dTh) <= LEADER_MAX_ANGULAR_DIFF_RAD;
    const save = {
      bend: { ...p.leaderBend },
      fy: p.leaderBendFollowsEndpointY,
      fx: p.leaderBendFollowsEndpointX,
    };
    outer: for (const f of bendFeasible ? [0.5, 0.35, 0.65, 0.2, 0.8] : []) {
      for (const rPx of [2.5, 5, 9, 14, 22, 34]) {
        const th = thA + dTh * f;
        const rr = cfg.pieRadius + rPx * pxUnit;
        p.leaderBend = { x: rr * Math.cos(th), y: rr * Math.sin(th) };
        p.leaderBendFollowsEndpointY = false;
        p.leaderBendFollowsEndpointX = false;
        const v = vecOf();
        if (better(v, cur)) {
          if (process.env.PIE_CHART_DEBUG_REPAIR) {
            console.error(
              `[rebend] "${p.item.name}" f=${f} r=+${rPx}px: ` +
                `crossPie ${cur.crossPie}->${v.crossPie}, through ${cur.through}->${v.through} => ADOPT`,
            );
          }
          adopted = true;
          break outer;
        }
      }
    }
    if (!adopted) {
      p.leaderBend = save.bend;
      p.leaderBendFollowsEndpointY = save.fy;
      p.leaderBendFollowsEndpointX = save.fx;
      // 候補2a: 水平 pie-clear シフト。leader 形状 (bend/フラグ) は再構築せず、箱だけを真横へ
      // 最小移動して円外クリアランスへ出す (untangle の footprint スワップは X を素通しで交換
      // するため、円に食い込んだ箱が残ることがある)。Y を変えないので leader の縦経路が乱れず、
      // radial nudge より副作用が小さい。
      if (!adopted && p.x < 0) {
        const snapN = seamSnapshot(placements);
        p.maxTextX = undefined;
        p.minTextX = undefined;
        p.maxTextY = undefined;
        p.minTextY = undefined;
        const lb = placementBox(p, cfg);
        const clearance = pxToLogical(cfg, 4);
        // 箱の Y 範囲のうち円中心に最も近い縁の高さで必要な円縁 X を求める。
        const spansZero = lb.top > 0 && lb.bottom < 0;
        const edgeY = spansZero ? 0 : Math.min(Math.abs(lb.top), Math.abs(lb.bottom));
        const rimX = Math.sqrt(Math.max(0, cfg.pieRadius * cfg.pieRadius - edgeY * edgeY));
        const targetRight = -(rimX + clearance);
        if (lb.right > targetRight) {
          p.x += targetRight - lb.right;
          clampPlacement(p);
          let v = vecOf();
          let ok = better(v, cur);
          // シフトで leader が隣と絡んだ場合は、自分と交差相手の bend 替えを重ねて複合手として
          // 再評価する (相手の bend が旧位置の箱を前提に張り出していることがある)。
          if (!ok) {
            tryBendGridOn(ctx, p);
            const myPath = realLeaderPaths(placements, cfg, coord)[i];
            if (myPath) {
              const allPaths = realLeaderPaths(placements, cfg, coord);
              for (let j = 0; j < placements.length; j += 1) {
                if (j === i) continue;
                const q = allPaths[j];
                if (
                  q &&
                  pathsCross(myPath, q) &&
                  !placements[j].insideSlice &&
                  !placements[j].forceTopRight
                ) {
                  tryBendGridOn(ctx, placements[j]);
                }
              }
            }
            v = vecOf();
            ok = better(v, cur);
          }
          if (process.env.PIE_CHART_DEBUG_REPAIR) {
            console.error(
              `[pienudge] "${p.item.name}" dx=${((targetRight - lb.right) * cfg.pxPerUnit).toFixed(1)}px: crossPie ${cur.crossPie}->${v.crossPie}, through ${cur.through}->${v.through}, boxPie ${cur.boxPie.toFixed(3)}->${v.boxPie.toFixed(3)} => ${ok ? 'ADOPT' : 'REJECT'}`,
            );
          }
          if (ok) {
            adopted = true;
          } else {
            seamRestore(snapN);
          }
        } else {
          seamRestore(snapN); // 動かす必要が無い場合もクランプ解除を巻き戻す
        }
      }
      // 候補2b: 左 rim 再ハグ。bend 替えで直らない時、現在の Y のまま箱を円外クリアランス X へ
      // 置き直す。円に食い込んだ箱 (label inside pie) を外へ出し、他 leader の回廊を塞ぐ
      // 被害者箱を退かす。
      if (!adopted && p.x < 0) {
        adopted = trySeamMutation(
          placements,
          () => reshapeToLeftRimHug(p, cfg, placementBox(p, cfg).top),
          () => {
            const v = vecOf();
            const ok = better(v, cur);
            if (process.env.PIE_CHART_DEBUG_REPAIR) {
              console.error(
                `[rehug] "${p.item.name}": crossPie ${cur.crossPie}->${v.crossPie}, through ${cur.through}->${v.through}, ` +
                  `boxPie ${cur.boxPie.toFixed(3)}->${v.boxPie.toFixed(3)}, inv ${cur.inv}->${v.inv}, clips ${cur.clips}->${v.clips}, ` +
                  `ovl ${cur.ovl.toFixed(3)}->${v.ovl.toFixed(3)}, view ${cur.view.toFixed(1)}->${v.view.toFixed(1)} => ${ok ? 'ADOPT' : 'REJECT'}`,
              );
            }
            return ok;
          },
        );
      }
    }
    if (adopted) return true; // 不具合集合が変わったので外側 iter で再列挙する
  }
  return false;
}

// 複合手: 交差対の footprint スワップ。bend 替え・nudge で直らない交差は、角度順が正順でも
// 「上スライスのラベル枠が下スライスのアンカー上空を塞ぎ、その leader が相手アンカーの外側を
// 横断する」密集構造で起きる (例 currency_many_small_10: カナダドル×豪ドル)。当事者 2 枚の
// (x, y, baseline) を丸ごと交換すると両 leader が短い扇形へ組み替わり構造的に解ける。
// 交差は ERROR・角度順逆転は WARN なので、この手に限り inv の悪化を許容する (他指標は非悪化)。
function trySwapCrossingPairs(ctx: ResidualRepairCtx, cur: ResidualVec): boolean {
  const { placements, cfg, coord, tol, tolPx, vecOf } = ctx;
  const allPaths = realLeaderPaths(placements, cfg, coord);
  const pairs: [number, number][] = [];
  for (let i = 0; i < allPaths.length; i += 1) {
    const pa = allPaths[i];
    if (!pa) continue;
    for (let j = i + 1; j < allPaths.length; j += 1) {
      const pb = allPaths[j];
      if (pb && pathsCross(pa, pb)) pairs.push([i, j]);
    }
  }
  pairs.sort((m, n) =>
    `${placements[m[0]].item.name} ${placements[m[1]].item.name}`.localeCompare(
      `${placements[n[0]].item.name} ${placements[n[1]].item.name}`,
      'ja',
    ),
  );
  // 交差 (ERROR) の解消を最優先し、through (WARN) への振替は「線不具合の総数が増えない」
  // 範囲で許す (交差 1 件 → through 1 件 への置換は純改善)。振替で生じた through は次 iter の
  // bend 替え (better() の through 厳密減クォーラム) が掃除を試みる。
  const swapBetter = (a: ResidualVec, b: ResidualVec): boolean =>
    a.crossPie < b.crossPie &&
    a.crossPie + a.through <= b.crossPie + b.through &&
    a.clips <= b.clips &&
    a.oob <= b.oob &&
    a.ovl <= b.ovl + tol &&
    a.view <= b.view + tolPx &&
    a.boxPie <= b.boxPie + tol;
  for (const [ia, ib] of pairs) {
    const pa = placements[ia];
    const pb = placements[ib];
    if (pa.insideSlice || pb.insideSlice || pa.forceTopRight || pb.forceTopRight) continue;
    const adopted = trySeamMutation(
      placements,
      () => {
        [pa.x, pb.x] = [pb.x, pa.x];
        [pa.y, pb.y] = [pb.y, pa.y];
        const tb = pa.baseline;
        pa.baseline = pb.baseline;
        pb.baseline = tb;
      },
      () => {
        const v = vecOf();
        const ok = swapBetter(v, cur);
        if (process.env.PIE_CHART_DEBUG_REPAIR) {
          console.error(
            `[crossswap] "${pa.item.name}"<->"${pb.item.name}": crossPie ${cur.crossPie}->${v.crossPie}, ` +
              `through ${cur.through}->${v.through}, inv ${cur.inv}->${v.inv}, clips ${cur.clips}->${v.clips}, ` +
              `ovl ${cur.ovl.toFixed(3)}->${v.ovl.toFixed(3)}, view ${cur.view.toFixed(1)}->${v.view.toFixed(1)} => ${ok ? 'ADOPT' : 'REJECT'}`,
          );
        }
        return ok;
      },
    );
    if (adopted) return true;
  }
  return false;
}

// 複合手: 左列の再積み上げ。bend 単独では直らない交差 (例 page16: escape で左上が空いたのに
// 残った 2 枚が下のスロットに留まり、長い leader 同士がサブピクセル余裕で絡む) は、左列全体を
// 角度順に上から詰め直すと leader が短い扇形になり構造的に解ける。canvas 上端起点と現在の
// 列上端起点の 2 候補を試し、辞書式で厳密に改善する方だけ採用 (do-no-harm・全 revert)。
function tryRestackLeftColumn(
  ctx: ResidualRepairCtx,
  involved: Set<number>,
  cur: ResidualVec,
): boolean {
  const { placements, cfg, vecOf, better } = ctx;
  // 左列「全体」を対象にする (不具合の当事者だけ動かすと残りの箱と重なって却下される)。
  // 発火条件は「列の誰かが不具合に関与している」こと。
  const stack = placements.filter(
    (p) => !p.insideSlice && !p.forceTopRight && p.x < 0 && !isOtherCategory(p.item.name),
  );
  const anyInvolved = stack.some((p) => [...involved].some((i) => placements[i] === p));
  if (stack.length < 2 || !anyInvolved) return false;
  const byAngle = [...stack].sort(
    (m, n) => Math.sin(degToRad(n.item.midAngle ?? 0)) - Math.sin(degToRad(m.item.midAngle ?? 0)),
  );
  const curTop = Math.max(...stack.map((p) => placementBox(p, cfg).top));
  // 円より上のスロットは rim ハグ X が 0 (中央) になり、右上エスケープの riser/斜線の
  // 直下まで箱が広がって貫通する。エスケープ riser (anchor x) の左へ右端をキャップする。
  const escapeAnchors = placements
    .filter((q) => q.forceTopRight && !q.insideSlice)
    .map((q) => q.leaderAnchor.x);
  const rightCap =
    escapeAnchors.length > 0
      ? Math.min(...escapeAnchors) - radialFraction(cfg, 0.03, 0.3)
      : Number.POSITIVE_INFINITY;
  for (const top of [cfg.canvasYlim[1], curTop]) {
    const adopted = trySeamMutation(
      placements,
      () => {
        let y = top;
        for (const p of byAngle) {
          reshapeToLeftRimHug(p, cfg, y);
          if (p.x > rightCap) {
            p.x = rightCap;
            p.origTextX = p.x;
          }
          y -= placementExtent(p, cfg).height + cfg.scaledMinGap;
        }
      },
      () => {
        const v = vecOf();
        const ok = better(v, cur);
        if (process.env.PIE_CHART_DEBUG_REPAIR) {
          console.error(
            `[restack-left] top=${top.toFixed(3)} stack=[${byAngle.map((p) => p.item.name).join(',')}]: ` +
              `crossPie ${cur.crossPie}->${v.crossPie}, through ${cur.through}->${v.through}, inv ${cur.inv}->${v.inv}, ` +
              `ovl ${cur.ovl.toFixed(3)}->${v.ovl.toFixed(3)}, view ${cur.view.toFixed(1)}->${v.view.toFixed(1)} => ${ok ? 'ADOPT' : 'REJECT'}`,
          );
        }
        return ok;
      },
    );
    if (adopted) return true;
  }
  return false;
}

function repairResidualLeaderDefects(
  placements: Placement[],
  cfg: PieLayoutConfig,
  coord: Coord,
): void {
  const tol = pxToLogical(cfg, 2);
  const tolPx = 2;
  const pxUnit = 1 / cfg.pxPerUnit;
  const vecOf = (): ResidualVec => {
    const m = measureRepairVec(placements, cfg, coord);
    return {
      crossPie: m.cross + m.pieCross,
      through: m.through,
      inv: m.inv,
      clips: m.clips,
      oob: m.oob,
      ovl: m.ovl,
      view: m.view,
      boxPie: m.boxPie,
    };
  };
  // 主目的は (交差+円貫通) → (箱貫通) → (箱の円内侵入) の辞書式改善。それ以外は全て非悪化。
  const better = (a: ResidualVec, b: ResidualVec): boolean =>
    ((a.crossPie < b.crossPie && a.through <= b.through && a.boxPie <= b.boxPie + tol) ||
      (a.crossPie === b.crossPie && a.through < b.through && a.boxPie <= b.boxPie + tol) ||
      (a.crossPie === b.crossPie && a.through === b.through && a.boxPie < b.boxPie - tol)) &&
    a.inv <= b.inv &&
    a.clips <= b.clips &&
    a.oob <= b.oob &&
    a.ovl <= b.ovl + tol &&
    a.view <= b.view + tolPx;
  const ctx: ResidualRepairCtx = { placements, cfg, coord, tol, tolPx, pxUnit, vecOf, better };

  // do-no-harm の反復本体: 毎 iter で不具合関与集合を再列挙し、単独手 → 交差スワップ → 左列再積み
  // の順に「最初に改善した 1 手」を採る。どの手も改善しなければ収束として終了 (最大 6 周)。
  for (let iter = 0; iter < 6; iter += 1) {
    const cur = vecOf();
    if (cur.crossPie + cur.through === 0 && cur.boxPie <= tol) return;
    const { order, involved } = collectDefectInvolved(placements, cfg, coord, tol);
    if (process.env.PIE_CHART_DEBUG_REPAIR) {
      console.error(
        `[rebend:iter${iter}] cur={crossPie:${cur.crossPie}, through:${cur.through}, inv:${cur.inv}} involved=[${order.map((i) => placements[i].item.name).join(',')}]`,
      );
    }
    let improved = tryRebendInvolved(ctx, order, cur);
    if (!improved) improved = trySwapCrossingPairs(ctx, cur);
    if (!improved) improved = tryRestackLeftColumn(ctx, involved, cur);
    if (!improved) return;
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
    applyTopBandClusterReorder(result, cfg);
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
    throughPairs,
    crossPairs,
  };
}

/** base に無い要素が cand に 1 つでもあれば true (合計据え置きの局所入替を検出する)。 */
function hasNewPair(cand: Set<string>, base: Set<string>): boolean {
  for (const k of cand) if (!base.has(k)) return true;
  return false;
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
    const hardGuard =
      score.pie <= bestScore.pie &&
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

/** `EMIT_REPAIR_PASSES` の 1 エントリが実行する修復パス本体。 */
type EmitPassFn = (placements: Placement[], cfg: PieLayoutConfig, view: Coord) => void;

export interface EmitRepairPass {
  /** デバッグログ・`PIE_CHART_STOP_AFTER_PASS`・特性テストで参照する一意名。 */
  name: string;
  /** 発火条件 (未指定 = 常時)。現状は leftStackMode 限定の 2 群のみ。 */
  when?: (diag: Diagnostics | null) => boolean;
  run: EmitPassFn;
  /**
   * どの列に含めるか (既定 'emit')。'both' = 採点列 (`finalizeForScoring`) にも同順で含める。
   * 'scoring' = 採点列のみ。採点へ入れないパス (修復系・fallback 系) を emit 限定に保つ理由は
   * `finalizeForScoring` のコメント参照。
   */
  stage?: 'emit' | 'scoring' | 'both';
  /** stage='both' で採点側の実体が emit と異なる場合のみ指定 (例 seam 逃がしの thorough 差)。 */
  scoringRun?: EmitPassFn;
}

/**
 * emit 採用配置に対する最終修復パス列 (宣言テーブル)。位置確定後に 1 回ずつ適用する do-no-harm の
 * 群で、各手の意図はエントリ直上のコメント参照。**順序依存** (前段の解消が後段を no-op にする /
 * 後段が前段の前提に乗る) があるためエントリ順を変えないこと。採点列 (`finalizeForScoring`) も
 * 本テーブルの stage='both'/'scoring' エントリから生成され、scoring↔emit の列 drift を構造的に防ぐ。
 */
export const EMIT_REPAIR_PASSES: readonly EmitRepairPass[] = [
  // 視覚 viewBox はみ出し最終 nudge (採用配置に 1 回だけ適用)。
  { name: 'visualViewBoxNudge', stage: 'both', run: (p, cfg) => applyVisualViewBoxNudge(p, cfg) },
  // viewBox をはみ出す外側ラベルを「収まるまで長体」で縮める最終ガード (下限 0.7)。
  { name: 'finalCondenseToFit', stage: 'both', run: (p, cfg) => applyFinalCondenseToFit(p, cfg) },
  // 長体ラベルをキャンバスに収まる範囲で原寸 (上限 1.0 = デフォルトの大きさ) へ向けて緩和し、
  // ラベルごとにギリギリ収まる最大サイズへ戻す。
  { name: 'relaxNameCondense', stage: 'both', run: (p, cfg) => relaxNameCondense(p, cfg) },

  // 最終段: 同一側で交差する外側 leader 対を縦に引き離して交差を解消する。viewBox nudge /
  // condense-to-fit の後 (= emit と同一の最終配置) に実行するので、ここで見た交差は verify が
  // 報告する交差と一致する。各手は do-no-harm (交差減・重なり非悪化・viewBox 内) で採用。
  // emit では thorough=true (swap 採否を nudge 後の姿で判定)。採点は従来 greedy — 理由は
  // `untangleAngularOrderBySwap` の nudgeBeforeGate コメント参照。
  {
    name: 'outsideLeaderAngularOrder',
    stage: 'both',
    run: (p, cfg, v) => applyOutsideLeaderAngularOrder(p, cfg, v, true),
    scoringRun: (p, cfg, v) => applyOutsideLeaderAngularOrder(p, cfg, v),
  },

  // applyOutsideLeaderAngularOrder の swap で直せない上左トップバンドクラスタの角度順逆転
  // (例 page16: ジャージー右逃がし後 ケイマンが天頂へ来てアイルランドの上に逆転) を、角度順
  // rim 再積み上げで解消する。交差/逆転のどちらかが在る時のみ発火し do-no-harm (悪化で全 revert)。
  { name: 'reorderTopBandLeftCluster', run: reorderTopBandLeftClusterByAngle },

  // 9時線近傍で near-vertical に重なる左小スライス対 (例 イギリス/イタリア) を角度順に並べ直して
  // 左上の空きへわずかに逃がし、各 leader を分離した斜め線にする。do-no-harm (悪化したら revert)。
  { name: 'escapeUpperLeftTinyLeaders', stage: 'both', run: escapeUpperLeftTinyLeaders },

  // 12時シーム近傍の小スライスが左帯へ押し出されて near-horizontal leader が交差する場合、
  // 当該スライスを右上空白へ "up-and-over" で逃がして交差を解消する (do-no-harm)。
  // emit では thorough=true (累積プレフィックス探索 + 1 行化フォールバック) を使う。採点では
  // thorough=false (greedy): 採点に thorough を入れるとチャート単位の候補選択が「emit で直る前提」の
  // スコアへ寄り、修復しきれない別候補を選ぶ退行が出る (例 currency_many_small_10)。
  {
    name: 'escapeTopBandSeamLeader.thorough',
    stage: 'both',
    run: (p, cfg, v) => escapeTopBandSeamLeader(p, cfg, v, true),
    scoringRun: (p, cfg, v) => escapeTopBandSeamLeader(p, cfg, v),
  },

  // 採点列のみ: leftStackMode の右上リフト済ラベルの縦積み整列。emit 側は cascade 内で処理済み。
  {
    name: 'stackTopRightLiftedLabels',
    stage: 'scoring',
    when: (d) => d?.leftStackMode === true,
    run: (p, cfg) => stackTopRightLiftedLabels(p, cfg),
  },

  // leftStackMode 限定の最終手段: untangle で直せない幅広/混在行の左上逆転を、角度順 re-stack +
  // 長体圧縮で解消する (do-no-harm・悪化したら全 revert)。
  {
    name: 'reorderLeftStackWithCondense',
    stage: 'both',
    when: (d) => d?.leftStackMode === true,
    run: reorderLeftStackWithCondense,
  },
  {
    name: 'separateLeftColumnByHeight',
    stage: 'both',
    when: (d) => d?.leftStackMode === true,
    run: separateLeftColumnByHeight,
  },

  // 残余の leader 交差/円内貫通/箱貫通を bend 再配置で解消する最終安全網 (do-no-harm)。
  // finalizeForScoring と同位置・同条件で呼び、採点と emit の一致を保つ。
  { name: 'repairResidualLeaderDefects', run: repairResidualLeaderDefects },

  // 円外ラベル box の円内侵入 (label inside pie) を、現在 y での動的 pie クランプで円外へ押し出す
  // 最終安全網 (do-no-harm)。cascade の nudge を静的 minTextX が引き戻す取りこぼし (例
  // stress_top_cluster_8 "F") を解消する。侵入の無いチャートは早期 return で無変更。
  { name: 'enforceFinalPieClearance', run: enforceFinalPieClearance },

  // 左側 near-equator の見切れラベルを、円の縦中心から離す向きへ縦 spread して左 rim を細らせ
  // viewBox 左端の見切れを解消する最終手段 (do-no-harm)。水平 nudge が pie にブロックされる
  // (|y| < pieRadius) ラベルが対象。`applyLowerLeftDropFallback` / `applyTwoLineNameFallback` より
  // 先に試し、解消すれば後続が no-op になる。採否は片側単位で `countDefects` の clips 厳密減・他カテゴリ非悪化。
  { name: 'verticalDeclipFallback', run: applyVerticalDeclipFallback },

  // 9時直近で長体下限でも見切れる幅広長名を、下left ドロップ + 斜めリーダーで収める最終手段
  // (do-no-harm)。位置確定後に走るので最終配置を正しく評価する。密チャートで交差/反転を生む場合は revert。
  { name: 'lowerLeftDropFallback', run: applyLowerLeftDropFallback },

  // 下限長体 (0.7) でも viewBox を見切れる 1 行ラベルを、名前を語中で割らない標準 2 行 [名前, %] へ
  // 変換する最終手段 (do-no-harm)。語割れ (旧 splitLongName) は pie-chart 全体で廃止。位置確定後に走るので
  // ゲートは最終配置を正しく評価する。採点 (`finalizeForScoring`) には入れない: 候補選択を乱さず、
  // finalScore は emit 後の同 placements から数えるため scorer ↔ emit 整合は保たれる。
  { name: 'twoLineNameFallback', run: applyTwoLineNameFallback },

  // 外側ラベル列の最終整え (overflow fallback の後 = 真に未解消のものだけ対象)。左右両列の過小ギャップ
  // (隣接 box が box 高未満に詰まる縦重なり) を上下対称に拡げ、なお viewBox を見切れるラベルを pie
  // クリアランス限界まで pie 側へ寄せる。fallback 後に置くことで、drop/2 行化で解消済みのラベル (例
  // fidelity オフショア・人民元) は対象外となり干渉しない。両手とも全チャート共通で do-no-harm
  // (列内重なり厳密減 / 見切れ厳密減 + 他カテゴリ非悪化) なので、収まっている図は無変更。
  { name: 'relieveOutsideColumnOverlap', run: relieveOutsideColumnOverlap },
  { name: 'pullOutsideOverflowTowardPie', run: pullOutsideOverflowTowardPie },

  // ソフトマージンには長体下限でも収まらない構造的オーバーフロー (例 currency の "ユーロ": percent 行だけで
  // 残り幅を食う短名) が下限で過圧縮されたまま残るのを、実 viewBox を見切らない範囲で原寸へ緩和する。
  // 位置確定後・finalScore 前に 1 回。emit 専用 (scoring 非干渉) で applyTwoLineNameFallback と同方針。
  { name: 'relaxStructuralCondense', run: relaxStructuralCondense },

  // near-contact (近接) 緩和: 自 leader が隣の box/leader に寄りすぎるラベルを上へ逃がして接触を軽減する
  // (例 page16 ケイマン諸島)。全 hard-defect パスの後に置くので、ここでの移動が最終配置となり leader
  // (下 Pass 1) も移動後 box から再計算され追従する。do-no-harm: 近接の無い図は deficit≈0 で無変更。
  { name: 'relieveLeaderNeighborContact', run: relieveLeaderNeighborContact },

  // leftStackMode の左上スタック最終整え (全 hard-defect パス後)。左 envelope からの突出を pie 寄りへ
  // 引き戻し (見切れ解消)、赤道寄りの密集側行を円から少し離す。各移動は do-no-harm で個別採否。
  {
    name: 'relieveLeftStackSpacing',
    when: (d) => d?.leftStackMode === true,
    run: relieveLeftStackSpacing,
  },
  // `relieveLeftStackSpacing` が左列を pie 寄りへ右シフトして x を確定させた後は、上の
  // `relaxStructuralCondense` 評価時より実 viewBox 余白が増えている。x 確定後にもう一度緩和し、
  // 右シフトで不要になった長体 (例 `stress_top_cluster_8` の "C") を原寸へ戻す。緩めるだけ・
  // ガードは不変なので退行しない (ガードが拒否すれば現状維持 = no-op)。上の relaxStructuralCondense
  // 後に x を動かすパスは leftStackMode の本パスだけ (`relieveLeaderNeighborContact` は
  // 縦移動のみで横余白を増やさない) なので、再緩和はここに限定で全消し忘れを拾える。
  {
    name: 'relaxStructuralCondense.afterLeftStackShift',
    when: (d) => d?.leftStackMode === true,
    run: relaxStructuralCondense,
  },

  // 最終: anchor 固定の `relaxStructuralCondense` でも戻せない (= viewBox 端ハグの) 長体ラベルを、
  // pie 側へ必要最小限シフトしてから原寸へ戻す。「戻せるのに長体のまま」を残さないための仕上げ。
  // pie 側辺は pie 円周でキャップ・採否は do-no-harm ゲートなので退行しない (戻せなければ no-op)。
  { name: 'unsqueezeCondensedByShiftTowardPie', run: unsqueezeCondensedByShiftTowardPie },

  // leftStackMode の左列が接触級に詰まるとき、列を viewBox 縦全域へ等ギャップ展開する
  // (`applyLeftStackGapClose` の広げる版)。x/長体率の確定後・右上仕上げの前に置く。
  {
    name: 'spreadLeftStackFullHeight',
    when: (d) => d?.leftStackMode === true,
    run: spreadLeftStackFullHeight,
  },

  // 最終仕上げ: 右上 escapee スタックの整え — 押し下げられた「その他」の pie キャップ復帰 (縦) と
  // escapee の書き出し x の「その他」揃え (横)。座標を動かす最後のパスとして末尾に置く — leader は
  // 移動後 box から再計算され追従する (do-no-harm)。
  { name: 'tidyTopRightEscapeeStack', run: tidyTopRightEscapeeStack },
];

/**
 * `EMIT_REPAIR_PASSES` を順に適用する。view は emit と同一座標系 (実 viewBox 基準)。
 * デバッグ支援 (どちらも測定は純粋読み取りで出力 byte に影響しない):
 * - `PIE_CHART_DEBUG_REPAIR=1` … パスごとの `RepairVec` 差分を stderr へ出す (無変化パスは無音)。
 * - `PIE_CHART_STOP_AFTER_PASS=<name>` … 指定パスの直後で打ち切る (回帰の犯人パスを二分探索する用)。
 */
function applyEmitRepairPasses(
  textPlacements: Placement[],
  cfg: PieLayoutConfig,
  view: Coord,
  diagnostics: Diagnostics | null,
): void {
  const debug = Boolean(process.env.PIE_CHART_DEBUG_REPAIR);
  for (const pass of EMIT_REPAIR_PASSES) {
    if (pass.stage === 'scoring') continue;
    if (pass.when && !pass.when(diagnostics)) continue;
    if (debug) {
      const before = measureRepairVec(textPlacements, cfg, view);
      pass.run(textPlacements, cfg, view);
      const after = measureRepairVec(textPlacements, cfg, view);
      const diffs = (Object.keys(before) as (keyof RepairVec)[])
        .filter((k) => before[k] !== after[k])
        .map((k) => `${k} ${Number(before[k].toFixed(2))}->${Number(after[k].toFixed(2))}`);
      if (diffs.length > 0) console.error(`[emit-pass] ${pass.name}: ${diffs.join(', ')}`);
    } else {
      pass.run(textPlacements, cfg, view);
    }
    if (process.env.PIE_CHART_STOP_AFTER_PASS === pass.name) return;
  }
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
