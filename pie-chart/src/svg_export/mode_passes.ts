// =============================================================================
// svg_export/mode_passes.ts — モード特化の配置パス (左列 / top-band クラスタ / 右上逃がし)
// -----------------------------------------------------------------------------
// `Diagnostics` の配置モード (leftStackMode / twoLineLeftStackMode / topBandClusterMode)
// と右上逃がしに紐づくパスを 1 ファイルに集約する:
//   - 左列系   : 1 行縦積み (spread / gap-close / condense 再整列 / 接触級の広げ直し) と
//                全 2 行密ピッチ列 (`applyTwoLineLeftColumn`)
//   - top-band : 12時近傍クラスタの再スタック (`applyTopBandClusterReorder`) と
//                seam 逃がし (`escapeTopBandSeamLeader` 系)
//   - 右上逃がし: lifted ラベルのスタック整え (`stackTopRightLiftedLabels` /
//                `tidyTopRightEscapeeStack` 系)
// 呼び出し元は 2 系統: cascade 段 (`index.ts` の `runLabelCascade`) と emit 段
// (`emit_repair.ts` の `EMIT_REPAIR_PASSES` テーブル)。do-no-harm ゲートは emit_repair
// 側の共通基盤 (`emitDefectsWorsened` / `countVerifyIssuesDetailed` 等) を使う。
// =============================================================================

import {
  normalizeAngle,
  angleInBand,
  nudgeTextAwayFromPie,
  pieYAtX,
  placementBox,
  placementExtent,
  radialFraction,
  degToRad,
  isOtherCategory,
  boxOverlapAmount,
  pxToLogical,
} from '../svg_geom.js';
import { TOP_BAND_HALF_WIDTH_DEG, topBandSonohokaZone } from '../label_placement.js';
import type { PieLayoutConfig, LayoutItem, LayoutItemReady, Placement } from '../types.js';
import { clampPlacement, blockedInY } from './post_layout.js';
import {
  boxPieIntrusionMax,
  boxViewOverflowMax,
  countLeaderCrossings,
  leaderCrossingPairs,
  leaderThroughPairs,
} from './leader_geometry.js';
import type { Coord } from './leader_geometry.js';
// do-no-harm ゲート・採点は emit_repair.ts の共通基盤を使う (循環 import だが関数宣言のみ参照で安全)。
import {
  captureEmitDefectVec,
  countVerifyIssuesDetailed,
  emitDefectsWorsened,
  logicalYAtViewBoxYPx,
  tryMoveWithGuard,
  trySeamMutation,
  seamSnapshot,
  seamRestore,
  measureRepairVec,
  VIEW_OVERFLOW_CAP_PX,
} from './emit_repair.js';
import { upperLeftBendPoint } from '../svg_geom.js';
import {
  boxOverlapMax,
  computeDrawnLeader,
  countAngularDiscordantPairs,
  countLeaderThroughLabels,
  distPointToSegment,
} from './leader_geometry.js';
import {
  applyFinalCondenseToFit,
  applyVisualViewBoxNudge,
  relaxNameCondense,
} from './post_layout.js';
import { applyOutsideLeaderAngularOrder, countDefects } from './emit_repair.js';
import type { DefectCounts, SeamSnap } from './emit_repair.js';

// twoLineLeftStackMode の左列ラベルを円縁 (rim) からどれだけ外側へ離すかの mid-angle 放射係数。
// 1.0 で円ハグ (旧)。参考 PDF はラベルと円の間に ~0.3R の隙間を空け、リーダー線が長い斜め線として
// 明確に見える。anchor は rim のまま (この係数は box 位置のみに効く) なので、リーダーは rim→box の
// 長い斜め直線になる。円侵入は起きないため verify/スコアラへの影響はない。
const TWO_LINE_LEFT_OUT_FACTOR = 1.28;
// 12時シーム (midAngle≈90) 近傍に密集する小スライスを「右上へ逃がす」対象とみなす帯の半幅。
// escapeTopBandSeamLeader が使う (9時版 NINE_OCLOCK_ESCAPE と対になるトップバンド版)。
const TOP_SEAM_ESCAPE_HALF_WIDTH_DEG = 32;

// `restackLiftedIfOverlapping` の部分適用の刻み数。必要量の 1/N ずつ浅くしながら「円に当たらない
// 最大の降下量」を採る。冠直下は円の幅が急に広がるため、刻みを細かくしても得られる余地は僅か。
const RESTACK_DROP_STEPS = 8;

// leader 折れ線の幾何プリミティブ (`computeDrawnLeader` / `isRedundantUpperLeftSmallLeader` /
// `resolveLeaderCrossings` / `distPointToSegment`) と型 `Pt` / `Coord` は `./leader_geometry.js` へ分離した。
/** `leftStackMode` の左列とみなす placement (side=left・baseline=bottom・非 inside・x<0)。 */
export function isLeftStackMember(p: Placement): boolean {
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
export function applyTwoLineLeftColumn(placements: Placement[], cfg: PieLayoutConfig): void {
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
export function spreadLeftStackByAngle(
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
export function applyTopBandClusterReorder(
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
export function applyLeftStackGapClose(placements: Placement[], cfg: PieLayoutConfig): void {
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
export function leftStackOverflowItems(result: Placement[], cfg: PieLayoutConfig): LayoutItem[] {
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
