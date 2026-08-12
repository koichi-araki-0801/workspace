// =============================================================================
// svg_export/emit_repair.ts — emit 修復パス列とその基盤 (採点・計測・do-no-harm ゲート)
// -----------------------------------------------------------------------------
// 位置確定後の placements に 1 回ずつ適用する最終修復パス群 (`EMIT_REPAIR_PASSES`) と、
// その採否を支える共通基盤を 1 ファイルに集約する:
//   - 採点: `countDefects` / `countVerifyIssues(Detailed)` / `finalizeForScoring`
//     (emit と同一の後段列を適用してから数える = scorer ↔ emit の一致保証)
//   - 計測/ゲート: `EmitDefectVec` / `DefectGate` / `HardDefects` / `RepairVec` 系と
//     seam snapshot (`PLACEMENT_SEAM_POLICY`)。パスの do-no-harm 判定はここへ集約
//   - 汎用修復パス: leader 交差ほどき・角度順整列・列 overlap 緩和・bend grid 残欠修復 等
// モード特化パス (左列/top-band/右上逃がし) は `pipeline.ts` 側にあり、`EMIT_REPAIR_PASSES`
// テーブルが関数参照で束ねる。テーブル順は emit_passes.test が固定する (順序依存)。
// =============================================================================

import {
  normalizeAngle,
  angleInBand,
  estimateVerifyTextExtent,
  nudgeTextAwayFromPie,
  pieYAtX,
  placementBox,
  placementExtent,
  scaledLabelWidthUnits,
  labelHeightUnits,
  leaderCrossesBox,
  degToRad,
  upperLeftBendPoint,
  isOtherCategory,
  boxOverlapAmount,
  pxToLogical,
} from '../layout/geometry.js';
import type { BBox } from '../layout/geometry.js';
import type { PieLayoutConfig, Diagnostics, Placement } from '../types.js';
import {
  resolveLabelOverlaps,
  clampPlacement,
  runCompactCascade,
  applyVisualViewBoxNudge,
  applyFinalCondenseToFit,
  relaxNameCondense,
  blockedInY,
} from './post_layout.js';
import {
  ALWAYS_DRAW_OUTSIDE_LEADERS,
  computeDrawnLeader,
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
} from './leader_geometry.js';
import type { Pt, Coord } from './leader_geometry.js';
import { radialFraction, pieClearanceWithinViewBox } from '../layout/geometry.js';
import { topBandSonohokaZone } from '../layout/placement.js';
import { FINAL_CONDENSE_MIN_SCALE } from './post_layout.js';
import { LEADER_MAX_ANGULAR_DIFF_RAD } from './leader_geometry.js';
// モード特化パス・fallback は pipeline.ts 側 (関数宣言 hoisting により循環 import でも安全)。
import {
  alignLeftStackToAnchors,
  applyLeftStackClusterEvenSpread,
  escapeTopBandSeamLeader,
  relieveLeftStackSpacing,
  reorderLeftStackWithCondense,
  reorderTopBandLeftClusterByAngle,
  reshapeToLeftRimHug,
  separateLeftColumnByHeight,
  stackTopRightLiftedLabels,
  tidyTopRightEscapeeStack,
} from './mode_passes.js';
// fallback 変形 (2 行化・declip・左下ドロップ) は pipeline.ts 側。
import {
  applyLowerLeftDropFallback,
  applyTwoLineNameFallback,
  applyVerticalDeclipFallback,
} from './pipeline.js';

// 9時線 (midAngle≈180) を挟んで縦に重なる左小スライスを「左上へ逃がす」対象とみなす帯の半幅。
// イギリス(≈189.5°)/イタリア(≈175.2°) の様に 9時線近傍で near-vertical leader が重なる対を拾う。
const NINE_OCLOCK_ESCAPE_HALF_WIDTH_DEG = 30;

export interface DefectCounts {
  clips: number;
  crossings: number;
  pie: number;
  total: number;
}

/**
 * verify と同基準 (ALWAYS_DRAW: leader を抑制せず実描画) で最終不具合数を数える。chartConflicts は
 * 交差 leader を skipLeader 抑制して数えないため、ALWAYS_DRAW 描画で実際に出る交差を取りこぼす
 * (= spread が直す交差を off 側で 0 と誤評価する)。spread 採否は実描画基準で比較する必要があるので
 * 専用に数える。コピーを実 render と同じ後段 (nudge/condense/relax/交差引き離し/9時逃がし) で
 * 最終化してから、交差・円内貫通・viewBox 見切れ・box 重なりを数える。off/on を同関数で比較する。
 */
export function countVerifyIssues(
  placements: Placement[],
  cfg: PieLayoutConfig,
  coord: Coord,
  leftStackMode = false,
): number {
  return countVerifyIssuesDetailed(placements, cfg, coord, leftStackMode).total;
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
export function finalizeForScoring(
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
export function countDefects(
  finalized: Placement[],
  cfg: PieLayoutConfig,
  coord: Coord,
): DefectCounts {
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
export function countVerifyIssuesDetailed(
  placements: Placement[],
  cfg: PieLayoutConfig,
  coord: Coord,
  leftStackMode = false,
): DefectCounts {
  return countDefects(finalizeForScoring(placements, cfg, coord, leftStackMode), cfg, coord);
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
export function captureEmitDefectVec(
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
export function emitDefectsWorsened(
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
export function logicalYAtViewBoxYPx(coord: Coord, yPx: number): number {
  const yA = coord.yScale(0);
  const yB = yA - coord.yScale(1); // 1 論理単位あたりの px (y 下向き)
  return (yA - yPx) / yB;
}

// leader メトリクス層 (pathsCross / realLeaderPaths / countLeaderCrossings /
// countLeaderThroughLabels / box*Max / projectBoxesToPixels / oobLeaderCount / angularStacks /
// countAngularDiscordantPairs) は `leader_geometry.ts` 側。

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
export function applyOutsideLeaderAngularOrder(
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
export const VIEW_OVERFLOW_CAP_PX = 24;

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
 * placement の実描画「行」sub-box 列 (論理単位・y-up)。union box (`placementBox`) の縦帯を行数で
 * 等分し (`labelHeightUnits` は行数に線形なので上端から 1 行分ずつ切れば正確)、各行の実幅を anchor に
 * 合わせて水平配置する。名前行のみ長体 (`nameScaleX`) を反映し、% 行 (および `nameSplit` の下行) は
 * 原寸 (`placementExtent` と同じ規約)。1 行ラベルは行 = union box なので `[placementBox(p)]` を返す。
 *
 * なぜ必要か: union box は 2 行ラベルの短い % 行の脇に、実描画 ink の無い「空隅」を含む。pie 侵入や
 * 隣接重なりを union box で測るとこの空隅が偽の干渉を生み、まだ原寸へ戻せる長体が下限に固定される
 * (例 `asset_domestic_equity_pdf` の「国内株式先物」)。実 ink の行 sub-box で測ることで、その偽陽性
 * だけを除きつつ ink の不変条件は保つ。
 */
function placementLineBoxes(p: Placement, cfg: PieLayoutConfig): BBox[] {
  const box = placementBox(p, cfg);
  if (p.lines.length < 2) return [box];
  const sx = p.nameScaleX ?? 1;
  // nameSplit は lines = [名前前半(長体), 名前後半+%(原寸)]、通常 2 行は [名前(長体), %(原寸)]。
  const rows: Array<{ text: string; sx: number }> = p.nameSplit
    ? [
        { text: p.lines[0], sx },
        { text: p.lines[1], sx: 1 },
      ]
    : [
        { text: p.item.name, sx },
        { text: p.item.percentText ?? '', sx: 1 },
      ];
  const rowH = labelHeightUnits(1, cfg);
  return rows.map((row, i) => {
    const w = scaledLabelWidthUnits(row.text, '', 2, row.sx, cfg);
    let left: number;
    let right: number;
    if (p.anchor === 'start') {
      left = p.x;
      right = p.x + w;
    } else if (p.anchor === 'end') {
      left = p.x - w;
      right = p.x;
    } else {
      left = p.x - w / 2;
      right = p.x + w / 2;
    }
    // 上端 (box.top) から 1 行分ずつ下へ (y-up なので top が大きい側)。
    const top = box.top - i * rowH;
    return { left, right, top, bottom: top - rowH };
  });
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
 *
 * pie 侵入 (b) と隣接重なり (c) のゲートは union box ではなく実描画の行 sub-box (`placementLineBoxes`)
 * で測る。union box は 2 行ラベルの短い % 行の脇に ink の無い「空隅」を含み、これを干渉と誤判定すると
 * まだ戻せる長体が下限に固定されるため (例 `asset_domestic_equity_pdf` の「国内株式先物」が 0.7 に
 * 取り残される)。行 ink はクリアランス (`pieRadius + pieClearance`) と実 ink 横交差の非増加を維持し、
 * union box は verify/countDefects の実カウント境界 (pie は `bboxIntrudesPie` の pieRadius−2px、重なりは
 * countDefects の ox>0 && oy≥6px と verify overlaps の両軸>2px) を新規に割らせない。1 行ラベルは
 * 行 = union box なので判定は従来と数学的に同一で、変化は多行 + 長体ラベルに限定される。
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
      const beforeLineBoxes = placementLineBoxes(p, cfg);
      p.nameScaleX = Math.min(1, Math.round((cur + STEP) * 1000) / 1000);
      const box = placementBox(p, cfg);
      // (a) このラベルの見切れを開始時から増やさない。収まっていれば収まったまま、既に見切れる真の
      //     クリップ floor ラベルは広げると悪化するので revert = floor 据え置き。
      let ok = hardClip(box) <= (initialClip.get(p) ?? 0) + 1e-9;
      // (b) pie 非侵入: 実描画 ink (行 sub-box) は狙いクリアランス (pieRadius + pieClearance) を維持し、
      //     union box は verify の label-inside-pie 境界 (pieRadius − 2px = `bboxIntrudesPie` tolerance と
      //     同境界, verify/svg.ts) を割らない。2 行ラベルの「% 短行脇の空隅」だけがクリアランス帯へ入れる
      //     (ink は従来どおり外)。1 行ラベルは行 = union box なので単純判定 (d ≥ pieRadius + clearance) と等価。
      if (ok) {
        const d = distToPie(box);
        const linesClearPie = placementLineBoxes(p, cfg).every(
          (lb) => distToPie(lb) >= cfg.pieRadius + pieClearance - 1e-9,
        );
        ok = (linesClearPie && d >= cfg.pieRadius - tol - 1e-9) || d >= beforePieDist - 1e-9;
      }
      // (c) 他ラベルとの重なり非悪化 — 2 層で判定する:
      //   (c1) 実描画の行 sub-box 対で、縦重なりする行対の横交差を増やさない (union の空隅による偽陽性を
      //        除去。実 ink の重なり増はこれまで通り常に block)。sx は名前行の幅だけを変えるので、行の
      //        縦位置と % 行幅は不変 = 行対は index 対応で before/after を比較できる。
      //   (c2) union box で、countDefects が数える対 (ox>0 && oy≥6px) と verify overlaps が flag する対
      //        (両軸 >2px) を「新規に (before で偽 → after で真)」作らない (既に数えられている対の交差増は
      //        件数不変なので許す)。
      if (ok) {
        const afterLineBoxes = placementLineBoxes(p, cfg);
        const cnt6 = pxToLogical(cfg, 6);
        for (const q of placements) {
          if (q === p) continue;
          const b = placementBox(q, cfg);
          const qLines = placementLineBoxes(q, cfg);
          // (c1) 行 sub-box 対の実 ink 横交差非増加。
          let c1ok = true;
          for (let i = 0; i < afterLineBoxes.length && c1ok; i += 1) {
            const la = afterLineBoxes[i];
            const lbBefore = beforeLineBoxes[i];
            for (const lq of qLines) {
              const oy = Math.min(la.top, lq.top) - Math.max(la.bottom, lq.bottom);
              if (oy <= 0) continue;
              const oxAfter = Math.min(la.right, lq.right) - Math.max(la.left, lq.left);
              const oxBefore =
                Math.min(lbBefore.right, lq.right) - Math.max(lbBefore.left, lq.left);
              if (oxAfter > Math.max(oxBefore, 0) + 1e-9) {
                c1ok = false;
                break;
              }
            }
          }
          // (c2) union box: 可算/flag 対を新規に作らない (oy は sx で不変なので ox のみで遷移する)。
          const oyU = Math.min(box.top, b.top) - Math.max(box.bottom, b.bottom);
          const oxAfterU = Math.min(box.right, b.right) - Math.max(box.left, b.left);
          const oxBeforeU = Math.min(beforeBox.right, b.right) - Math.max(beforeBox.left, b.left);
          const countNew = !(oxBeforeU > 0 && oyU >= cnt6) && oxAfterU > 0 && oyU >= cnt6;
          const verifyNew = !(oxBeforeU > tol && oyU > tol) && oxAfterU > tol && oyU > tol;
          if (!c1ok || countNew || verifyNew) {
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
    // pie 側キャップが早く頭打ちになり、下限 (`pieLabelClearanceMin`) なら解けた長体が残る。
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
        p.maxTextX = undefined; // 既存の右寄せ上限を外す (pie キャップは上の shift 計算で担保済み)
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
export function placementPixelRect(p: Placement, cfg: PieLayoutConfig, coord: Coord): PixRect {
  const lb = placementBox(p, cfg);
  return {
    left: Math.min(coord.xScale(lb.left), coord.xScale(lb.right)),
    right: Math.max(coord.xScale(lb.left), coord.xScale(lb.right)),
    top: Math.min(coord.yScale(lb.top), coord.yScale(lb.bottom)),
    bottom: Math.max(coord.yScale(lb.top), coord.yScale(lb.bottom)),
  };
}

/** non-clip/crossing/pie の純粋な box 重なり件数 (`countDefects` の分解)。 */
export function overlapsOf(d: DefectCounts): number {
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
export function measureDefectGate(
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
export function gateNotWorseExceptClips(after: DefectGate, before: DefectGate): boolean {
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
  sideCenterLeader: 'static', // `applyLeftStackClusterEvenSpread` (seam 系より後段) のみ設定・revert する
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
export function trySeamMutation(
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
export function tryMoveWithGuard(
  target: Placement,
  mutate: () => void,
  keep: () => boolean,
): boolean {
  const snapX = target.x;
  const snapY = target.y;
  mutate();
  if (keep()) return true;
  target.x = snapX;
  target.y = snapY;
  return false;
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
export function measureRepairVec(
  placements: Placement[],
  cfg: PieLayoutConfig,
  coord: Coord,
): RepairVec {
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
export function enforceFinalPieClearance(
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
/** base に無い要素が cand に 1 つでもあれば true (合計据え置きの局所入替を検出する)。 */
export function hasNewPair(cand: Set<string>, base: Set<string>): boolean {
  for (const k of cand) if (!base.has(k)) return true;
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

export function repairResidualLeaderDefects(
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

/** `EMIT_REPAIR_PASSES` の 1 エントリが実行する修復パス本体。 */
type EmitPassFn = (placements: Placement[], cfg: PieLayoutConfig, view: Coord) => void;

interface EmitRepairPass {
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
  /**
   * true = 最終 emit だけで走り、候補採点コンテキスト (`applyEmitRepairPasses` の
   * context='candidateScoring'、`upperEscapeScore` 等) では走らない。座標を大きく最終確定する
   * パスを候補採点に混ぜると、escape 候補の採点が「確定パスで動いた後の姿」で歪み、escape 数の
   * 選択自体が変わる (実測: currency_usd_heavy_9 の香港ドルが top-right 逃がしを失い左列へ落ちた)。
   */
  finalOnly?: boolean;
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

  // leftStackMode の左列が接触級に詰まるとき、各ラベルを自スライスの rim 高さへ寄せつつ最小間隔を
  // 確保し、mid-angle 放射方向へ円から離す (`applyLeftStackGapClose` の広げる版)。
  // x/長体率の確定後・右上仕上げの前に置く。
  {
    name: 'alignLeftStackToAnchors',
    when: (d) => d?.leftStackMode === true,
    run: alignLeftStackToAnchors,
  },

  // 最終仕上げ: 右上 escapee スタックの整え — 押し下げられた「その他」の pie キャップ復帰 (縦) と
  // escapee の書き出し x の「その他」揃え (横)。座標を動かす最後のパスとして末尾に置く — leader は
  // 移動後 box から再計算され追従する (do-no-harm)。
  { name: 'tidyTopRightEscapeeStack', run: tidyTopRightEscapeeStack },

  // leftStackMode: 先頭の小スライス密集クラスタを canvas 上部の密ピッチへ整え、直下の大スライス群を
  // 下方向へ分離する (詳細は関数 doc comment)。座標を最終確定するため emit 列の末尾に置く
  // (cascade 段に置くと後段パスが座標を上書きして washout する実測あり)。finalOnly: 候補採点へ
  // 混ぜると escape 候補選択が歪む (フィールドの doc comment 参照)。
  {
    name: 'applyLeftStackClusterEvenSpread',
    when: (d) => d?.leftStackMode === true,
    finalOnly: true,
    run: applyLeftStackClusterEvenSpread,
  },
];

/**
 * `EMIT_REPAIR_PASSES` を順に適用する。view は emit と同一座標系 (実 viewBox 基準)。
 * context='candidateScoring' は候補採点 (`upperEscapeScore` 等) からの呼び出しで、`finalOnly`
 * パスをスキップする (最終確定パスを採点へ混ぜない — `EmitRepairPass.finalOnly` 参照)。
 * デバッグ支援 (どちらも測定は純粋読み取りで出力 byte に影響しない):
 * - `PIE_CHART_DEBUG_REPAIR=1` … パスごとの `RepairVec` 差分を stderr へ出す (無変化パスは無音)。
 * - `PIE_CHART_STOP_AFTER_PASS=<name>` … 指定パスの直後で打ち切る (回帰の犯人パスを二分探索する用)。
 */
export function applyEmitRepairPasses(
  textPlacements: Placement[],
  cfg: PieLayoutConfig,
  view: Coord,
  diagnostics: Diagnostics | null,
  context: 'emit' | 'candidateScoring' = 'emit',
): void {
  const debug = Boolean(process.env.PIE_CHART_DEBUG_REPAIR);
  for (const pass of EMIT_REPAIR_PASSES) {
    if (pass.stage === 'scoring') continue;
    if (pass.finalOnly && context === 'candidateScoring') continue;
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
