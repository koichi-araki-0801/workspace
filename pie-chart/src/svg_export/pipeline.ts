// =============================================================================
// svg_export/pipeline.ts — renderPdfStylePieToSvg (public API, orchestrator)
// -----------------------------------------------------------------------------
// 入力 items → 最終 SVG 文字列を組み立てる本ライブラリの最終出力点。
// サブモジュールの責務:
//   - rendering.ts   : 座標変換 + スライス path + text 要素 + 視覚 em 推定
//   - post_layout.ts : overlap 解消 / compactify cascade / 半角カナ fallback /
//                      視覚 viewBox nudge
//   - emit_repair.ts : emit 修復パス列 (EMIT_REPAIR_PASSES) + 採点・計測・do-no-harm ゲート基盤
//   - mode_passes.ts : モード特化パス (左列 / top-band クラスタ / 右上逃がし)
//   - font.ts        : フォントサブセット埋込 (TTF → WOFF2)
// =============================================================================

import { createPieLayoutConfig, makeColors } from '../config.js';
import { normalizeInputItems } from '../input/load.js';
import { layoutLabels } from '../layout/diagnostics.js';
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
} from '../layout/geometry.js';
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
} from '../layout/placement.js';
import type { InsideOption } from '../layout/placement.js';
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
// モード特化パス (左列 / top-band / 右上逃がし) は mode_passes.ts へ集約。
import {
  applyLeftStackGapClose,
  applyTopBandClusterReorder,
  applyTwoLineLeftColumn,
  isLeftStackMember,
  leftStackOverflowItems,
  spreadLeftStackByAngle,
  stackTopRightLiftedLabels,
} from './mode_passes.js';

export { distPointToSegment, pathsCross } from './leader_geometry.js';
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
 * 下left ドロップ + 斜めリーダー フォールバック (emit 最終段, do-no-harm)。`layout/diagnostics.ts` の
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

  // 孤立極小スライス leader 型 (`layout/diagnostics.ts` の `markLoneTopSliverLeader`) では『その他』を右上へ確定
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
 * pie キャップ外の箱に対する静的 pie クランプの「名残制約」除去 (`layout/placement.ts` の
 * `clampAndBuildPlacement`) を、チャート単位で採否する do-no-harm。
 *
 * 名残制約は動的側 `pieClampXLimits` (`layout/geometry.ts`) が持たない静的側だけの非対称で、円と X 方向で
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
 * `layout/diagnostics.ts` の `leftStackMode` ゲート / `isCascadeFailed` (`dominantOutsideEdge`) と同じ `svgWidthPx`
 * 基準に統一する (detectVisualHorizontalOverflow は可動域 canvasXlim 基準で狭すぎるため使わない)。
 * これにより viewBox に収まる中位ラベルは 1 行を維持し、見切れ判定 (= viewBox) とも整合する。
 *
 * 起点を戻すフラグは 3 点セット (preferOneLineCascade / compactLabel / textLines)
 * で `layout/diagnostics.ts` の `leftStackMode` と対称に書き戻す。`textLines` を 2 (長名は 3) に復元する
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
  // context='candidateScoring': `finalOnly` の最終確定パス (applyLeftStackClusterEvenSpread) は
  // 通さない。混ぜると escape 候補の採点が確定パス適用後の姿で歪み、escape 数の選択自体が変わる
  // (`EmitRepairPass.finalOnly` の doc comment 参照)。
  applyEmitRepairPasses(finalized, cfg, coord, layout.diagnostics, 'candidateScoring');
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
 * 上左ラベルを何枚 右上へ逃がすか (`layout/diagnostics.ts` の `markLeftStackUpperEscapeRight`) をチャート単位で
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
