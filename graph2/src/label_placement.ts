// =============================================================================
// label_placement.ts — ラベル配置カスケードの form/draft 生成と引出線 SVG path
// -----------------------------------------------------------------------------
// 役割:
//   - 引出線 1 本ぶんの SVG 断片を組み立てる (leaderPath)
//   - 統一カスケード各 rank の配置候補 (form) と中間 draft を生成し、最終
//     Placement に組み立てる (finalizePlacement)
//
// アーキテクチャ:
//   - 純粋幾何計算 (屈曲点・bbox 推定・nudge) は svg_geom.ts に分離。
//   - 配置経路の選択 (rank ごとの優先順位カスケード) は svg_export/index.ts の
//     runLabelCascade が駆動し、本ファイルの公開 API (下記 3.) を順に試す。
//   - 各 draft ビルダは共通の PlacementDraft を返し、finalizePlacement が
//     nudge → textPlacement 返却を行う。
//   - SVG 全体アセンブリ・compact カスケード・viewBox 視覚 nudge は svg_export 側。
//
// ファイル内構成 (上から):
//   0. 内部型 (PlacementDraft)
//   1. constants (配置帯・dominant 閾値)
//   2. leader path / 共有 placement helpers
//   3. 統一カスケード — form / draft ビルダ / finalizePlacement:
//        computeInsideOptions / outsideFormForRank / buildInsideDraft /
//        buildOutsideRimDraft / buildOutsideLeaderDraft / finalizePlacement
// =============================================================================

import {
  normalizeAngle,
  angleInBand,
  degToRad,
  nudgeTextAwayFromEndpoint,
  nudgeTextAwayFromSegment,
  radialFraction,
  fitsInsideSliceExtent,
  scaledLabelWidthUnits,
  labelHeightUnits,
  textBoxBounds,
} from "./svg_geom.js";
import type { PieLayoutConfig, Scale, LayoutItemReady, Placement } from "./types.js";
import type { Point, InsideFit, Extent } from "./svg_geom.js";

// =============================================================================
// 0. 内部型 — draft (配置中間表現)
// =============================================================================
/**
 * カスケード各経路 (buildInsideDraft / buildOutsideRimDraft /
 * buildOutsideLeaderDraft) が返す中間 placement。finalizePlacement が受け取り、
 * nudge を適用してから最終 Placement (textPlacement) に組み立てる。最終
 * Placement とは別形状 (引出線端点・bend を保持する) であることに注意。
 */
interface PlacementDraft {
  fragments: string[];
  textX: number;
  textY: number;
  anchor: "start" | "middle" | "end";
  baseline: "top" | "bottom" | "middle";
  lineEndX: number;
  lineEndY: number;
  lineStart: Point;
  lineEnd: Point;
  allowSegmentNudge: boolean;
  pieClearance?: boolean;
  skipLeader?: boolean;
  insideSlice?: boolean;
  upperLeftHairpinCheck?: boolean;
  triadBottomCapY?: number;
  pieClearanceStrictViewBox?: boolean;
  dominantOutsideEdge?: boolean;
  /** 名前(2行=上行/1行=名前部分)への横圧縮率 (長体)。未指定/1 は原寸。 */
  nameScaleX?: number;
  /** 1 行レイアウトで名前部分のみ圧縮するか。 */
  condenseNamePortionOnly?: boolean;
  /** 上部「その他」を右上へ置いた draft。clampToAnchorSide 免除フラグへ伝播する。 */
  forceTopRight?: boolean;
}

// =============================================================================
// 1. constants — 配置ルーティングで使う角度帯 / 優勢度の閾値
// =============================================================================
// 12 時 / 6 時の「トップバンド」「ボトムバンド」幅。
// 本ファイルの帯判定に加え、svg_export 側の cascade probe / sorting でも
// 参照するため公開する。
export const TOP_BAND_HALF_WIDTH_DEG = 18;
export const BOTTOM_BAND_HALF_WIDTH_DEG = 18;

/**
 * 上部「その他」専用の左側拡張帯の半幅。svg_export の TOP_SEAM_ESCAPE_HALF_WIDTH_DEG と
 * 同値だが別概念 (シーム逃がし候補帯 vs その他真上配置帯) なので独立定数にする。
 * 帯: normalizeAngle(midAngle) ∈ (90+18, 90+32] = (108°, 122°]。コア帯 (90±18) のすぐ左に
 * 続く範囲で、ここのその他は右上逃がしを試さず常に真上垂直 center 配置にする
 * (帯外扱いだと汎用 rim 配置になり、左上が混雑するチャートで nudge/overlap 解消に
 * 左隅まで押し出される)。
 */
export const TOP_BAND_SONOHOKA_LEFT_EXT_HALF_WIDTH_DEG = 32;

/** 上部「その他」の帯ゾーン。core=12時バンド内 / leftExt=左拡張帯 / null=対象外。 */
export type TopBandSonohokaZone = "core" | "leftExt" | null;

/**
 * name が「その他」前方一致のラベルについて、midAngle がどの上部帯に入るかを返す。
 * svg_export 側 (cascadeWithSonohokaPick / angularStacks / untangleAngularOrderBySwap) と
 * 本ファイルの topBandSonohokaRight が共有する唯一の判定実装。
 */
export function topBandSonohokaZone(item: {
  name: string;
  midAngle?: number;
}): TopBandSonohokaZone {
  if (!item.name.startsWith("その他")) return null;
  const norm = normalizeAngle(item.midAngle ?? 0);
  if (angleInBand(norm, 90, TOP_BAND_HALF_WIDTH_DEG)) return "core";
  // 左拡張帯は wrap (0°/360°) を跨がないので素の比較で安全。
  if (
    norm > 90 + TOP_BAND_HALF_WIDTH_DEG &&
    norm <= 90 + TOP_BAND_SONOHOKA_LEFT_EXT_HALF_WIDTH_DEG
  ) {
    return "leftExt";
  }
  return null;
}

/** dominant slice の経路選択用 percent 閾値。≥ 80% → 真下中央 2 行 + leader なし */
export const DOMINANT_BELOW_CENTER_MIN_PCT = 80;
/**
 * dominant slice ≥ 50% で 80% 未満 → slice 中心角の外側に縁置き。
 * layout 側の overflow 予測 (hasDominantOutsideEdgeOverflow1Line) でも参照するため公開。
 */
export const DOMINANT_OUTSIDE_EDGE_MIN_PCT = 50;
/**
 * 円外 rim 配置 (buildOutsideRimDraft) の label 配置半径 (scaledLabelRadius 係数)。
 * スライス外縁に寄せるため小さめ。実際の円クリアランスは pieClearance クランプが
 * 角度・行数に応じて保証するので、ここは下限ではなく「狙いの半径」。
 */
const DOMINANT_OUTSIDE_LABEL_RADIUS_FACTOR = 1.0;
/**
 * 円外配置 (buildOutsideRimDraft / buildOutsideLeaderDraft) の anchor 切替閾値 (midAngle の cos)。
 * layout 側の overflow 予測でも左右どちらに延びるかを揃えるため公開。
 */
export const DOMINANT_OUTSIDE_ANCHOR_COS_THRESHOLD = 0.15;

// =============================================================================
// 2. leader path / L 字 helpers — 引出線 SVG 生成と共有 placement
// =============================================================================

/** 論理座標の点列を SVG path の M/L 命令列に変換 */
function pointPath(xScale: Scale, yScale: Scale, points: Point[]): string {
  return points
    .map((point, index) => `${index === 0 ? "M" : "L"}${xScale(point.x)},${yScale(point.y)}`)
    .join(" ");
}

/** 引出線 (細い線) 1 本ぶんの SVG 断片を返す */
export function leaderPath(
  xScale: Scale,
  yScale: Scale,
  points: Point[],
  cfg: PieLayoutConfig,
): string {
  return `<path d="${pointPath(xScale, yScale, points)}" fill="none" stroke="${cfg.lineColor}" stroke-width="${cfg.leaderStrokeUnits}" stroke-linecap="round" stroke-linejoin="round" />`;
}


// =============================================================================
// 3. 統一カスケード — form / draft ビルダ / finalizePlacement
// =============================================================================
// 優先順位カスケード (①〜⑨) の各候補を表す「form」と、その draft 生成・最終
// Placement 組立。draft ビルダ各々の後半 (bbox 上下限・pie クリアランス・
// Placement 組立) は form 非依存なので finalizePlacement として共有する。

/** カスケード 1 候補。rank=①〜⑨(⑨=leader=最終手段)。inside=wedge 内 / false=円外 rim。 */
export interface LabelForm {
  rank: number;
  lineCount: 1 | 2;
  nameScaleX: number;
  inside: boolean;
  name: string;
  percent: string;
  lines: string[];
  condenseNamePortionOnly: boolean;
  width: number; // 実描画幅 (論理単位, 名前長体反映済)
  height: number; // 実描画高 (論理単位)
}

/** ある inside rank で wedge 内に収まる form とその中心。収まらなければ null。 */
export interface InsideOption {
  form: LabelForm;
  fit: InsideFit;
}

function buildForm(
  item: LayoutItemReady,
  cfg: PieLayoutConfig,
  rank: number,
  lineCount: 1 | 2,
  nameScaleX: number,
  inside: boolean,
): LabelForm {
  const name = item.name;
  const percent = item.percentText ?? "";
  const lines = lineCount === 2 ? [name, percent] : [`${name} ${percent}`];
  return {
    rank,
    lineCount,
    nameScaleX,
    inside,
    name,
    percent,
    lines,
    condenseNamePortionOnly: lineCount === 1 && nameScaleX < 1,
    width: scaledLabelWidthUnits(name, percent, lineCount, nameScaleX, cfg),
    height: labelHeightUnits(lineCount, cfg),
  };
}

/**
 * inside rank {1,3,5,7} ごとの wedge 内フィット結果。
 *   1: 2 行原寸 / 3: 2 行長体(0.7→0.6) / 5: 1 行原寸 / 7: 1 行長体(0.7→0.6)
 * 各 rank は独立な幾何判定 (他ラベル非依存)。
 */
export function computeInsideOptions(
  item: LayoutItemReady,
  cfg: PieLayoutConfig,
): Record<number, InsideOption | null> {
  const empty = { 1: null, 3: null, 5: null, 7: null } as Record<number, InsideOption | null>;
  if (cfg.insideSliceEnabled === false) return empty;
  const midRad = degToRad(item.midAngle);
  const spanRad = ((item.percent ?? 0) / 100) * 2 * Math.PI;
  const steps = cfg.nameCondenseSteps;
  const tryForms = (rank: number, lineCount: 1 | 2, scales: number[]): InsideOption | null => {
    for (const sx of scales) {
      const form = buildForm(item, cfg, rank, lineCount, sx, true);
      const fit = fitsInsideSliceExtent(midRad, spanRad, form.width, form.height, cfg);
      if (fit.fits) return { form, fit };
    }
    return null;
  };
  return {
    1: tryForms(1, 2, [1]),
    3: tryForms(3, 2, steps),
    5: tryForms(5, 1, [1]),
    7: tryForms(7, 1, steps),
  };
}

/** 外側 rank {2,4,6,8(,9)} → form。長体段は nameCondenseSteps[0] を使う。 */
export function outsideFormForRank(
  item: LayoutItemReady,
  cfg: PieLayoutConfig,
  rank: number,
): LabelForm {
  const sx0 = cfg.nameCondenseSteps[0] ?? 0.7;
  if (rank === 2) return buildForm(item, cfg, 2, 2, 1, false);
  if (rank === 4) return buildForm(item, cfg, 4, 2, sx0, false);
  if (rank === 6) return buildForm(item, cfg, 6, 1, 1, false);
  return buildForm(item, cfg, rank, 1, sx0, false); // 8 / 9
}

/** inside 配置の draft (wedge 中心・leader なし)。 */
export function buildInsideDraft(form: LabelForm, fit: InsideFit): PlacementDraft {
  const cx = fit.centerX!;
  const cy = fit.centerY!;
  return {
    fragments: [],
    textX: cx,
    textY: cy,
    anchor: "middle",
    baseline: "middle",
    lineEndX: cx,
    lineEndY: cy,
    lineStart: { x: cx, y: cy },
    lineEnd: { x: cx, y: cy },
    allowSegmentNudge: false,
    skipLeader: true,
    insideSlice: true,
    nameScaleX: form.nameScaleX,
    condenseNamePortionOnly: form.condenseNamePortionOnly,
  };
}

/**
 * 上部「その他」ラベルの配置 draft を返す。
 *
 * - 第一優先 (topRightRejected=false): 右上へ水平 leader で逃がす。bend を anchorX に固定して
 *   bendFollowsEndpointY を成立させ、左上と同じ綺麗な L 字 (slice から縦に抜けて右へ折れる) を
 *   保つ。anchorX が僅かに負でも右へ置けるよう forceTopRight で clampToAnchorSide の中心跨ぎ
 *   引き戻しを免除する。
 * - 左 fallback (topRightRejected=true, cascadeWithSonohokaPick の left 試行 / left 採用時):
 *   slice 中心軸上で真上に立てる垂直一直線 leader + viewBox 上端寄り center 配置を返す。
 *   水平区間を持つ leader だと、その水平線が左帯のラベルの垂直 leader と直交して交差し得る。
 *   水平区間そのものを消すこの形なら、x 軸位置が左帯と離れて構造的に交差不能になる。
 * - 左拡張帯 (zone="leftExt", midAngle ∈ (108°,122°]): 右上逃がしは試さず常に左 fallback と
 *   同じ真上垂直 center 配置。汎用 rim 扱いだと左上混雑チャートで左隅へ押し出されるため。
 *
 * 帯外 (topBandSonohokaZone が null) や名前不一致なら null を返す。
 */
function topBandSonohokaRight(
  item: LayoutItemReady,
  cfg: PieLayoutConfig,
  form: LabelForm,
  opts: { skipLeader: boolean; allowSegmentNudge: boolean },
): PlacementDraft | null {
  const zone = topBandSonohokaZone(item);
  if (!zone) return null;
  const anchorX = item.anchorX;
  const anchorY = item.anchorY;
  if (zone === "leftExt" || item.topRightRejected) {
    // 左 fallback: 真上垂直 leader + viewBox 上端寄り center 配置
    const labelY = cfg.scaledYTop - radialFraction(cfg, 0.02, 0.2);
    return {
      fragments: [],
      textX: anchorX,
      textY: labelY,
      anchor: "middle",
      baseline: "top",
      lineEndX: anchorX,
      lineEndY: labelY,
      lineStart: { x: anchorX, y: anchorY },
      lineEnd: { x: anchorX, y: labelY },
      allowSegmentNudge: opts.allowSegmentNudge,
      skipLeader: opts.skipLeader,
      pieClearance: true,
      dominantOutsideEdge: true,
      nameScaleX: form.nameScaleX,
      condenseNamePortionOnly: form.condenseNamePortionOnly,
    };
  }
  return topRightLiftedRimDraft(item, cfg, form, opts);
}

/**
 * 「12時直右へ逃がす」3 経路 (topBandSonohokaRight 右パス / topBandSmallRight /
 * clusterTopBandBottomRight) で共有する、箱を **pie キャップより完全に上** へ持ち上げる
 * draft ビルダ。
 *
 * 旧実装は箱上端 (baseline=bottom の textY) を pieRadius + 小クリアランスに置いたが、箱下端
 * (= textY − 高さ) が円の y 域 (|y| < pieRadius) に入るため、後段 pie クリアランスクランプが
 * 「右側ラベルの下限 textX」を insidePieR まで押し上げ、ラベルが右へ大きく飛んで水平 leader が
 * チャート上部を横断していた (参考 PDF は短い縦/斜め leader)。
 *
 * 本ビルダは箱下端を pieRadius + クリアランスへ揃え (= 箱全体が円の上)、pieClampXLimits が null を
 * 返すようにして横押し出しを無効化する。labelX オフセットも控えめ (radialFraction(0.12,1.5)) にし、
 * 12時直右に短い leader で据える。箱上端が canvas 上端を越える場合だけ上端でクランプする。
 */
function topRightLiftedRimDraft(
  item: LayoutItemReady,
  cfg: PieLayoutConfig,
  form: LabelForm,
  opts: { skipLeader: boolean; allowSegmentNudge: boolean },
): PlacementDraft {
  const anchorX = item.anchorX;
  const labelX = Math.abs(anchorX) + radialFraction(cfg, 0.12, 1.5);
  // baseline=bottom では textY が箱上端。箱下端 (textY − form.height) を pieRadius + クリアランスへ
  // 揃えるには textY = pieRadius + クリアランス + form.height。canvas 上端は越えないようクランプ。
  const capClear = radialFraction(cfg, 0.012, 0.12);
  const labelY = Math.min(
    cfg.pieRadius + capClear + form.height,
    cfg.scaledYTop - cfg.canvasSafetyMargin,
  );
  return {
    fragments: [],
    textX: labelX,
    textY: labelY,
    anchor: "start",
    baseline: "bottom",
    lineEndX: labelX,
    lineEndY: labelY,
    lineStart: { x: anchorX, y: labelY },
    lineEnd: { x: labelX, y: labelY },
    allowSegmentNudge: opts.allowSegmentNudge,
    skipLeader: opts.skipLeader,
    pieClearance: true,
    dominantOutsideEdge: true,
    forceTopRight: true,
    nameScaleX: form.nameScaleX,
    condenseNamePortionOnly: form.condenseNamePortionOnly,
  };
}

/**
 * 12時直左の小スライス (top-band) を右上空白へ逃がす draft を返す。`topBandSmallRight` フラグ
 * (layout.ts markTopBandSmallRight が立てる) を持つ item のみ対象。配置座標は `topBandSonohokaRight`
 * の右パスと同一 (slice から縦に抜けて右へ折れる L 字 + anchor=start)。anchorX が僅かに負でも
 * 右側を維持するため `forceTopRight` で `clampToAnchorSide` の中心跨ぎ引き戻しを免除する。
 *
 * 用途: 上左に小 top-band スライスが 2 つ並んで混雑し、左帯に縦積みすると片方が長体化する時、
 * 12時に最も近い 1 件を右上の空白へ出して両ラベルとも原寸 2 行に収める。フラグが無ければ null。
 */
function topBandSmallRight(
  item: LayoutItemReady,
  cfg: PieLayoutConfig,
  form: LabelForm,
  opts: { skipLeader: boolean; allowSegmentNudge: boolean },
): PlacementDraft | null {
  if (!item.topBandSmallRight) return null;
  // 12時直右に短い leader で据える。箱を pie キャップより上へ持ち上げ pie 横押し出しを無効化する
  // (topRightLiftedRimDraft 共通実装)。
  return topRightLiftedRimDraft(item, cfg, form, opts);
}

/**
 * topBandClusterMode の「最下段」(12時 真近 mid 90°±5°) 構成員ラベルを、`topBandSonohokaRight`
 * と同じ右上 rim 配置で逃がす draft を返す。anchorX が僅かに負でも右側を維持するため
 * `forceTopRight` で `clampToAnchorSide` の中心跨ぎ引き戻しを免除する。条件外なら null。
 *
 * 用途: 12時 真近 (mid 90°±5°) のスライスは左帯の最下段に押し込むと leader が pie 上を
 * 大きく跨いで視覚的に長くなる。右半が空く dominant チャートで右上 rim を出口に使う。
 * `clusterTopBandBottom` は layout.ts で立つフラグ。
 */
function clusterTopBandBottomRight(
  item: LayoutItemReady,
  cfg: PieLayoutConfig,
  form: LabelForm,
  opts: { skipLeader: boolean; allowSegmentNudge: boolean },
): PlacementDraft | null {
  if (!item.clusterTopBandBottom) return null;
  // 12時直右へ逃がす。箱を pie キャップより上へ持ち上げ短い leader にする (topRightLiftedRimDraft 共通)。
  return topRightLiftedRimDraft(item, cfg, form, opts);
}

/**
 * bottomCenterBelow フラグ付き 6時直下スライスを pie 真下中央へ leaderless で据える draft。
 * 箱上端を pie 下端直下 (-(pieRadius+clearance)) に固定し anchor=middle / x=0 で真下中央へ。
 * 一般 rim (textY=sin*r≈-pieRadius・baseline=top) と違い text が円内へ食い込まない **押し下げ** Y を
 * 使う (= cascade の pie 侵入判定で下位 rank へ降格しない)。フラグ無しは null。
 */
function bottomCenterBelow(
  item: LayoutItemReady,
  cfg: PieLayoutConfig,
  form: LabelForm,
  opts: { skipLeader: boolean; allowSegmentNudge: boolean },
): PlacementDraft | null {
  if (!item.bottomCenterBelow) return null;
  const clearance = radialFraction(cfg, 0.012, 0.12);
  const textY = -(cfg.pieRadius + clearance); // baseline=top → 箱上端
  // pieClearance / dominantOutsideEdge は付けない: 箱は pie の **真下** に押し下げ済で X 方向の
  // 円クリアランスは不要 (pieClearance を立てると closestY が円外でも anchor=middle 箱を横へ
  // 叩き出す)。dominantOutsideEdge を立てると computeDrawnLeader がドリフト時に leader を復活
  // させてしまう。円との距離は runCascadeOnce の nudgeTextAwayFromPie (真下へ押下げ) が担保する。
  return {
    fragments: [],
    textX: 0,
    textY,
    anchor: "middle",
    baseline: "top",
    lineEndX: 0,
    lineEndY: textY,
    lineStart: { x: 0, y: textY },
    lineEnd: { x: 0, y: textY },
    allowSegmentNudge: opts.allowSegmentNudge,
    skipLeader: opts.skipLeader,
    nameScaleX: form.nameScaleX,
    condenseNamePortionOnly: form.condenseNamePortionOnly,
  };
}

/** 円外 rim 配置の draft (slice 中心角の外縁・leader なし)。dominant slice 外縁配置を全 rank へ一般化したもの。 */
export function buildOutsideRimDraft(
  item: LayoutItemReady,
  cfg: PieLayoutConfig,
  form: LabelForm,
): PlacementDraft {
  const bottomCenter = bottomCenterBelow(item, cfg, form, {
    skipLeader: true,
    allowSegmentNudge: false,
  });
  if (bottomCenter) return bottomCenter;
  const right = topBandSonohokaRight(item, cfg, form, {
    skipLeader: true,
    allowSegmentNudge: false,
  });
  if (right) return right;
  const clusterRight = clusterTopBandBottomRight(item, cfg, form, {
    skipLeader: true,
    allowSegmentNudge: false,
  });
  if (clusterRight) return clusterRight;
  const smallRight = topBandSmallRight(item, cfg, form, {
    skipLeader: true,
    allowSegmentNudge: false,
  });
  if (smallRight) return smallRight;
  const rad = degToRad(item.midAngle);
  // 密集側のラベルだけ半径を少し増やして円から離す (横方向に押し出し leader を延ばす)。
  const denseFactor = item.denseSideOutsidePush ? cfg.denseSideOutsideRadiusFactor : 1;
  const r = cfg.pieRadius * DOMINANT_OUTSIDE_LABEL_RADIUS_FACTOR * denseFactor;
  const textX = Math.cos(rad) * r;
  // 上左スタックが自然 rim で縦に重なるチャート (useStackRimY) では、layout 事前計算の
  // 縦分離済み Y を採用して 2 行原寸ランクでの overlap 失敗を防ぐ。横 (textX/anchor) は
  // 不変なので左方向への押し出しは起きない。それ以外は自然 rim Y。
  const textY =
    item.useStackRimY && Number.isFinite(item.upperLeftRenderY)
      ? item.upperLeftRenderY
      : Math.sin(rad) * r;
  const cosA = Math.cos(rad);
  const sinA = Math.sin(rad);
  let anchor: "start" | "middle" | "end";
  if (cosA > DOMINANT_OUTSIDE_ANCHOR_COS_THRESHOLD) anchor = "start";
  else if (cosA < -DOMINANT_OUTSIDE_ANCHOR_COS_THRESHOLD) anchor = "end";
  else anchor = "middle";
  const baseline: "bottom" | "top" = sinA > 0 ? "bottom" : "top";
  return {
    fragments: [],
    textX,
    textY,
    anchor,
    baseline,
    lineEndX: textX,
    lineEndY: textY,
    lineStart: { x: textX, y: textY },
    lineEnd: { x: textX, y: textY },
    allowSegmentNudge: false,
    skipLeader: true,
    pieClearance: true,
    dominantOutsideEdge: true,
    nameScaleX: form.nameScaleX,
    condenseNamePortionOnly: form.condenseNamePortionOnly,
  };
}

/**
 * 最終手段 (rank 9 = ⑨)。rim でも pie 侵入/重なりが解けないラベルを slice 中心角の
 * 外側リング (renderLabelRadius) に逃がし、slice 縁から放射状 leader を引く。
 */
export function buildOutsideLeaderDraft(
  item: LayoutItemReady,
  cfg: PieLayoutConfig,
  form: LabelForm,
): PlacementDraft {
  const right = topBandSonohokaRight(item, cfg, form, {
    skipLeader: false,
    allowSegmentNudge: true,
  });
  if (right) return right;
  const smallRight = topBandSmallRight(item, cfg, form, {
    skipLeader: false,
    allowSegmentNudge: true,
  });
  if (smallRight) return smallRight;
  const rad = degToRad(item.midAngle);
  const cosA = Math.cos(rad);
  const sinA = Math.sin(rad);
  const rLabel = cfg.renderLabelRadius;
  const labelX = cosA * rLabel;
  const labelY = sinA * rLabel;
  let anchor: "start" | "middle" | "end";
  if (cosA > DOMINANT_OUTSIDE_ANCHOR_COS_THRESHOLD) anchor = "start";
  else if (cosA < -DOMINANT_OUTSIDE_ANCHOR_COS_THRESHOLD) anchor = "end";
  else anchor = "middle";
  const baseline: "bottom" | "top" = sinA > 0 ? "bottom" : "top";
  return {
    fragments: [],
    textX: labelX,
    textY: labelY,
    anchor,
    baseline,
    lineEndX: labelX,
    lineEndY: labelY,
    lineStart: { x: labelX, y: labelY },
    lineEnd: { x: labelX, y: labelY },
    allowSegmentNudge: true,
    skipLeader: false,
    pieClearance: true,
    dominantOutsideEdge: true,
    nameScaleX: form.nameScaleX,
    condenseNamePortionOnly: form.condenseNamePortionOnly,
  };
}

/**
 * draft + 補足情報 (lines / measured / bbox 算定幅) から最終 Placement を組み立てる
 * **共通ヘルパ**。nudge 適用・bbox 上下限・pie クリアランス・viewBox 境界クランプを
 * 一手に引き受ける。現状 `finalizePlacement` から呼び出される。
 *
 * - `measuredForPlacement` は nudge と Placement.measured に使う実描画 measured。
 * - `bboxMeasured` は maxTextX/Y などの bbox 境界判定に使う幅・高さ。通常は
 *   measuredForPlacement と一致するが、独立に渡せるようにしてある。
 * - `formExtras` を渡した場合のみ Placement に長体率 (`nameScaleX` 等) と
 *   `forceTopRight` を載せる (cascade 経路のみ)。
 */
function clampAndBuildPlacement(input: {
  item: LayoutItemReady;
  cfg: PieLayoutConfig;
  draft: PlacementDraft;
  textX: number;
  textY: number;
  measuredForPlacement: Extent;
  bboxMeasured: Extent;
  lines: string[];
  formExtras?: { nameScaleX: number; condenseNamePortionOnly: boolean };
}): { textPlacement: Placement } {
  const { item, cfg, draft, measuredForPlacement, bboxMeasured, lines, formExtras } = input;
  const anchorX = item.anchorX;
  const anchorY = item.anchorY;
  const cornerGap = cfg.cornerGap;
  const { anchor, baseline, lineEndX, lineEndY, lineStart, lineEnd, allowSegmentNudge } = draft;
  let { textX, textY } = input;

  const skipNudgeForInside = Boolean(draft.insideSlice);
  if (!skipNudgeForInside) {
    const nudged = nudgeTextAwayFromEndpoint(
      textX,
      textY,
      anchor,
      baseline,
      lineEndX,
      lineEndY,
      measuredForPlacement,
      cfg,
    );
    textX = nudged.x;
    textY = nudged.y;
  }
  if (allowSegmentNudge && !skipNudgeForInside) {
    const segmentNudged = nudgeTextAwayFromSegment(
      textX,
      textY,
      anchor,
      baseline,
      lineStart,
      lineEnd,
      measuredForPlacement,
      cfg,
    );
    textX = segmentNudged.x;
    textY = segmentNudged.y;
  }

  const bendFollowsEndpointY =
    Math.abs(lineStart.x - anchorX) < 1e-9 && Math.abs(lineStart.y - lineEnd.y) < 1e-9;
  const bendFollowsEndpointX =
    Math.abs(lineStart.y - anchorY) < 1e-9 && Math.abs(lineStart.x - lineEnd.x) < 1e-9;
  const leaderMaxTextX =
    bendFollowsEndpointY && anchor === "end"
      ? anchorX + cornerGap - (lineEnd.x - textX)
      : undefined;
  const heightVerify = bboxMeasured.height;
  const widthVerify = bboxMeasured.width;
  const safety = cfg.canvasSafetyMargin;
  let maxTextY: number;
  let minTextY: number;
  if (baseline === "bottom") {
    maxTextY = cfg.canvasYlim[1] - safety;
    minTextY = cfg.canvasYlim[0] + heightVerify + safety;
  } else if (baseline === "top") {
    maxTextY = cfg.canvasYlim[1] - heightVerify - safety;
    minTextY = cfg.canvasYlim[0] + safety;
  } else {
    maxTextY = cfg.canvasYlim[1] - heightVerify / 2 - safety;
    minTextY = cfg.canvasYlim[0] + heightVerify / 2 + safety;
  }
  if (typeof draft.triadBottomCapY === "number") {
    maxTextY = Math.min(maxTextY, draft.triadBottomCapY);
  }
  let viewBoxMaxTextX: number;
  let viewBoxMinTextX: number;
  if (anchor === "start") {
    viewBoxMaxTextX = cfg.canvasXlim[1] - widthVerify - safety;
    viewBoxMinTextX = cfg.canvasXlim[0] + safety;
  } else if (anchor === "end") {
    viewBoxMaxTextX = cfg.canvasXlim[1] - safety;
    viewBoxMinTextX = cfg.canvasXlim[0] + widthVerify + safety;
  } else {
    viewBoxMaxTextX = cfg.canvasXlim[1] - widthVerify / 2 - safety;
    viewBoxMinTextX = cfg.canvasXlim[0] + widthVerify / 2 + safety;
  }
  let pieMinTextX: number | undefined;
  let pieMaxTextX: number | undefined;
  if (draft.pieClearance) {
    const clearanceBox = textBoxBounds(
      textX,
      textY,
      { width: 0, height: heightVerify },
      anchor,
      baseline,
    );
    const bboxYMin = clearanceBox.bottom;
    const bboxYMax = clearanceBox.top;
    let closestY: number;
    if (bboxYMin <= 0 && bboxYMax >= 0) closestY = 0;
    else closestY = Math.abs(bboxYMin) < Math.abs(bboxYMax) ? bboxYMin : bboxYMax;
    const pieClearanceLogical = Math.max(
      cfg.pieLabelClearance,
      radialFraction(cfg, 0.012, 0.12),
    );
    const insidePieR = Math.sqrt(
      Math.max(0, cfg.pieRadius * cfg.pieRadius - closestY * closestY),
    );
    pieMinTextX = insidePieR + pieClearanceLogical;
    pieMaxTextX = -(insidePieR + pieClearanceLogical);
    if (anchor === "middle") {
      pieMinTextX += widthVerify / 2;
      pieMaxTextX -= widthVerify / 2;
    } else if (anchor === "end") {
      pieMinTextX += widthVerify;
    } else {
      pieMaxTextX -= widthVerify;
    }
  }
  let effectiveMaxTextX: number | undefined =
    typeof leaderMaxTextX === "number"
      ? Math.min(leaderMaxTextX, viewBoxMaxTextX)
      : viewBoxMaxTextX;
  let effectiveMinTextX: number | undefined = viewBoxMinTextX;
  if (item.forceHorizontalLowerLeftDrop && anchor === "end") {
    effectiveMinTextX = undefined;
  }
  if (draft.pieClearance) {
    const strictViewBox = Boolean(draft.pieClearanceStrictViewBox);
    if (textX >= 0) {
      if (pieMinTextX! > effectiveMaxTextX! && !strictViewBox) {
        effectiveMaxTextX = undefined;
      }
      effectiveMinTextX = Math.max(effectiveMinTextX!, pieMinTextX!);
    } else {
      if (pieMaxTextX! < effectiveMinTextX! && !strictViewBox) {
        effectiveMinTextX = undefined;
      }
      effectiveMaxTextX =
        typeof effectiveMaxTextX === "number"
          ? Math.min(effectiveMaxTextX, pieMaxTextX!)
          : pieMaxTextX;
    }
  }
  const maxTextX = effectiveMaxTextX;
  const minTextX =
    typeof effectiveMinTextX !== "number"
      ? undefined
      : typeof maxTextX !== "number" || effectiveMinTextX <= maxTextX
        ? effectiveMinTextX
        : undefined;
  const placement: Placement = {
    x: textX,
    y: textY,
    anchor,
    baseline,
    lines,
    item,
    measured: measuredForPlacement,
    leaderAnchor: { x: anchorX, y: anchorY },
    leaderBend: { x: lineStart.x, y: lineStart.y },
    leaderEndpoint: { x: lineEnd.x, y: lineEnd.y },
    leaderBendFollowsEndpointY: bendFollowsEndpointY,
    leaderBendFollowsEndpointX: bendFollowsEndpointX,
    maxTextX,
    minTextX,
    maxTextY,
    minTextY,
    origTextX: textX,
    origTextY: textY,
    upperLeftHairpinCheck: Boolean(draft.upperLeftHairpinCheck),
    skipLeader: Boolean(draft.skipLeader),
    insideSlice: Boolean(draft.insideSlice),
    dominantOutsideEdge: Boolean(draft.dominantOutsideEdge),
    pieClearance: Boolean(draft.pieClearance),
  };
  if (formExtras) {
    placement.nameScaleX = formExtras.nameScaleX;
    placement.condenseNamePortionOnly = formExtras.condenseNamePortionOnly;
    placement.forceTopRight = Boolean(draft.forceTopRight);
  }
  return { textPlacement: placement };
}

/**
 * draft + form から最終 Placement を組み立てる cascade 用の薄いラッパ。実体は
 * `clampAndBuildPlacement` に集約。form の `width/height` を nudge にも bbox にも使う。
 */
export function finalizePlacement(
  item: LayoutItemReady,
  cfg: PieLayoutConfig,
  draft: PlacementDraft,
  form: LabelForm,
): { textPlacement: Placement } {
  const measured: Extent = { width: form.width, height: form.height };
  return clampAndBuildPlacement({
    item,
    cfg,
    draft,
    textX: draft.textX,
    textY: draft.textY,
    measuredForPlacement: measured,
    bboxMeasured: measured,
    lines: form.lines,
    formExtras: {
      nameScaleX: form.nameScaleX,
      condenseNamePortionOnly: form.condenseNamePortionOnly,
    },
  });
}
