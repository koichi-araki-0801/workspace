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

import { createPieLayoutConfig, makeColors } from "../config.js";
import { normalizeInputItems } from "../data.js";
import { layoutLabels } from "../layout.js";
import {
  normalizeAngle,
  angleInBand,
  estimateTextExtent,
  estimateVerifyTextExtent,
  nudgeTextAwayFromPie,
  placementBox,
  placementExtent,
  leaderCrossesBox,
  radialFraction,
  degToRad,
  upperLeftBendPoint,
} from "../svg_geom.js";
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
} from "../label_placement.js";
import type { InsideOption } from "../label_placement.js";
import type {
  PieLayoutConfig,
  RenderResult,
  LayoutItem,
  LayoutItemReady,
  LayoutResult,
  Diagnostics,
  Placement,
} from "../types.js";

import {
  createCoordinateSystem,
  buildSlicePath,
  computeArcs,
  escapeXml,
  textFragment,
} from "./rendering.js";
import {
  resolveLabelOverlaps,
  clampPlacement,
  POST_LAYOUT_PASS_COUNT,
  runCompactCascade,
  applyVisualViewBoxNudge,
  applyFinalCondenseToFit,
  trySplitNamePlacement,
  restoreSplitNamePlacement,
  relaxNameCondense,
} from "./post_layout.js";
import { buildFontFaceDefs } from "./font.js";
import {
  ALWAYS_DRAW_OUTSIDE_LEADERS,
  computeDrawnLeader,
  isRedundantUpperLeftSmallLeader,
  resolveLeaderCrossings,
  distPointToSegment,
  pathsCross,
  realLeaderPaths,
  countLeaderCrossings,
  countLeaderThroughLabels,
  boxOverlapMax,
  boxPieIntrusionMax,
  boxViewOverflowOf,
  boxViewOverflowMax,
  projectBoxesToPixels,
  oobLeaderCount,
  countAngularDiscordantPairs,
} from "./leader_geometry.js";
import type { Pt, Coord } from "./leader_geometry.js";

export { escapeXml } from "./rendering.js";
export { distPointToSegment, pathsCross } from "./leader_geometry.js";

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
  const px = (n: number) => n / (cfg.mmPerUnit * cfg.svgUnitsPerMm);
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
    const ox = Math.min(box.right, b.right) - Math.max(box.left, b.left);
    const oy = Math.min(box.top, b.top) - Math.max(box.bottom, b.bottom);
    if (ox > overlapTol && oy > overlapTol) return true;
  }
  return false;
}

// leader 折れ線の幾何プリミティブ (computeDrawnLeader / isRedundantUpperLeftSmallLeader /
// resolveLeaderCrossings / distPointToSegment) と型 Pt / Coord は ./leader_geometry.js へ分離した。
/**
 * 全ラベルを①〜⑨カスケードで 1 回配置する。① が wedge に収まれば内側で確定、否なら②外側 rim
 * から始め、overlap/pie nudge を反復しつつ失敗ラベルを 1 段ずつ降格させて収束させる。
 * 上部「その他」を右上へ置くかは item.topRightRejected (topBandSonohokaRight が参照) で決まる。
 */
/** leftStackMode の左列とみなす placement (side=left・baseline=bottom・非 inside・x<0)。 */
function isLeftStackMember(p: Placement): boolean {
  return p.item.side === "left" && p.baseline === "bottom" && !p.insideSlice && p.x < 0;
}

/** twoLineLeftStackMode の左列メンバ (上部「その他」・真下中央・flip・inside を除く左側外側ラベル)。 */
function twoLineLeftColumnMembers(placements: Placement[]): Placement[] {
  return placements.filter(
    (p) =>
      p.item.side === "left" &&
      !p.insideSlice &&
      !p.item.flipToRight &&
      !p.item.flipToLeft &&
      !p.item.bottomCenterBelow &&
      topBandSonohokaZone(p.item) === null &&
      !p.item.name.startsWith("その他"),
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
    (a, b) =>
      Math.sin(degToRad(b.item.midAngle ?? 0)) - Math.sin(degToRad(a.item.midAngle ?? 0)),
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
    if (typeof ny === "number") p.y = ny;
  }
  // 角度順 (上→下 = sin 降順)。
  const byAngle = [...stack].sort(
    (a, b) =>
      Math.sin(degToRad(b.item.midAngle ?? 0)) - Math.sin(degToRad(a.item.midAngle ?? 0)),
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
      ? insideOpts[5] ? 5 : 6
      : insideOpts[1] ? 1 : 2;
    return { item, insideOpts, rank, placement: buildPlacementForRank(item, cfg, insideOpts, rank) };
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
 * 後段順は renderPdfStylePieToSvg と一致: nudge → condense-to-fit → relax-condense →
 * 角度順引き離し → 9時逃がし →（leftStackMode のみ）reorderLeftStackWithCondense。
 * leftStackMode を渡さないと emit 限定の最終 re-stack を取りこぼし採点が emit とズレる。
 */
function finalizeForScoring(
  placements: Placement[],
  cfg: PieLayoutConfig,
  coord: Coord,
  leftStackMode = false,
): Placement[] {
  const copy = placements.map((p) => ({ ...p }));
  applyVisualViewBoxNudge(copy, cfg);
  applyFinalCondenseToFit(copy, cfg);
  // 名前 2 行分割 (applySplitNameFallback) は emit 最終段のみで適用する (候補選択を乱さない)。
  relaxNameCondense(copy, cfg);
  applyOutsideLeaderAngularOrder(copy, cfg, coord);
  escapeUpperLeftTinyLeaders(copy, cfg, coord);
  escapeTopBandSeamLeader(copy, cfg, coord);
  if (leftStackMode) reorderLeftStackWithCondense(copy, cfg, coord);
  // repairResidualLeaderDefects は emit 最終段のみで適用する (ここには入れない)。採点へ入れると
  // 「修復で直る前提」のスコアでチャート単位の候補選択 (ソノホカ右/左・spread 等) が動き、修復
  // しきれない別候補を選ぶ退行を生む (例 currency_many_small_10)。finalScore は emit 後の同一
  // placements から数えるため scorer ↔ emit の整合 (verify_consistency) はこの除外でも崩れない。
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
      if (distPointToSegment(cx, cy, path[k].x, path[k].y, path[k + 1].x, path[k + 1].y) < pieR - 1) {
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
 * 名前 2 行分割フォールバック (emit 最終段, do-no-harm)。下限長体 (0.7) でも viewBox を見切れる
 * 長カタカナ/長熟語ラベルを splitLongName で 2 行へ分割し、チャート全体の不具合 (countDefects) が
 * 「clips 厳密減・crossings/pie/total 非悪化」を満たす時だけ採用する。全後段の後 (= 位置確定後) に
 * 走るのでゲートは最終配置を正しく評価する。部分的にしか収まらない分割は clips が減らず revert される。
 */
function applySplitNameFallback(placements: Placement[], cfg: PieLayoutConfig, coord: Coord): void {
  const { xScale, yScale, width, height } = coord;
  // verify と同基準の box→pie 侵入 (countDefects は leader 貫通のみ数え box 侵入は数えないため、
  // 1 行→2 行で高さが倍増し box が円へ食い込むケースをここで個別に捕捉する)。
  const pieRpx = Math.abs(xScale(cfg.pieRadius) - xScale(0));
  const cxp = xScale(0);
  const cyp = yScale(0);
  const pixBox = (p: Placement) => {
    const lb = placementBox(p, cfg);
    return {
      left: Math.min(xScale(lb.left), xScale(lb.right)),
      right: Math.max(xScale(lb.left), xScale(lb.right)),
      top: Math.min(yScale(lb.top), yScale(lb.bottom)),
      bottom: Math.max(yScale(lb.top), yScale(lb.bottom)),
    };
  };
  const clipsViewBox = (p: Placement): boolean => {
    const b = pixBox(p);
    return b.left < -1 || b.right > width + 1 || b.top < -1 || b.bottom > height + 1;
  };
  const countBoxPie = (): number => {
    let n = 0;
    for (const p of placements) {
      if (p.insideSlice) continue;
      const b = pixBox(p);
      const closestX = Math.max(b.left, Math.min(cxp, b.right));
      const closestY = Math.max(b.top, Math.min(cyp, b.bottom));
      if (Math.hypot(closestX - cxp, closestY - cyp) < pieRpx - 2) n += 1;
    }
    return n;
  };
  const overlapsOf = (d: DefectCounts): number => d.total - d.clips - d.crossings - d.pie;

  let before = countDefects(placements, cfg, coord);
  if (before.clips === 0) return;
  let beforePieBox = countBoxPie();
  for (const p of placements) {
    if (p.insideSlice || p.nameSplit || !clipsViewBox(p)) continue;
    const snap = trySplitNamePlacement(p, cfg);
    if (!snap) continue;
    const after = countDefects(placements, cfg, coord);
    const afterPieBox = countBoxPie();
    // do-no-harm: clips が厳密に減り、他の全カテゴリ (交差/leader円貫通/重なり/box円侵入) が非悪化。
    const adopt =
      after.clips < before.clips &&
      after.crossings <= before.crossings &&
      after.pie <= before.pie &&
      overlapsOf(after) <= overlapsOf(before) &&
      afterPieBox <= beforePieBox;
    if (adopt) {
      before = after;
      beforePieBox = afterPieBox;
    } else {
      restoreSplitNamePlacement(p, snap);
    }
  }
}

/**
 * 下left ドロップ + 斜めリーダー フォールバック (emit 最終段, do-no-harm)。layout.ts
 * markClippedUpperLeftLongDrop が識別した lowerLeftDropLeader ラベル (9時直近で長体下限でも
 * viewBox 左端を見切れる幅広長名) を、円が横へ逃げ帯が広い下left へ 2 行のまま置き直し
 * (buildLowerLeftDropLeaderDraft)、slice rim から斜めリーダーで接続する (参考PDF「オーストラリア」)。
 * チャート全体の不具合 (countDefects) が「clips 厳密減・crossings/pie/重なり/box円侵入 非悪化」を
 * 満たす時だけ採用する。密チャート (例 asset_long_labels_9) で交差/順序反転を生む場合は revert され、
 * 当該チャートは baseline (rim 2 行) のまま = 回帰なし。applySplitNameFallback と同じ do-no-harm 流儀。
 */
function applyLowerLeftDropFallback(placements: Placement[], cfg: PieLayoutConfig, coord: Coord): void {
  const { xScale, yScale, width, height } = coord;
  const pieRpx = Math.abs(xScale(cfg.pieRadius) - xScale(0));
  const cxp = xScale(0);
  const cyp = yScale(0);
  const pixBox = (p: Placement) => {
    const lb = placementBox(p, cfg);
    return {
      left: Math.min(xScale(lb.left), xScale(lb.right)),
      right: Math.max(xScale(lb.left), xScale(lb.right)),
      top: Math.min(yScale(lb.top), yScale(lb.bottom)),
      bottom: Math.max(yScale(lb.top), yScale(lb.bottom)),
    };
  };
  const clipsViewBox = (p: Placement): boolean => {
    const b = pixBox(p);
    return b.left < -1 || b.right > width + 1 || b.top < -1 || b.bottom > height + 1;
  };
  const countBoxPie = (): number => {
    let n = 0;
    for (const p of placements) {
      if (p.insideSlice) continue;
      const b = pixBox(p);
      const closestX = Math.max(b.left, Math.min(cxp, b.right));
      const closestY = Math.max(b.top, Math.min(cyp, b.bottom));
      if (Math.hypot(closestX - cxp, closestY - cyp) < pieRpx - 2) n += 1;
    }
    return n;
  };
  const overlapsOf = (d: DefectCounts): number => d.total - d.clips - d.crossings - d.pie;

  let before = countDefects(placements, cfg, coord);
  if (before.clips === 0) return;
  let beforePieBox = countBoxPie();
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
    const after = countDefects(placements, cfg, coord);
    const afterPieBox = countBoxPie();
    const adopt =
      after.clips < before.clips &&
      after.crossings <= before.crossings &&
      after.pie <= before.pie &&
      overlapsOf(after) <= overlapsOf(before) &&
      afterPieBox <= beforePieBox;
    if (adopt) {
      before = after;
      beforePieBox = afterPieBox;
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
  const topOthers = labels.filter((it) => topBandSonohokaZone(it) === "core");
  for (const it of topOthers) it.topRightRejected = false;
  const right = runCascadeOnce(labels, cfg, spreadLeftStack);
  if (topOthers.length === 0) return right;

  const rightIssues = countVerifyIssuesDetailed(right, cfg, coord, leftStackMode);
  for (const it of topOthers) it.topRightRejected = true;
  const left = runCascadeOnce(labels, cfg, spreadLeftStack);
  for (const it of topOthers) it.topRightRejected = false;
  const leftIssues = countVerifyIssuesDetailed(left, cfg, coord, leftStackMode);

  // 孤立極小スライス leader 型 (layout.ts markLoneTopSliverLeader) では『その他』を右上へ確定
  // (右逃がし)。これをしないと極小の up-and-over leader が中央の『その他』box を貫いて Pass 2 で
  // 抑制され、せっかくの leader が消える。本印は同マーカーの厳ゲートでこの 1 構成のみに立つ。
  if (labels.some((it) => it.loneTopSliverLeader)) return right;
  // 右上(第一優先)は「見切れ/交差/円内貫通を左上より悪化させない」なら採用する。判定は実描画
  // (ALWAYS_DRAW) + 全後段で数える countVerifyIssuesDetailed を使い、後段 (角度順引き離し/9時
  // 逃がし) が解消する見かけ上の交差で右上を誤却下しない。幅モデルを実 glyph advance に統一した
  // ことで placementBox の clips が実描画と一致するため、clips も
  // 比較に再導入する。右逃がしが本当に悪い構成 (例 currency_many_small_10: 極小その他が隣接 leader
  // と交差) は crossings/pie で弾ける。
  const rightNotWorse =
    rightIssues.clips <= leftIssues.clips &&
    rightIssues.crossings <= leftIssues.crossings &&
    rightIssues.pie <= leftIssues.pie;
  return rightNotWorse ? right : left;
}

/**
 * 1 行起点 (preferOneLineCascade=true) の左側ラベルに対する probe-then-override:
 * cascade を一度プローブし、1 行 placement の実描画 bbox が実 viewBox (svgWidthPx) の
 * 左右端を越える label のみ起点を 2 行 (rank 1/2) に戻す。
 *
 * 「左側密集は 1 行優先・入る分だけ」方針。位置 (左帯のどこにあるか) では判定せず、実 bbox が
 * viewBox を越える時だけ 2 行に戻す (= 物理的に 1 行で入らない長名のみ救済)。判定境界は
 * layout.ts leftStackMode ゲート / isCascadeFailed (dominantOutsideEdge) と同じ svgWidthPx
 * 基準に統一する (detectVisualHorizontalOverflow は可動域 canvasXlim 基準で狭すぎるため使わない)。
 * これにより viewBox に収まる中位ラベルは 1 行を維持し、見切れ判定 (= viewBox) とも整合する。
 *
 * 起点を戻すフラグは 3 点セット (preferOneLineCascade / compactLabel / textLines)
 * で layout.ts leftStackMode と対称に書き戻す。textLines を 2 (長名は 3) に復元する
 * ことで後段 applyVisualViewBoxNudge (1 行除外ガード) も通過し、最終 shift 救済も
 * 効くようになる。2 行が物理的に入らなければ本番 cascade が 1行/長体/leader まで自然降格
 * するので safety net は既存挙動が担う。
 */
function overrideOverflowPreferOneLine(labels: LayoutItemReady[], cfg: PieLayoutConfig): void {
  const candidates = labels.filter((it) => it.preferOneLineCascade && it.side === "left");
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
    const measured =
      p.measured ?? { width: 0, height: cfg.fontSizeUnits * cfg.lineHeightFactor };
    const clearance = cfg.pieLabelClearance;
    const pieR = cfg.pieRadius;
    for (let step = 0; step < 8; step += 1) {
      let left: number, right: number;
      if (p.anchor === "start") { left = p.x; right = p.x + measured.width; }
      else if (p.anchor === "end") { left = p.x - measured.width; right = p.x; }
      else { left = p.x - measured.width / 2; right = p.x + measured.width / 2; }
      let top: number, bot: number;
      if (p.baseline === "top") { top = p.y + measured.height; bot = p.y; }
      else if (p.baseline === "bottom") { top = p.y; bot = p.y - measured.height; }
      else { top = p.y + measured.height / 2; bot = p.y - measured.height / 2; }
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
      const prevH = prev.measured?.height ?? (cfg.fontSizeUnits * cfg.lineHeightFactor);
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
    const lastH = lastNonBottom.measured?.height ?? (cfg.fontSizeUnits * cfg.lineHeightFactor);
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
      const measured =
        p.measured ?? { width: 0, height: cfg.fontSizeUnits * cfg.lineHeightFactor };
      const pieR = cfg.pieRadius;
      const xClearance = 0.1;
      const requiredRight = -(pieR + xClearance);
      let bboxRight: number;
      if (p.anchor === "start") bboxRight = p.x + measured.width;
      else if (p.anchor === "end") bboxRight = p.x;
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
  side: "left" | "right",
): void {
  // side は実描画 (p.x の符号) で判定する。item.side / flipToRight / flipToLeft は logical layout
  // のフラグで、cascade の rim 配置はこれらを無視して midAngle で置くため実描画サイドと乖離し得る
  // (例: flipToRight=true のまま左に描かれたラベルが修復対象から漏れ、交差が直せない)。
  const stack = placements.filter(
    (p) =>
      !p.item.clusterTopBand &&
      !p.insideSlice &&
      (side === "left" ? p.x < 0 : p.x > 0),
  );
  if (stack.length < 2) return;
  const inStack = new Set(stack);
  const tol = 2 / (cfg.mmPerUnit * cfg.svgUnitsPerMm);
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
  side: "left" | "right",
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
      !(p.item.name.startsWith("その他") && (topBandSonohokaZone(p.item) !== null || p.forceTopRight)) &&
      (side === "left" ? p.x < 0 : p.x > 0),
  );
  if (stack.length < 2) return;

  const tol = 2 / (cfg.mmPerUnit * cfg.svgUnitsPerMm);
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
      side === "left" ? -rimXmag : rimXmag,
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
        if (process.env.GRAPH2_DEBUG_REPAIR) {
          console.error(
            `[untangle ${side}] swap${swapX ? "(footprint)" : "(rehug)"} "${up.item.name}"<->"${lo.item.name}": ` +
              `inv ${beforeInv}->${countAngularDiscordantPairs(placements, cfg, coord)}, ` +
              `cross ${beforeCross}->${countLeaderCrossings(placements, cfg, coord)}, ` +
              `ovl ${beforeOverlap.toFixed(3)}->${maxOverlap().toFixed(3)}, pie ${beforePie.toFixed(3)}->${maxPieIntrusion().toFixed(3)}, ` +
              `view ${beforeView.toFixed(1)}->${maxViewOverflow().toFixed(1)}, oov ${beforeOutOfView}->${anyOutOfView()} => ${harm ? "REJECT" : "ADOPT"}`,
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
): void {
  separateCrossingPairs(placements, cfg, coord, "left");
  separateCrossingPairs(placements, cfg, coord, "right");
  // 交差0 のまま順序だけ逆転している隣接対を (y, baseline) スワップで角度順へ寄せる (do-no-harm)。
  untangleAngularOrderBySwap(placements, cfg, coord, "left");
  untangleAngularOrderBySwap(placements, cfg, coord, "right");
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
      p.baseline === "bottom" &&
      !p.item.name.startsWith("その他") &&
      p.x < 0,
  );
  if (stack.length < 4) return;

  const tol = 2 / (cfg.mmPerUnit * cfg.svgUnitsPerMm);
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
    (a, b) =>
      Math.sin(degToRad(b.item.midAngle ?? 0)) - Math.sin(degToRad(a.item.midAngle ?? 0)),
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
      p.item.side === "left" &&
      p.item.isUpperLeft === true &&
      !p.item.flipToRight &&
      !p.insideSlice &&
      p.baseline === "bottom" &&
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
  const tol = 2 / (cfg.mmPerUnit * cfg.svgUnitsPerMm);
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
    if (it.side !== "left") return false;
    if (it.isSmall !== true) return false;
    if (p.anchor !== "end") return false;
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
  const tol = 2 / (cfg.mmPerUnit * cfg.svgUnitsPerMm);
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
    (a, b) =>
      Math.sin(degToRad(b.item.midAngle ?? 0)) - Math.sin(degToRad(a.item.midAngle ?? 0)),
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

/** placement の全可変フィールドのスナップショット (seam 系パスの全 revert 用・退行0 を担保)。 */
interface SeamSnap {
  p: Placement;
  v: Partial<Placement>;
}
function seamSnapshot(placements: Placement[]): SeamSnap[] {
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
function seamRestore(snap: SeamSnap[]): void {
  for (const { p, v } of snap) Object.assign(p, v);
}

/**
 * placement を左 rim ハグの正準フォーム (anchor=end/baseline=bottom) へ整える。Y は引数で固定し
 * (等間隔スタックを崩さないため nudge を使わず)、anchor=end の右端 X を「box 下端 (中心に最も近い辺)
 * がパイ外になる位置」へ直接計算する。leader は、anchor→ラベルの直線がパイを貫く構成員のみ
 * `upperLeftBendPoint` で1点曲げ (アンカーから水平に出て曲げる L 字) にし、それ以外は degenerate (直線)。
 */
function reshapeToLeftRimHug(p: Placement, cfg: PieLayoutConfig, y: number): void {
  const pieR = cfg.pieRadius;
  p.anchor = "end";
  p.baseline = "bottom";
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
  const pieClear = pieR - 2 / (cfg.mmPerUnit * cfg.svgUnitsPerMm);
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
  if (countLeaderCrossings(placements, cfg, coord) === 0) return;
  const cx = coord.xScale(0);
  const pieR = cfg.pieRadius;
  const tol = 2 / (cfg.mmPerUnit * cfg.svgUnitsPerMm);
  const cluster = placements.filter(
    (p) =>
      !p.insideSlice &&
      !p.forceTopRight &&
      !p.item.name.startsWith("その他") &&
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
          0, 0, r.pathPoints[k].x, r.pathPoints[k].y, r.pathPoints[k + 1].x, r.pathPoints[k + 1].y,
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
  const snap = seamSnapshot(placements);

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

  // viewBox はみ出しは soft cost (WARN 級)。reorderLeftStackWithCondense と同じく交差/逆転 (hard)
  // を消すためなら 1 行高 (VIEW_OVERFLOW_CAP_PX) までの増加を許容する。重なり/パイ侵入/leader貫通/
  // leader貫通(box)は非悪化必須。leader のパイ貫通も非悪化必須 (ルクセンブルクの1点曲げ化で減る)。
  const harm =
    countLeaderCrossings(placements, cfg, coord) >= beforeCross ||
    countAngularDiscordantPairs(placements, cfg, coord) > beforeDisc ||
    maxOverlap() > beforeOverlap + tol ||
    maxPieIntrusion() > beforePie + tol ||
    maxViewOverflow() > beforeView + VIEW_OVERFLOW_CAP_PX ||
    countLeaderThroughLabels(placements, cfg, coord) > beforeThrough ||
    maxLeaderPie() > beforeLeaderPie + tol;
  if (harm) seamRestore(snap);
}

/**
 * 確定済 placement を「右上逃がし (topBandSmallRight と同一フォーム)」へ破壊的に変形する。
 * slice から縦に抜けて右へ折れる L 字 leader (forceTopRight) + anchor=start/baseline=bottom。
 * 座標は label_placement.ts topBandSmallRight と一致させ、computeDrawnLeader の forceTopRight
 * 分岐 (キャップ越え水平区間) に乗せる。labelY を yOffset 分だけ上へずらせば複数枚を縦に重ねられる。
 */
function reshapeToTopRightEscape(p: Placement, cfg: PieLayoutConfig, yOffset = 0): void {
  const anchorX = p.leaderAnchor.x;
  const labelX = Math.abs(anchorX) + radialFraction(cfg, 0.12, 1.5);
  const labelY = cfg.pieRadius + radialFraction(cfg, 0.04, 0.4) + yOffset;
  p.anchor = "start";
  p.baseline = "bottom";
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
  const tol = 2 / (cfg.mmPerUnit * cfg.svgUnitsPerMm);
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
    !p.item.name.startsWith("その他") &&
    !p.forceTopRight &&
    coord.xScale(p.x) < cx &&
    angleInBand(normalizeAngle(p.item.midAngle ?? 0), 90, TOP_SEAM_ESCAPE_HALF_WIDTH_DEG);
  const candidates = placements
    .filter(isCandidate)
    .sort(
      (a, b) =>
        Math.abs((a.item.midAngle ?? 0) - 90) - Math.abs((b.item.midAngle ?? 0) - 90),
    );

  // 1 件のエスケープ実体: 右上へ reshape (+thorough 時は必要なら 1 行化) → 冠クリアランス nudge →
  // 既存エスケープとの重なりを上方向プッシュで分離。プッシュ間隔は thorough 時のみ最小限 (≈3px) に
  // 詰める (右上の縦余白は冠〜viewBox 上端の約 2 箱分しかなく、scaledMinGap だと 2 枚目が見切れる。
  // escape は全て leader 付きで帰属が自明なので詰めても判読性は落ちない)。
  const escapeOne = (c: Placement, oneLine: boolean): void => {
    reshapeToTopRightEscape(c, cfg);
    if (oneLine && c.lines.length >= 2) {
      c.lines = [c.lines.join(" ")];
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
      const snap = seamSnapshot(placements);
      escapeOne(c, false);
      const harm =
        countLeaderCrossings(placements, cfg, coord) >= beforeCross ||
        maxOverlap() > beforeOverlap + tol ||
        maxPieIntrusion() > beforePie + tol ||
        maxViewOverflow() > beforeView + tolPx ||
        countLeaderThroughLabels(placements, cfg, coord) > beforeThrough;
      if (harm) {
        seamRestore(snap);
      } else {
        adoptedAny = true;
      }
    }
  } else {
    // 累積プレフィックス探索 (emit 限定): 候補をシーム最寄り順に 1 枚ずつ「追加で」逃がし、各
    // プレフィックスの不具合ベクトルを記録して最良地点のスナップショットを採用する。greedy では
    // 「1 枚目で交差が一時的に増え、2 枚目を重ねて初めて 0 になる」谷を越えられない (例 page16:
    // アイルランド単独は through 2→0 だが cross 1→2 で却下、ケイマンを重ねると全て解消)。
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
    const boxOut = (p: Placement): number => boxViewOverflowOf(p, cfg, coord);
    const countClips = (): number => placements.filter((p) => boxOut(p) > 1).length;
    const countOobLeaders = (): number => oobLeaderCount(placements, cfg, coord);
    const vecOf = (): SeamVec => ({
      cross: countLeaderCrossings(placements, cfg, coord),
      through: countLeaderThroughLabels(placements, cfg, coord),
      inv: countAngularDiscordantPairs(placements, cfg, coord),
      clips: countClips(),
      oob: countOobLeaders(),
      ovl: maxOverlap(),
      pie: maxPieIntrusion(),
      view: maxViewOverflow(),
    });
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
        if (process.env.GRAPH2_DEBUG_REPAIR) {
          console.error(
            `[seamEscape${oneLineEscapes ? "/1line" : ""}] +"${c.item.name}": cross ${cur.cross}->${after.cross}, through ${cur.through}->${after.through}, ` +
              `inv ${cur.inv}->${after.inv}, clips ${cur.clips}->${after.clips}, oob ${cur.oob}->${after.oob}, ` +
              `view ${cur.view.toFixed(1)}->${after.view.toFixed(1)} (best ${betterVec(after, bestVec) ? "UPDATED" : "kept"})`,
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
    applyOutsideLeaderAngularOrder(placements, cfg, coord);
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
  const tol = 2 / (cfg.mmPerUnit * cfg.svgUnitsPerMm);
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

function repairResidualLeaderDefects(
  placements: Placement[],
  cfg: PieLayoutConfig,
  coord: Coord,
): void {
  const tol = 2 / (cfg.mmPerUnit * cfg.svgUnitsPerMm);
  const tolPx = 2;
  const pxUnit = 1 / cfg.pxPerUnit;

  const countLeaderPie = (): number => {
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
  };
  const maxOverlap = (): number => boxOverlapMax(placements, cfg);
  const maxViewOverflow = (): number => boxViewOverflowMax(placements, cfg, coord);

  const boxOutPx = (p: Placement): number => boxViewOverflowOf(p, cfg, coord);
  const countClips = (): number => placements.filter((p) => boxOutPx(p) > 1).length;
  const countOobLeaders = (): number => oobLeaderCount(placements, cfg, coord);

  interface Vec {
    crossPie: number;
    through: number;
    inv: number;
    clips: number;
    oob: number;
    ovl: number;
    view: number;
    boxPie: number;
  }
  // ラベル箱の円内侵入の最大深さ (logical)。verify の "label inside pie" に対応する非悪化ゲート。
  const maxBoxPieIntrusion = (): number => boxPieIntrusionMax(placements, cfg);

  const vecOf = (): Vec => ({
    crossPie: countLeaderCrossings(placements, cfg, coord) + countLeaderPie(),
    through: countLeaderThroughLabels(placements, cfg, coord),
    inv: countAngularDiscordantPairs(placements, cfg, coord),
    clips: countClips(),
    oob: countOobLeaders(),
    ovl: maxOverlap(),
    view: maxViewOverflow(),
    boxPie: maxBoxPieIntrusion(),
  });
  // 主目的は (交差+円貫通) → (箱貫通) → (箱の円内侵入) の辞書式改善。それ以外は全て非悪化。
  const better = (a: Vec, b: Vec): boolean =>
    ((a.crossPie < b.crossPie && a.through <= b.through && a.boxPie <= b.boxPie + tol) ||
      (a.crossPie === b.crossPie && a.through < b.through && a.boxPie <= b.boxPie + tol) ||
      (a.crossPie === b.crossPie && a.through === b.through && a.boxPie < b.boxPie - tol)) &&
    a.inv <= b.inv &&
    a.clips <= b.clips &&
    a.oob <= b.oob &&
    a.ovl <= b.ovl + tol &&
    a.view <= b.view + tolPx;

  for (let iter = 0; iter < 6; iter += 1) {
    const cur = vecOf();
    if (cur.crossPie + cur.through === 0 && cur.boxPie <= tol) return;

    // 不具合に関与する leader の index を決定的順序 (名前順) で列挙する。
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
      placements[a].item.name.localeCompare(placements[b].item.name, "ja"),
    );
    if (process.env.GRAPH2_DEBUG_REPAIR) {
      console.error(
        `[rebend:iter${iter}] cur={crossPie:${cur.crossPie}, through:${cur.through}, inv:${cur.inv}} involved=[${order.map((i) => placements[i].item.name).join(",")}]`,
      );
    }

    // p の bend を格子から選び直し、cur より良くなる候補があれば適用したまま true を返す。
    // 無ければ元の bend/フラグへ戻して false。 (単独手・複合手の両方から使う)
    const tryBendGridOn = (p: Placement): boolean => {
      const drawn2 = computeDrawnLeader(p, cfg, false);
      if (drawn2.skipLeader || drawn2.pathPoints.length < 2) return false;
      const a2 = drawn2.pathPoints[0];
      const e2 = drawn2.detectPathPoints[drawn2.detectPathPoints.length - 1];
      const tA = Math.atan2(a2.y, a2.x);
      const tE = Math.atan2(e2.y, e2.x);
      let dT = tE - tA;
      while (dT > Math.PI) dT -= 2 * Math.PI;
      while (dT < -Math.PI) dT += 2 * Math.PI;
      if (Math.abs(dT) < 0.05 || Math.abs(dT) > (150 * Math.PI) / 180) return false;
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
    };

    let improved = false;
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
        Math.abs(dTh) <= (150 * Math.PI) / 180;
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
            if (process.env.GRAPH2_DEBUG_REPAIR) {
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
          const clearance = 4 / (cfg.mmPerUnit * cfg.svgUnitsPerMm);
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
              tryBendGridOn(p);
              const myPath = realLeaderPaths(placements, cfg, coord)[i];
              if (myPath) {
                const allPaths = realLeaderPaths(placements, cfg, coord);
                for (let j = 0; j < placements.length; j += 1) {
                  if (j === i) continue;
                  const q = allPaths[j];
                  if (q && pathsCross(myPath, q) && !placements[j].insideSlice && !placements[j].forceTopRight) {
                    tryBendGridOn(placements[j]);
                  }
                }
              }
              v = vecOf();
              ok = better(v, cur);
            }
            if (process.env.GRAPH2_DEBUG_REPAIR) {
              console.error(
                `[pienudge] "${p.item.name}" dx=${((targetRight - lb.right) * cfg.pxPerUnit).toFixed(1)}px: crossPie ${cur.crossPie}->${v.crossPie}, through ${cur.through}->${v.through}, boxPie ${cur.boxPie.toFixed(3)}->${v.boxPie.toFixed(3)} => ${ok ? "ADOPT" : "REJECT"}`,
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
          const snapA = seamSnapshot(placements);
          reshapeToLeftRimHug(p, cfg, placementBox(p, cfg).top);
          const v = vecOf();
          const ok = better(v, cur);
          if (process.env.GRAPH2_DEBUG_REPAIR) {
            console.error(
              `[rehug] "${p.item.name}": crossPie ${cur.crossPie}->${v.crossPie}, through ${cur.through}->${v.through}, ` +
                `boxPie ${cur.boxPie.toFixed(3)}->${v.boxPie.toFixed(3)}, inv ${cur.inv}->${v.inv}, clips ${cur.clips}->${v.clips}, ` +
                `ovl ${cur.ovl.toFixed(3)}->${v.ovl.toFixed(3)}, view ${cur.view.toFixed(1)}->${v.view.toFixed(1)} => ${ok ? "ADOPT" : "REJECT"}`,
            );
          }
          if (ok) {
            adopted = true;
          } else {
            seamRestore(snapA);
          }
        }
      }
      if (adopted) {
        improved = true;
        break; // 不具合集合が変わったので外側 iter で再列挙する
      }
    }

    // 複合手: 交差対の footprint スワップ。bend 替え・nudge で直らない交差は、角度順が正順でも
    // 「上スライスのラベル枠が下スライスのアンカー上空を塞ぎ、その leader が相手アンカーの外側を
    // 横断する」密集構造で起きる (例 currency_many_small_10: カナダドル×豪ドル)。当事者 2 枚の
    // (x, y, baseline) を丸ごと交換すると両 leader が短い扇形へ組み替わり構造的に解ける。
    // 交差は ERROR・角度順逆転は WARN なので、この手に限り inv の悪化を許容する (他指標は非悪化)。
    if (!improved) {
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
        `${placements[m[0]].item.name} ${placements[m[1]].item.name}`.localeCompare(
          `${placements[n[0]].item.name} ${placements[n[1]].item.name}`,
          "ja",
        ),
      );
      // 交差 (ERROR) の解消を最優先し、through (WARN) への振替は「線不具合の総数が増えない」
      // 範囲で許す (交差 1 件 → through 1 件 への置換は純改善)。振替で生じた through は次 iter の
      // bend 替え (better() の through 厳密減クォーラム) が掃除を試みる。
      const swapBetter = (a: Vec, b: Vec): boolean =>
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
        const snapS = seamSnapshot(placements);
        [pa.x, pb.x] = [pb.x, pa.x];
        [pa.y, pb.y] = [pb.y, pa.y];
        const tb = pa.baseline;
        pa.baseline = pb.baseline;
        pb.baseline = tb;
        const v = vecOf();
        const ok = swapBetter(v, cur);
        if (process.env.GRAPH2_DEBUG_REPAIR) {
          console.error(
            `[crossswap] "${pa.item.name}"<->"${pb.item.name}": crossPie ${cur.crossPie}->${v.crossPie}, ` +
              `through ${cur.through}->${v.through}, inv ${cur.inv}->${v.inv}, clips ${cur.clips}->${v.clips}, ` +
              `ovl ${cur.ovl.toFixed(3)}->${v.ovl.toFixed(3)}, view ${cur.view.toFixed(1)}->${v.view.toFixed(1)} => ${ok ? "ADOPT" : "REJECT"}`,
          );
        }
        if (ok) {
          improved = true;
          break;
        }
        seamRestore(snapS);
      }
    }

    // 複合手: 左列の再積み上げ。bend 単独では直らない交差 (例 page16: escape で左上が空いたのに
    // 残った 2 枚が下のスロットに留まり、長い leader 同士がサブピクセル余裕で絡む) は、左列全体を
    // 角度順に上から詰め直すと leader が短い扇形になり構造的に解ける。canvas 上端起点と現在の
    // 列上端起点の 2 候補を試し、辞書式で厳密に改善する方だけ採用 (do-no-harm・全 revert)。
    if (!improved) {
      // 左列「全体」を対象にする (不具合の当事者だけ動かすと残りの箱と重なって却下される)。
      // 発火条件は「列の誰かが不具合に関与している」こと。
      const stack = placements.filter(
        (p) =>
          !p.insideSlice &&
          !p.forceTopRight &&
          p.x < 0 &&
          !p.item.name.startsWith("その他"),
      );
      const anyInvolved = stack.some((p) => [...involved].some((i) => placements[i] === p));
      if (stack.length >= 2 && anyInvolved) {
        const byAngle = [...stack].sort(
          (m, n) =>
            Math.sin(degToRad(n.item.midAngle ?? 0)) - Math.sin(degToRad(m.item.midAngle ?? 0)),
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
          const snap = seamSnapshot(placements);
          let y = top;
          for (const p of byAngle) {
            reshapeToLeftRimHug(p, cfg, y);
            if (p.x > rightCap) {
              p.x = rightCap;
              p.origTextX = p.x;
            }
            y -= placementExtent(p, cfg).height + cfg.scaledMinGap;
          }
          const v = vecOf();
          const ok = better(v, cur);
          if (process.env.GRAPH2_DEBUG_REPAIR) {
            console.error(
              `[restack-left] top=${top.toFixed(3)} stack=[${byAngle.map((p) => p.item.name).join(",")}]: ` +
                `crossPie ${cur.crossPie}->${v.crossPie}, through ${cur.through}->${v.through}, inv ${cur.inv}->${v.inv}, ` +
                `ovl ${cur.ovl.toFixed(3)}->${v.ovl.toFixed(3)}, view ${cur.view.toFixed(1)}->${v.view.toFixed(1)} => ${ok ? "ADOPT" : "REJECT"}`,
            );
          }
          if (ok) {
            improved = true;
            break;
          }
          seamRestore(snap);
        }
      }
    }
    if (!improved) return;
  }
}

/**
 * leftStackMode で「1 行に降格して viewBox 左端を見切れている」幅広左ラベルの LayoutItem を返す。
 * 最終配置 (nudge/condense/relax 適用済コピー) で判定するので、verify の見切れ判定と一致する。
 * 既に 2 行のラベル / 1 行で収まる短名 (preferOneLineCascade) / flip 済は対象外。
 */
function leftStackOverflowItems(
  result: Placement[],
  cfg: PieLayoutConfig,
): LayoutItem[] {
  const copy = result.map((p) => ({ ...p }));
  applyVisualViewBoxNudge(copy, cfg);
  applyFinalCondenseToFit(copy, cfg);
  relaxNameCondense(copy, cfg);
  const viewBoxLeft = -cfg.svgWidthPx / 2 / cfg.pxPerUnit;
  const tol = 1 / (cfg.svgUnitsPerMm * cfg.mmPerUnit + 1e-9); // ≈ 1 SVG px
  const out: { item: LayoutItem; over: number }[] = [];
  for (const p of copy) {
    if (p.insideSlice) continue;
    if (p.item.side !== "left") continue;
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
        it.side === "left" &&
        !it.flipToRight &&
        !it.flipToLeft &&
        !it.bottomCenterBelow &&
        topBandSonohokaZone(it) === null &&
        !it.name.startsWith("その他")
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
  let result = bestResult();
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
          guard &&
          (v.clips < best.clips || (v.clips === best.clips && v.total < best.total));
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
export async function renderPdfStylePieToSvg(
  rawItems: unknown,
  options: Partial<PieLayoutConfig> & { compactLabel?: boolean } = {},
): Promise<RenderResult> {
  const cfg = createPieLayoutConfig(options);
  const items: LayoutItem[] = normalizeInputItems(rawItems)
    .filter((item) => Number.isFinite(Number(item.value)) && Math.abs(Number(item.value)) > 0)
    .map((item) => ({
      name: item.name,
      value: Math.abs(Number(item.value)),
      signedValue: Number(item.value),
    }))
    .sort((a, b) => {
      const aOther = a.name.startsWith("その他");
      const bOther = b.name.startsWith("その他");
      if (aOther !== bOther) return aOther ? 1 : -1;
      return b.value - a.value;
    });
  if (items.length === 0) {
    // 上の filter で |value| > 0 のみ残るため、件数が残れば総和は必ず正。
    throw new Error("At least one item with a non-zero value is required.");
  }

  if (options.compactLabel === undefined) {
    runCompactCascade(items, cfg);
  }

  // 最終 layoutLabels (multi-slice 分岐で再利用)。pie 中心は常にキャンバス中央
  // (オフセットしない — createCoordinateSystem の対称ドメインで中央が保証される)。
  let finalLayout: LayoutResult | null = null;
  if (items.length > 1) {
    finalLayout = layoutLabels(items, cfg);
  }
  const coord = createCoordinateSystem(cfg);
  const { width, height, xScale, yScale } = coord;
  const colors = makeColors(items.length, cfg);
  const arcs = computeArcs(items, cfg);
  const totalValue = items.reduce((sum, item) => sum + Math.abs(Number(item.value)), 0);
  const percentOf = (value: number) =>
    totalValue > 0 ? (Math.abs(Number(value)) / totalValue) * 100 : 0;

  // ── 1. スライス本体の描画 ──
  const sliceGroups = arcs
    .map((arc, index) => {
      if (Math.abs(Number(arc.value)) === 0) return "";
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
      { anchor: "middle", baseline: "top" },
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

    // 視覚 viewBox はみ出し最終 nudge (採用配置に 1 回だけ適用)。
    applyVisualViewBoxNudge(textPlacements, cfg);
    // viewBox をはみ出す外側ラベルを「収まるまで長体」で縮める最終ガード (下限 0.7)。
    applyFinalCondenseToFit(textPlacements, cfg);
    // 長体ラベルをキャンバスに収まる範囲で原寸 (上限 1.0 = デフォルトの大きさ) へ向けて緩和し、
    // ラベルごとにギリギリ収まる最大サイズへ戻す。
    relaxNameCondense(textPlacements, cfg);

    // 最終段: 同一側で交差する外側 leader 対を縦に引き離して交差を解消する。viewBox nudge /
    // condense-to-fit の後 (= emit と同一の最終配置) に実行するので、ここで見た交差は verify が
    // 報告する交差と一致する。各手は do-no-harm (交差減・重なり非悪化・viewBox 内) で採用。
    applyOutsideLeaderAngularOrder(textPlacements, cfg, { xScale, yScale, width, height });

    // 9時線近傍で near-vertical に重なる左小スライス対 (例 イギリス/イタリア) を角度順に並べ直して
    // 左上の空きへわずかに逃がし、各 leader を分離した斜め線にする。do-no-harm (悪化したら revert)。
    escapeUpperLeftTinyLeaders(textPlacements, cfg, { xScale, yScale, width, height });

    // 12時シーム近傍の小スライスが左帯へ押し出されて near-horizontal leader が交差する場合、
    // 当該スライスを右上空白へ "up-and-over" で逃がして交差を解消する (do-no-harm)。
    // emit では thorough=true (累積プレフィックス探索 + 1 行化フォールバック) を使う。
    escapeTopBandSeamLeader(textPlacements, cfg, { xScale, yScale, width, height }, true);

    // leftStackMode 限定の最終手段: untangle で直せない幅広/混在行の左上逆転を、角度順 re-stack +
    // 長体圧縮で解消する (do-no-harm・悪化したら全 revert)。emit でのみ・スコアリングには干渉しない。
    if (diagnostics?.leftStackMode) {
      reorderLeftStackWithCondense(textPlacements, cfg, { xScale, yScale, width, height });
    }

    // 残余の leader 交差/円内貫通/箱貫通を bend 再配置で解消する最終安全網 (do-no-harm)。
    // finalizeForScoring と同位置・同条件で呼び、採点と emit の一致を保つ。
    repairResidualLeaderDefects(textPlacements, cfg, { xScale, yScale, width, height });

    // 円外ラベル box の円内侵入 (label inside pie) を、現在 y での動的 pie クランプで円外へ押し出す
    // 最終安全網 (do-no-harm)。cascade の nudge を静的 minTextX が引き戻す取りこぼし (例
    // stress_top_cluster_8 "F") を解消する。侵入の無いチャートは早期 return で無変更。
    enforceFinalPieClearance(textPlacements, cfg, { xScale, yScale, width, height });

    // 9時直近で長体下限でも見切れる幅広長名を、下left ドロップ + 斜めリーダーで収める最終手段
    // (do-no-harm)。名前 2 行分割より先に試し、収まれば split 不要。位置確定後に走るので最終配置を
    // 正しく評価する。密チャートで交差/反転を生む場合は revert。
    applyLowerLeftDropFallback(textPlacements, cfg, { xScale, yScale, width, height });

    // 下限長体 (0.7) でも viewBox を見切れる長カタカナ/長熟語を、名前 2 行分割で収める最終手段。
    // 全後段の **後** に実行するので位置は確定済 = ゲートが最終配置を正しく見る。採否は countDefects
    // (チャート全体: clips/crossings/pie/total) で判定し、clips が厳密に減り他が非悪化の時だけ採用 (do-no-harm)。
    // 部分的にしか収まらない分割 (例 債券先物(アメ/リカ)) は clips が減らず revert される。採点
    // (finalizeForScoring) には入れない: 候補選択を乱さず、finalScore は emit 後の同 placements から数えるため
    // scorer ↔ emit 整合は保たれる。
    applySplitNameFallback(textPlacements, cfg, { xScale, yScale, width, height });

    // emit 実配置 (最終化済 textPlacements) を内部スコアラで数え diagnostics に残す。後段は再適用
    // しない (countDefects はカウントのみ)。verify_consistency が emit SVG と突き合わせ、配置判断の
    // 基準 (countDefects) が実描画と一致し続けることをアサートする。
    if (diagnostics) {
      diagnostics.finalScore = countDefects(textPlacements, cfg, { xScale, yScale, width, height });
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
      return { placement, pathPoints, detectPathPoints, skipLeader, pixelBox };
    });

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
        const pixelPts = entry.detectPathPoints.map((p: { x: number; y: number }) => ({ x: xScale(p.x), y: yScale(p.y) }));
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
          lskip[idx] ? null : e.pathPoints.map((p: { x: number; y: number }) => ({ x: xScale(p.x), y: yScale(p.y) })),
        );
        resolveLeaderCrossings(pixPaths, prepared.map((e) => e.placement.item.name), lskip);
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
      const leader = skipLeader ? "" : leaderPath(xScale, yScale, pathPoints, cfg);
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
              rest:
                placement.lines.length >= 2 ? "" : ` ${placement.item.percentText ?? ""}`,
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
      const insideAttr = placement.insideSlice ? ` data-inside-slice="true"` : "";
      const lineCountAttr = ` data-line-count="${placement.lines.length >= 2 ? 2 : 1}"`;
      const scaleAttr = sx < 1 ? ` data-name-scale-x="${sx}"` : "";
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
    `<g id="slices">${sliceGroups.join("")}</g>`,
    `<g id="labels">${labelGroups.join("")}</g>`,
    `</svg>`,
  ].join("");

  return { svg, diagnostics: diagnostics!, config: cfg };
}
