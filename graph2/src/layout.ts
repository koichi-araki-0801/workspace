// =============================================================================
// layout.ts — 円グラフのラベル配置(論理座標上での配置決定)
// -----------------------------------------------------------------------------
// ラベルを最終的にどの (x, y) に置くかを決める。SVG 文字列生成や引出線描画は
// svg_export 側の責務。座標は論理単位 (pieRadius = 1.0)。
//
// カスケード:
//   1. buildProfiles で分類タグ付け
//   2. runDiagnostics で modeTags を計算
//   3. 左右に分け、resolveSidePositions で縦方向の重なりを解消
//   4. 上部過密時は flipUpperLeftStackToRight、6 時方向の小スライスは
//      applyBottomSpecial を適用
//   5. assignUpperLeftRenderY で描画用 Y を別計算 (leftStackMode 時は左側非 flip
//      item に preferOneLineCascade を立て、cascade を rank 5/6 起点に振る)
//   6. placeX で X を確定
//
// ファイル内構成:
//   1. profiles — buildProfiles / classifySide / estimateTextLines /
//                 calcMidAngles / buildCandidates
//   2. diagnostics — collectSliceCounts / deriveModeTags / runDiagnostics
//   3. resolve (vertical) — baseGap / pairGap / resolveSidePositions /
//                            applyBottomSpecial
//   4. flip helpers — upperLeftMinRiseBase / upperLeftStackGap /
//                     estimateUpperLeftStackHeight / flipUpperLeftStackToRight /
//                     applyFlipToRight / applyBottomFlipToLeft
//   5. render Y assignment + placeX — assignUpperLeftRenderY / placeX /
//                                     spreadSmallSlicesX
//   6. layoutLabels (entry, 公開 API)
// =============================================================================

import {
  normalizeAngle,
  upperLeftAngleProgress,
  labelHeightUnits,
  arcAngles,
  radialFraction,
  horizontalLowerLeftDropAmount,
  angleInBand,
  visualTextWidthUnits,
  scaledLabelWidthUnits,
  degToRad,
} from "./svg_geom.js";
import {
  TOP_BAND_HALF_WIDTH_DEG,
  BOTTOM_BAND_HALF_WIDTH_DEG,
  DOMINANT_OUTSIDE_EDGE_MIN_PCT,
  DOMINANT_OUTSIDE_ANCHOR_COS_THRESHOLD,
  DOMINANT_BELOW_CENTER_MIN_PCT,
} from "./label_placement.js";
import type {
  PieLayoutConfig,
  LayoutResult,
  LayoutItem,
  LayoutItemReady,
  Diagnostics,
} from "./types.js";

// =============================================================================
// 1. profiles — slice 分類とプロファイル構築
// =============================================================================

/** 角度から左右どちら側のラベルになるかを判定 */
function classifySide(angle: number): "left" | "right" {
  return angle > 90 && angle < 270 ? "left" : "right";
}

/** ラベル名の長さから推定行数を返す。compactLabel フラグなら常に 1 行。 */
function estimateTextLines(name: string, cfg: PieLayoutConfig, isCompact: boolean): number {
  if (isCompact || cfg.compactLabel) return 1;
  return name.length >= cfg.veryLongLabelLen ? 3 : 2;
}

/**
 * 各スライスについて配置に使う分類情報 (プロファイル) を構築する。
 * 後段の密度判定や個別配置ロジックは、このプロファイルのフラグを参照する。
 */
function buildProfiles(
  names: string[],
  values: number[],
  signedValues: number[] | undefined,
  mids: number[],
  cfg: PieLayoutConfig,
  compactFlags?: boolean[],
): LayoutItem[] {
  const total = values.reduce((sum, value) => sum + Number(value), 0) || 1;
  return names.map((name, index) => {
    const angle = normalizeAngle(mids[index]);
    const isCompact = Boolean((compactFlags && compactFlags[index]) || cfg.compactLabel);
    const value = Number(values[index]);
    // 分類は「合計に対する割合(%)」で行う。smallSliceThreshold 等は % しきい値であり、
    // 入力値の絶対スケール(合計が100でない場合)に依存させない (spreadSmallSlicesX と統一)。
    const percent = (value / total) * 100;
    return {
      name,
      value,
      signedValue: Number(signedValues ? signedValues[index] : values[index]),
      percent,
      midAngle: angle,
      side: classifySide(angle),
      isSmall: percent <= cfg.smallSliceThreshold,
      isTiny: percent <= cfg.tinySliceThreshold,
      isTop: Math.abs(angle - 90) <= cfg.topZoneDeg,
      isBottom: Math.abs(angle - 270) <= cfg.bottomZoneDeg,
      isUpperLeft: angle > 90 && angle < 180,
      isUpperRight: angle >= 0 && angle < 90,
      isLong: name.length >= cfg.longLabelLen,
      isVeryLong: name.length >= cfg.veryLongLabelLen,
      compactLabel: isCompact,
      estLines: estimateTextLines(name, cfg, isCompact),
    };
  });
}

/** 各スライスの中心角 (度) を計算する。startangle / counterclock を反映。 */
function calcMidAngles(values: number[], cfg: PieLayoutConfig): number[] {
  return arcAngles(values, cfg).map(({ midAngle }) => normalizeAngle((midAngle * 180) / Math.PI));
}

/**
 * プロファイルを元に「配置候補 (item)」配列を作る。
 * anchorX/Y はスライス境界上の引出線開始点、naturalY は重なり解消前の希望 Y 座標。
 */
function buildCandidates(
  names: string[],
  values: number[],
  signedValues: number[] | undefined,
  mids: number[],
  cfg: PieLayoutConfig,
  compactFlags?: boolean[],
): { items: LayoutItemReady[]; diagnostics: Diagnostics } {
  const profiles = buildProfiles(names, values, signedValues, mids, cfg, compactFlags);
  const diagnostics = runDiagnostics(profiles, cfg);

  // buildProfiles は midAngle/signedValue/estLines を必ず埋めるため、ここでの `!` は
  // ロジック保証だけが付いている (型上は LayoutItem の optional)。
  const items: LayoutItemReady[] = profiles.map((profile) => {
    const radian = degToRad(profile.midAngle!);
    const anchorX = Math.cos(radian) * cfg.pieRadius;
    const anchorY = Math.sin(radian) * cfg.pieRadius;
    let naturalY: number;

    if (profile.side === "right") {
      naturalY = anchorY - cfg.rightNaturalYOffset;
    } else if (profile.side === "left" && anchorY < 0) {
      naturalY = anchorY + cfg.lowerLeftNaturalYNudge;
    } else {
      naturalY = Math.sin(radian) * cfg.scaledLabelRadius;
    }

    return {
      ...profile,
      midAngle: profile.midAngle!,
      anchorX,
      anchorY,
      naturalY,
      textLines: profile.estLines!,
      finalX: 0,
      finalY: 0,
      upperLeftRenderY: 0,
      percentText: cfg.percentFormat(profile.signedValue!),
      flipToRight: false,
      flipToLeft: false,
      upperLeftSmallDense: false,
      upperLeftLongDense: false,
    };
  });

  return { items, diagnostics };
}

// =============================================================================
// 2. diagnostics — 密度・モード診断
// =============================================================================

/** profiles から診断に使う件数統計を集める (rankValuesFull / lowerDiffs / 各種 count)。 */
function collectSliceCounts(profiles: LayoutItem[]) {
  const rankValuesFull = [...profiles.map((profile) => profile.value)].sort((a, b) => b - a);
  const sortedAsc = [...rankValuesFull].sort((a, b) => a - b);
  const lowerDiffs: number[] = [];
  for (let index = 1; index < Math.min(5, sortedAsc.length); index += 1) {
    lowerDiffs.push(Number((sortedAsc[index] - sortedAsc[index - 1]).toFixed(4)));
  }
  const countIf = (predicate: (p: LayoutItem) => unknown) => profiles.filter(predicate).length;
  return {
    totalCount: profiles.length,
    rankValuesFull,
    lowerDiffs,
    leftCount: countIf((p) => p.side === "left"),
    rightCount: countIf((p) => p.side === "right"),
    // 左列 (上部「その他」を除く左側ラベル) の件数。twoLineLeftStackMode の入力。
    leftColumnCount: countIf((p) => p.side === "left" && !p.name.startsWith("その他")),
    upperLongCount: countIf((p) => (p.isUpperLeft || p.isUpperRight) && p.isLong),
    upperLeftLongCount: countIf((p) => p.isUpperLeft && p.isLong),
    upperRightLongCount: countIf((p) => p.isUpperRight && p.isLong),
    upperLeftSmallCount: countIf((p) => p.isUpperLeft && p.isSmall),
    upperRightSmallCount: countIf((p) => p.isUpperRight && p.isSmall),
    bottomSmallCount: countIf((p) => p.isBottom && p.isSmall),
    topSmallCount: countIf((p) => p.isTop && p.isSmall),
    topTinyCount: countIf((p) => p.isTop && p.isTiny),
    // 12時近傍 (mid 90°±30°) かつ small slice の件数。topBandClusterMode の入力。
    topBandClusterCount: countIf(
      (p) => Boolean(p.isSmall) && Math.abs(normalizeAngle(p.midAngle ?? 0) - 90) <= 30,
    ),
  };
}

/**
 * 件数統計と cfg から密集度モードタグを diag.modeTags に追記し、
 * 派生フラグ (dominantWithDensePeriphery / leftStackMode 等) を diag に設定する。
 */
function deriveModeTags(diag: Diagnostics, cfg: PieLayoutConfig): void {
  if (diag.manyItems) diag.modeTags.push("many_items");
  if (diag.ultraDenseItems) diag.modeTags.push("ultra_dense_items");
  if (diag.oneSideDense) diag.modeTags.push("one_side_dense");
  if (diag.oneSideVeryDense) diag.modeTags.push("one_side_very_dense");
  if (diag.topSmallDense) diag.modeTags.push("top_small_dense");
  if (diag.topTinyDense) diag.modeTags.push("top_tiny_dense");
  if (diag.lowerGapIsTight) diag.modeTags.push("lower_gap_tight");
  if (diag.longLabelDense) diag.modeTags.push("long_label_dense");
  if (diag.upperLeftLongDense) diag.modeTags.push("upper_left_long_dense");
  if (diag.upperRightLongDense) diag.modeTags.push("upper_right_long_dense");
  if (diag.upperLeftSmallCount! >= 3) diag.modeTags.push("upper_left_small_dense");
  if (diag.upperRightSmallCount! >= 3) diag.modeTags.push("upper_right_small_dense");
  if (diag.bottomSmallCount! >= 2) diag.modeTags.push("bottom_small_dense");

  // dominantWithDensePeriphery: 支配 slice (>=50%) + ultra-dense 周辺。
  const dominantWithDensePeriphery =
    diag.rankValuesFull![0] >= 50 &&
    diag.ultraDenseItems &&
    diag.upperLeftSmallCount! >= 3 &&
    diag.totalCount! >= 10;
  if (dominantWithDensePeriphery) diag.modeTags.push("dominantWithDensePeriphery");

  // leftStackMode: 左側 small slice >=4 件で発火する汎用ケース。
  const leftStackMode = diag.upperLeftSmallCount! >= 4;
  diag.leftStackMode = leftStackMode;
  if (leftStackMode) diag.modeTags.push("left_stack");

  // twoLineLeftStackMode: 左列 (その他除く) に外側ラベルが多数 (>=6) 寄る過密チャートで、全 2 行を
  // 維持したまま canvas 全高の密ピッチ縦 1 列へ再配置する (applyTwoLineLeftColumn)。leftStackMode
  // (1 行強制) とは排他。通常カスケードが縦に入りきらず 1 件を 1 行へ降格→左端見切れする症状を、
  // 縦クランプ (scaledLabelRadius) を外して全高を使うことで解消し、参考 PDF の全 2 行縦積みを再現する。
  const twoLineLeftStackMode = !leftStackMode && (diag.leftColumnCount ?? 0) >= 6;
  diag.twoLineLeftStackMode = twoLineLeftStackMode;
  if (twoLineLeftStackMode) diag.modeTags.push("two_line_left_stack");

  // topBandClusterMode: 12時近傍 (mid 90°±30°) に small slice が 4 件以上集まる密集ケース。
  // 12時 真近のスライスを含むと leftStackMode と並行発火する。applyTopBandClusterReorder で
  // Y順序を midAngle 順に並べ替え、12時 真近ラベルはクラスタ最下段+gap に固定する。
  const topBandClusterMode = (diag.topBandClusterCount ?? 0) >= 4;
  diag.topBandClusterMode = topBandClusterMode;
  if (topBandClusterMode) diag.modeTags.push("top_band_cluster");

  diag.upperLeftTriadEligible = !leftStackMode && !dominantWithDensePeriphery;

  diag.forceLowerLeftCompactBand = dominantWithDensePeriphery && !leftStackMode;
  diag.keepUpperLeft2Lines = dominantWithDensePeriphery && !leftStackMode;
  diag.allowTopBandThreeFlip = dominantWithDensePeriphery && !leftStackMode;
}

/** profiles 配列から診断オブジェクトを生成する。 */
function runDiagnostics(profiles: LayoutItem[], cfg: PieLayoutConfig): Diagnostics {
  // 側別/帯別カウントはここでフラグ算出にのみ使うローカル値。diag には Diagnostics に
  // 宣言済みのフィールド (フラグ・後段で読むカウント) だけを載せる。
  const {
    totalCount,
    rankValuesFull,
    lowerDiffs,
    leftCount,
    rightCount,
    leftColumnCount,
    upperLongCount,
    upperLeftLongCount,
    upperRightLongCount,
    upperLeftSmallCount,
    upperRightSmallCount,
    bottomSmallCount,
    topSmallCount,
    topTinyCount,
    topBandClusterCount,
  } = collectSliceCounts(profiles);
  const diag: Diagnostics = {
    totalCount,
    rankValuesFull,
    upperLeftSmallCount,
    upperRightSmallCount,
    bottomSmallCount,
    topBandClusterCount,
    leftColumnCount,
    manyItems: profiles.length >= cfg.denseCountThreshold,
    ultraDenseItems: profiles.length >= cfg.ultraDenseCountThreshold,
    oneSideDense: Math.max(leftCount, rightCount) >= cfg.oneSideDenseThreshold,
    oneSideVeryDense: Math.max(leftCount, rightCount) >= cfg.oneSideVeryDenseThreshold,
    topSmallDense: topSmallCount >= cfg.topSmallDenseThreshold,
    topTinyDense: topTinyCount >= cfg.topTinyDenseThreshold,
    lowerGapIsTight: lowerDiffs.some((diff: number) => diff <= cfg.lowerDiffSmallThreshold),
    longLabelDense: upperLongCount >= cfg.longLabelDenseThreshold,
    upperLeftLongDense: upperLeftLongCount >= 2,
    upperRightLongDense: upperRightLongCount >= 2,
    isHighDensity: () =>
      Boolean(diag.manyItems || diag.oneSideDense || diag.topSmallDense || diag.longLabelDense),
    modeTags: [] as string[],
  };
  deriveModeTags(diag, cfg);
  return diag;
}

// =============================================================================
// 3. resolve (vertical) — 縦方向の重なり解消 + bottom 特殊処理
// =============================================================================

/**
 * 単独 item に必要な最小 gap を返す。
 * 行数 / 長文 / 密集モードに応じて加算する。
 */
function baseGap(item: LayoutItemReady, diagnostics: Diagnostics, cfg: PieLayoutConfig): number {
  let gap = cfg.scaledMinGap;
  if (item.textLines >= 3) {
    gap = Math.max(gap, cfg.scaledMinGapMultiline + 0.05 * cfg.gapScale);
    gap = Math.max(gap, labelHeightUnits(item.textLines, cfg) + 0.012);
  } else if (item.textLines === 2) {
    gap = Math.max(gap, cfg.scaledMinGapMultiline);
    gap = Math.max(gap, labelHeightUnits(2, cfg) + 0.012);
  }

  if (diagnostics.isHighDensity()) {
    gap = Math.max(gap, cfg.scaledMinGapDense);
  }
  if (diagnostics.ultraDenseItems || diagnostics.topTinyDense) {
    gap = Math.max(gap, cfg.scaledMinGapUltraDense);
  }
  if (item.isLong) {
    gap += 0.02 * cfg.gapScale;
  }
  if (item.isVeryLong) {
    gap += 0.03 * cfg.gapScale;
  }
  if (item.isUpperLeft && (diagnostics.upperLeftLongDense || diagnostics.topSmallDense)) {
    gap += 0.02 * cfg.gapScale;
  }
  if (item.isUpperLeft && diagnostics.modeTags.includes("upper_left_small_dense")) {
    gap += 0.07 * cfg.gapScale;
    if (item.textLines >= 2) gap += 0.05 * cfg.gapScale;
    if (item.textLines >= 3 || item.isLong) gap += 0.05 * cfg.gapScale;
    if (item.textLines >= 3) gap += 0.08 * cfg.gapScale;
  }
  return gap;
}

/** 隣接ペアに必要な gap。両者ともマルチライン時は更に余裕を持たせる。 */
function pairGap(a: LayoutItemReady, b: LayoutItemReady, diagnostics: Diagnostics, cfg: PieLayoutConfig): number {
  let gap = Math.max(baseGap(a, diagnostics, cfg), baseGap(b, diagnostics, cfg));
  if (a.isUpperLeft && b.isUpperLeft) {
    const aMultiline = a.textLines >= 2 || a.isLong;
    const bMultiline = b.textLines >= 2 || b.isLong;
    if (aMultiline && bMultiline) {
      gap += 0.05 * cfg.gapScale;
    } else if (aMultiline || bMultiline) {
      gap += 0.03 * cfg.gapScale;
    }
  }
  return gap;
}

/** sideItems が canvas 上下端からはみ出していれば、全体を平行移動する。 */
function clampSideRange(sideItems: LayoutItemReady[], cfg: PieLayoutConfig): void {
  if (sideItems.length === 0) return;
  const under = cfg.scaledYBottom - sideItems[sideItems.length - 1].finalY;
  if (under > 0)
    sideItems.forEach((item) => {
      item.finalY = item.finalY + under;
    });
  const over = sideItems[0].finalY - cfg.scaledYTop;
  if (over > 0)
    sideItems.forEach((item) => {
      item.finalY = item.finalY - over;
    });
}

/** sideItems の初期 finalY を naturalY から canvas 上下端でクランプ。 */
function setInitialFinalY(sideItems: LayoutItemReady[], side: "left" | "right", cfg: PieLayoutConfig): void {
  const yInitTop = side === "right" ? cfg.scaledYTop : cfg.scaledYTop - cfg.leftInitTopInset;
  sideItems.forEach((item) => {
    item.finalY = Math.max(cfg.scaledYBottom, Math.min(yInitTop, item.naturalY));
  });
}

/** 右側のみの上→下 + 下→上 の 2 パス重なり解消 (端でクランプ)。 */
function resolveRightSidePositions(sideItems: LayoutItemReady[], diagnostics: Diagnostics, cfg: PieLayoutConfig): void {
  sideItems.sort(
    (a, b) =>
      Math.sin(degToRad(b.midAngle)) - Math.sin(degToRad(a.midAngle)),
  );
  for (let index = 1; index < sideItems.length; index += 1) {
    const previous = sideItems[index - 1];
    const current = sideItems[index];
    const gap = baseGap(current, diagnostics, cfg);
    if (current.finalY > previous.finalY - gap) {
      current.finalY = previous.finalY - gap;
    }
  }
  clampSideRange(sideItems, cfg);

  for (let index = sideItems.length - 2; index >= 0; index -= 1) {
    const current = sideItems[index];
    const next = sideItems[index + 1];
    const gap = baseGap(next, diagnostics, cfg);
    if (current.finalY < next.finalY + gap) {
      current.finalY = next.finalY + gap;
    }
  }
  clampSideRange(sideItems, cfg);
}

/** 左側の上群と下群を別個に解消し、衝突時は半分ずつ押し戻して合流する。 */
function resolveLeftSidePositions(sideItems: LayoutItemReady[], diagnostics: Diagnostics, cfg: PieLayoutConfig): void {
  const upper = sideItems
    .filter((item) => item.naturalY > 0)
    .sort((a, b) => a.finalY - b.finalY);
  const lower = sideItems
    .filter((item) => item.naturalY <= 0)
    .sort((a, b) => b.finalY - a.finalY);

  for (let index = 1; index < upper.length; index += 1) {
    const previous = upper[index - 1];
    const current = upper[index];
    const gap = pairGap(previous, current, diagnostics, cfg);
    if (current.finalY < previous.finalY + gap) {
      current.finalY = previous.finalY + gap;
    }
  }
  if (upper.length && upper[upper.length - 1].finalY > cfg.scaledYTop) {
    upper[upper.length - 1].finalY = cfg.scaledYTop;
    for (let index = upper.length - 2; index >= 0; index -= 1) {
      const next = upper[index + 1];
      const current = upper[index];
      const gap = pairGap(current, next, diagnostics, cfg);
      if (current.finalY > next.finalY - gap) {
        current.finalY = next.finalY - gap;
      }
    }
  }

  for (let index = 1; index < lower.length; index += 1) {
    const previous = lower[index - 1];
    const current = lower[index];
    const gap = baseGap(current, diagnostics, cfg);
    if (current.finalY > previous.finalY - gap) {
      current.finalY = previous.finalY - gap;
    }
  }
  if (lower.length && lower[lower.length - 1].finalY < cfg.scaledYBottom) {
    lower[lower.length - 1].finalY = cfg.scaledYBottom;
    for (let index = lower.length - 2; index >= 0; index -= 1) {
      const next = lower[index + 1];
      const current = lower[index];
      const gap = baseGap(current, diagnostics, cfg);
      if (current.finalY < next.finalY + gap) {
        current.finalY = next.finalY + gap;
      }
    }
  }

  if (upper.length && lower.length) {
    const gap = Math.max(baseGap(upper[0], diagnostics, cfg), baseGap(lower[0], diagnostics, cfg));
    const overlap = gap - (upper[0].finalY - lower[0].finalY);
    if (overlap > 0) {
      upper.forEach((item) => {
        item.finalY = item.finalY + overlap / 2;
      });
      lower.forEach((item) => {
        item.finalY = item.finalY - overlap / 2;
      });
      if (upper.length && upper[upper.length - 1].finalY > cfg.scaledYTop) {
        const shift = upper[upper.length - 1].finalY - cfg.scaledYTop;
        upper.forEach((item) => {
          item.finalY = item.finalY - shift;
        });
      }
      if (lower.length && lower[lower.length - 1].finalY < cfg.scaledYBottom) {
        const shift = cfg.scaledYBottom - lower[lower.length - 1].finalY;
        lower.forEach((item) => {
          item.finalY = item.finalY + shift;
        });
      }
    }
  }

  // forceLowerLeftCompactBand: 水平 lower-left を deepest LL の anchorY + dropAmount に固定。
  if (diagnostics.forceLowerLeftCompactBand && lower.length >= 2) {
    const deepest = lower.reduce((d, it) => (it.anchorY < d.anchorY ? it : d), lower[0]);
    const dropAmount = horizontalLowerLeftDropAmount(cfg);
    for (const item of lower) {
      if (item.forceHorizontalLowerLeftDrop) {
        item.finalY = deepest.anchorY + dropAmount;
      }
    }
  }
}

function resolveSidePositions(
  sideItems: LayoutItemReady[],
  side: "left" | "right",
  diagnostics: Diagnostics,
  cfg: PieLayoutConfig,
): void {
  if (sideItems.length === 0) return;
  setInitialFinalY(sideItems, side, cfg);
  if (side === "right") {
    resolveRightSidePositions(sideItems, diagnostics, cfg);
  } else {
    resolveLeftSidePositions(sideItems, diagnostics, cfg);
  }
}

/** 6 時方向の小スライスは bottomSpecialY より下に強制的に押し下げる。 */
function applyBottomSpecial(sideItems: LayoutItemReady[], cfg: PieLayoutConfig): void {
  sideItems.forEach((item) => {
    if (item.isBottom && item.isSmall) {
      item.finalY = Math.min(item.finalY, cfg.bottomSpecialY);
    }
  });
}

// =============================================================================
// 4. flip helpers — 左→右 / 右→左 flip 処理
// =============================================================================

// 左上 → 右側 flip の角度しきい値 (トップバンド半幅は label_placement と共有)
const FLIP_PRIMARY_MAX_DEG = 90 + TOP_BAND_HALF_WIDTH_DEG; // 108

function flipDenseExtendedMaxDeg(cfg: PieLayoutConfig): number {
  return 180 - cfg.topZoneDeg - 2;
}

const FLIP_PASS2_SAFETY_MARGIN = 0.015;

function flipDensePass3Threshold(cfg: PieLayoutConfig): number {
  return cfg.oneSideVeryDenseThreshold;
}

function flipAllowThreeMinRemaining(cfg: PieLayoutConfig): number {
  return cfg.oneSideDenseThreshold;
}

const PIE_RADIUS_INSET = 0.005;

const BOTTOM_FLIP_RIGHT_TO_LEFT_ANCHOR_X_MIN = 0.15;
const BOTTOM_FLIP_RIGHT_TO_LEFT_ANCHOR_X_MAX = 0.21;
const BOTTOM_FLIP_LEFT_ANGLE_TOL_DEG = 18;

/** 左上ラベルの最小立ち上がり長さ (角度 90→180 に近づくほど高く)。 */
function upperLeftMinRiseBase(angle: number, cfg: PieLayoutConfig): number {
  const angleProgress = upperLeftAngleProgress(normalizeAngle(angle));
  return radialFraction(cfg, 0.026, 0.16 + 0.1 * angleProgress);
}

/** 隣接 upper-left ラベルの最小 gap = ラベル高さ + わずかな余裕 */
function upperLeftStackGap(
  textLinesA: number | undefined,
  textLinesB: number | undefined,
  cfg: PieLayoutConfig,
): number {
  const lines = Math.max(textLinesA ?? 2, textLinesB ?? 2);
  return labelHeightUnits(lines, cfg) + 0.025;
}

/** 左上スタックの「高さ」を見積もる (flip 判定用)。 */
function estimateUpperLeftStackHeight(
  items: LayoutItemReady[],
  cfg: PieLayoutConfig,
  { forceOneLine = false }: { forceOneLine?: boolean } = {},
): number {
  if (items.length === 0) return 0;
  const sorted = [...items].sort((a, b) => b.midAngle - a.midAngle);
  const bottom = sorted[0];
  let stackTop =
    Math.sin(degToRad(bottom.midAngle)) + upperLeftMinRiseBase(bottom.midAngle, cfg);
  for (let i = 1; i < sorted.length; i += 1) {
    const linesA = forceOneLine ? 1 : sorted[i - 1].textLines;
    const linesB = forceOneLine ? 1 : sorted[i].textLines;
    stackTop += upperLeftStackGap(linesA, linesB, cfg);
  }
  return stackTop;
}

/** 残候補のうち midAngle が (minDeg, maxDeg] にあり、90° に最も近いものを返す。 */
function pickFlipCandidate(remaining: LayoutItemReady[], minDeg: number, maxDeg: number): LayoutItemReady | null {
  const candidates = remaining.filter((item) => item.midAngle > minDeg && item.midAngle <= maxDeg);
  if (candidates.length === 0) return null;
  return candidates.reduce((best, current) => (current.midAngle < best.midAngle ? current : best));
}

/**
 * 6 時近辺で右側に来た小スライスを左側へ flip。さらに既存左側 item と
 * 縦位置が近い場合は左側を上へ追い出して衝突を回避する。
 */
function applyBottomFlipToLeft(left: LayoutItemReady[], right: LayoutItemReady[], cfg: PieLayoutConfig): void {
  const bottomMin = 270 - cfg.bottomZoneDeg;
  const bottomMax = 270 + cfg.bottomZoneDeg;
  right.forEach((item) => {
    if (
      item.midAngle >= bottomMin &&
      item.midAngle <= bottomMax &&
      item.anchorX >= BOTTOM_FLIP_RIGHT_TO_LEFT_ANCHOR_X_MIN &&
      item.anchorX < BOTTOM_FLIP_RIGHT_TO_LEFT_ANCHOR_X_MAX &&
      Math.abs(item.midAngle - 270) <= BOTTOM_FLIP_LEFT_ANGLE_TOL_DEG
    ) {
      item.flipToLeft = true;
      item.finalX = -item.finalX;
    }
  });

  right.forEach((rightItem) => {
    if (!rightItem.flipToLeft) return;
    left.forEach((leftItem) => {
      if (Math.abs(rightItem.finalY - leftItem.finalY) < cfg.scaledMinGap) {
        const newY = rightItem.finalY + cfg.scaledMinGap;
        const radius = cfg.scaledLabelRadius;
        const y = Math.min(radius - PIE_RADIUS_INSET, newY);
        leftItem.finalY = y;
        leftItem.finalX = -Math.sqrt(radius * radius - y * y);
      }
    });
  });
}

/**
 * flipToRight 指定の左側 item について placeX 後の finalX を反転 →
 * pie 円内に侵入していたら clearance 分外へ押し出して finalX を再計算する。
 */
function applyFlipToRight(left: LayoutItemReady[], cfg: PieLayoutConfig): void {
  left.forEach((item) => {
    if (!item.flipToRight) return;
    item.finalX = -item.finalX;
    if (item.finalY < cfg.pieRadius + cfg.flipPieClearance) {
      const radius = cfg.scaledLabelRadius;
      const minY = Math.min(cfg.pieRadius + cfg.flipPieClearance, radius - PIE_RADIUS_INSET);
      item.finalY = minY;
      item.finalX = Math.sqrt(radius * radius - minY * minY);
    }
  });
}

/** pass 2 で使える「pie 円外へ leader を出せる最大角度」を計算する。 */
function computePass2MaxAngle(cfg: PieLayoutConfig): number {
  const sinThreshold = cfg.pieRadius - cfg.scaledRadialExitLen + FLIP_PASS2_SAFETY_MARGIN;
  if (sinThreshold >= 1) return FLIP_PRIMARY_MAX_DEG;
  const refAngleDeg = (Math.asin(sinThreshold) * 180) / Math.PI;
  return 180 - refAngleDeg;
}

/**
 * 左上群が天井を超えた場合、トップバンド寄りの item を右側へ flip して stack を圧縮する。
 */
function flipUpperLeftStackToRight(left: LayoutItemReady[], diagnostics: Diagnostics, cfg: PieLayoutConfig): void {
  const upperLeftAll = left.filter((item) => item.isUpperLeft && !item.flipToRight);
  if (upperLeftAll.length === 0) return;
  const topLimit = cfg.scaledYTop;
  const pass2MaxAngle = computePass2MaxAngle(cfg);

  const scored = upperLeftAll
    .map((item) => {
      let tier: number | null;
      if (item.midAngle <= FLIP_PRIMARY_MAX_DEG) tier = 1;
      else if (item.midAngle <= pass2MaxAngle) tier = 2;
      else tier = null;
      return { item, tier };
    })
    .filter((c) => c.tier != null)
    .sort((a, b) => (a.tier! - b.tier!) || (a.item.midAngle - b.item.midAngle));

  const forceOneLine = diagnostics.leftStackMode === true;
  let remaining = upperLeftAll;
  for (const { item } of scored) {
    if (estimateUpperLeftStackHeight(remaining, cfg, { forceOneLine }) <= topLimit) break;
    item.flipToRight = true;
    remaining = remaining.filter((i) => i !== item);
  }

  // トレーリング: dense + 残数閾値ヒットで 1 件だけ拡張範囲 flip。
  if (
    !forceOneLine &&
    diagnostics.modeTags.includes("upper_left_small_dense") &&
    remaining.length >= flipDensePass3Threshold(cfg)
  ) {
    const toFlip = pickFlipCandidate(remaining, FLIP_PRIMARY_MAX_DEG, flipDenseExtendedMaxDeg(cfg));
    if (toFlip != null) {
      toFlip.flipToRight = true;
      remaining = remaining.filter((i) => i !== toFlip);
    }
  }

  // allowTopBandThreeFlip: もう 1 件追加 flip。
  if (
    diagnostics.allowTopBandThreeFlip &&
    remaining.length >= flipAllowThreeMinRemaining(cfg)
  ) {
    const toFlip = pickFlipCandidate(remaining, FLIP_PRIMARY_MAX_DEG, flipDenseExtendedMaxDeg(cfg));
    if (toFlip != null) toFlip.flipToRight = true;
  }
}

// =============================================================================
// 5. render Y assignment + placeX — 描画用 Y / X の確定
// =============================================================================

/** 左上スタック各 item に rank / count / smallDense / longDense / triad フラグを設定する。 */
function assignUpperLeftMetadata(upper: LayoutItemReady[], diagnostics: Diagnostics): void {
  const upperLeftSmallCount = upper.filter((item) => item.isSmall).length;
  const upperLeftLongCount = upper.filter((item) => item.isLong).length;
  const upperLeftSmallDense = upperLeftSmallCount >= 3;
  const upperLeftLongDense = upperLeftLongCount >= 2;
  const upperLeftTriadActive =
    upper.length === 3 && diagnostics.upperLeftTriadEligible === true;
  if (upperLeftTriadActive && !diagnostics.modeTags.includes("upperLeftTriad")) {
    diagnostics.modeTags.push("upperLeftTriad");
  }
  upper.forEach((item, index) => {
    item.upperLeftRank = upper.length - 1 - index;
    item.upperLeftCount = upper.length;
    item.upperLeftSmallDense = upperLeftSmallDense;
    item.upperLeftLongDense = upperLeftLongDense;
    item.upperLeftTriad = upperLeftTriadActive;
  });
}

/** 左上スタック向け minRise / renderGapFn / minGapFn を構築する。 */
function buildUpperLeftStackFns(
  diagnostics: Diagnostics,
  cfg: PieLayoutConfig,
): {
  minRise: (item: LayoutItemReady) => number;
  renderGapFn: (prev: LayoutItemReady, current: LayoutItemReady) => number;
  minGapFn: (prev: LayoutItemReady, current: LayoutItemReady) => number;
  denseDominantMode: boolean;
} {
  const denseDominantMode = Boolean(diagnostics.forceLowerLeftCompactBand);
  const minRise = (item: LayoutItemReady) => {
    if (denseDominantMode) return 0.005;
    let rise = upperLeftMinRiseBase(item.midAngle, cfg);
    if (item.textLines >= 3) rise += 0.014;
    if (item.isLong) rise += 0.01;
    return rise;
  };

  const renderGap = (lower: LayoutItemReady, upperItem: LayoutItemReady) => {
    let gap = upperLeftStackGap(lower.textLines, upperItem.textLines, cfg);
    if (lower.isLong || upperItem.isLong) gap += 0.012;
    if (lower.isVeryLong || upperItem.isVeryLong) gap += 0.01;
    return gap;
  };

  const minGapFn = (prev: LayoutItemReady, current: LayoutItemReady) => {
    const lines = Math.max(prev.textLines ?? 2, current.textLines ?? 2);
    const extraBuffer = denseDominantMode ? 0.04 : 0.004;
    return labelHeightUnits(lines, cfg) + extraBuffer;
  };
  const renderGapFn = (prev: LayoutItemReady, current: LayoutItemReady) => renderGap(current, prev);
  return { minRise, renderGapFn, minGapFn, denseDominantMode };
}

/** 左上スタックを底→頂上で積み上げる共有ヘルパ。 */
function stackUpperLeftY(
  items: LayoutItemReady[],
  riseFn: (item: LayoutItemReady) => number,
  gapFn: (prev: LayoutItemReady, current: LayoutItemReady) => number,
): number[] {
  const result: number[] = [];
  if (items.length === 0) return result;
  result[0] = items[0].anchorY + riseFn(items[0]);
  for (let i = 1; i < items.length; i += 1) {
    const minY = items[i].anchorY + riseFn(items[i]);
    const fromPrev = result[i - 1] + gapFn(items[i - 1], items[i]);
    result[i] = Math.max(minY, fromPrev);
  }
  return result;
}

/** 左上ラベル群の「描画用 Y」を決める。 */
function assignUpperLeftRenderY(
  sideItems: LayoutItemReady[],
  diagnostics: Diagnostics,
  cfg: PieLayoutConfig,
): void {
  const upper = [...sideItems.filter((item) => item.isUpperLeft && !item.flipToRight)].sort(
    (a, b) => a.finalY - b.finalY,
  );
  if (upper.length === 0) return;

  assignUpperLeftMetadata(upper, diagnostics);
  const { minRise, renderGapFn, minGapFn, denseDominantMode } = buildUpperLeftStackFns(
    diagnostics,
    cfg,
  );

  const naturalY = stackUpperLeftY(upper, minRise, renderGapFn);
  const topLimit = cfg.scaledYTop + radialFraction(cfg, 0.006, 0.06);

  if (naturalY[upper.length - 1] <= topLimit) {
    upper.forEach((item, i) => {
      item.upperLeftRenderY = naturalY[i];
    });
    if (denseDominantMode) {
      const shift = 0.22;
      upper.forEach((item) => {
        item.upperLeftRenderY = item.upperLeftRenderY - shift;
      });
    }
    markUpperLeftStackRimY(upper, diagnostics, cfg);
    return;
  }

  const minStack = stackUpperLeftY(upper, minRise, minGapFn);
  const naturalSpan = naturalY[upper.length - 1] - naturalY[0];
  const minSpan = minStack[upper.length - 1] - minStack[0];
  const targetSpan = topLimit - naturalY[0];

  let scale: number;
  if (naturalSpan <= 0) {
    scale = 0;
  } else if (targetSpan >= naturalSpan) {
    scale = 1;
  } else if (targetSpan <= minSpan || naturalSpan - minSpan < 1e-9) {
    scale = 0;
  } else {
    scale = (targetSpan - minSpan) / (naturalSpan - minSpan);
  }

  upper.forEach((item, i) => {
    item.upperLeftRenderY = minStack[i] * (1 - scale) + naturalY[i] * scale;
  });
  markUpperLeftStackRimY(upper, diagnostics, cfg);
}

/**
 * 統一カスケード rim 配置向け: upperLeftTriadEligible かつ上左 3 件以上で、自然 rim
 * (sin(mid)*pieRadius) が縦に重なる時のみ各 item に useStackRimY を立てる。
 * buildOutsideRimDraft はこの印がある item の textY を upperLeftRenderY (事前分離済の
 * 縦スタック値) に置換する。これにより rank② (2行原寸) が overlap 失敗せず、長体/1行への
 * 過剰降格と横ドリフトが連鎖的に消える。既に rim で収まるスタックは印を立てない
 * (= 当該チャート完全無変更) → leftStackMode 群は upperLeftTriadEligible=false で除外。
 */
function markUpperLeftStackRimY(
  upper: LayoutItemReady[],
  diagnostics: Diagnostics,
  cfg: PieLayoutConfig,
): void {
  if (diagnostics.upperLeftTriadEligible !== true) return;
  const eligible = upper.filter(
    (it) => it.isUpperLeft && !it.flipToRight && Number.isFinite(it.upperLeftRenderY),
  );
  if (eligible.length < 3) return;
  const overlapTol = 8 / (cfg.mmPerUnit * cfg.svgUnitsPerMm);
  const minSep = labelHeightUnits(2, cfg) + overlapTol;
  const rimY = (it: LayoutItemReady) =>
    Math.sin(degToRad(it.midAngle)) * cfg.pieRadius;
  const sorted = [...eligible].sort((a, b) => rimY(b) - rimY(a)); // 上 → 下
  let overlaps = false;
  for (let i = 1; i < sorted.length; i += 1) {
    if (rimY(sorted[i - 1]) - rimY(sorted[i]) < minSep) {
      overlaps = true;
      break;
    }
  }
  if (!overlaps) return;
  for (const it of eligible) it.useStackRimY = true;
}

/**
 * 上左 (mid>90) の top-band 帯 (90°±TOP_BAND_HALF_WIDTH_DEG)・非「その他」スライバを抽出する共通
 * フィルタ。markForcedTopSliverLeader / markForcedTopSliverEscapeRight / markLoneTopSliverLeader が
 * 共有する (以前は各関数に同一フィルタが重複していた)。size: "small"=isSmall / "tiny"=isTiny。
 * long: "exclude"=!isLong (既定の leader 対象。isLong=undefined も含む) / "require"=isLong
 * (長名スライバの存在判定用)。truthiness は元の && チェーンと完全一致させてある。
 */
function topBandLeftSlivers(
  items: LayoutItemReady[],
  size: "small" | "tiny",
  long: "exclude" | "require",
): LayoutItemReady[] {
  return items.filter(
    (it) =>
      (size === "tiny" ? it.isTiny : it.isSmall) &&
      it.midAngle > 90 &&
      angleInBand(normalizeAngle(it.midAngle), 90, TOP_BAND_HALF_WIDTH_DEG) &&
      !it.name.startsWith("その他") &&
      (long === "require" ? it.isLong : !it.isLong),
  );
}

/** 12時 (90°) に最も近い (|midAngle-90| 最小) 要素を返す。同距離は先勝ち。呼び出し側は非空を保証する。 */
function nearestToTwelveOClock(items: LayoutItemReady[]): LayoutItemReady {
  let best = items[0];
  for (const it of items) {
    if (Math.abs(it.midAngle - 90) < Math.abs(best.midAngle - 90)) best = it;
  }
  return best;
}

/**
 * 12時直左の小 top-band スライスが上左で混雑する時、12時に最も近い 1 件に topBandSmallRight を
 * 立てて右上空白へ逃がす (label_placement.ts topBandSmallRight が参照)。これにより上左に小
 * top-band が 2 つ並んで片方が長体化する症状を解消し、両ラベルを原寸 2 行に収める。
 *
 * ゲート (混雑が実在する上左 triad のみに限定):
 *  - upperLeftTriadEligible (= !leftStackMode && !dominantWithDensePeriphery)
 *  - 上左 triad が実際に rim 重なり (left.some(useStackRimY)) = チャート単位の混雑の証人
 *  - 候補は small かつ top-band (72–108°) かつ mid>90 (左側) かつ「その他」でなく flipToRight 済
 *  - 候補のうち 12時 (90°) に最も近い 1 件だけに付与
 */
function markTopBandSmallRight(left: LayoutItemReady[], diagnostics: Diagnostics): void {
  if (diagnostics.upperLeftTriadEligible !== true) return;
  if (!left.some((it) => it.useStackRimY === true)) return;
  const candidates = left.filter(
    (it) =>
      it.isSmall &&
      it.midAngle > 90 &&
      angleInBand(normalizeAngle(it.midAngle), 90, TOP_BAND_HALF_WIDTH_DEG) &&
      !it.name.startsWith("その他") &&
      it.flipToRight === true,
  );
  if (candidates.length === 0) return;
  nearestToTwelveOClock(candidates).topBandSmallRight = true;
}

/**
 * 9時直近の幅広・長名 上左ラベルが、長体下限 (nameCondenseSteps[0]) でも viewBox 左端を見切れる
 * 構成 (例 world_bond_idx_currency「オフショア人民元」) で、当該 1 ラベルを下left (水平軸下・円が
 * 横へ逃げ帯が広い領域) へ 2 行のまま配置し、slice rim から斜めリーダーで接続する印を立てる
 * (参考PDF「オーストラリア」配置)。rim 端 (useStackRimY) で end-anchor 張り付けて左へ伸び見切れる
 * 代わりに、lowerLeftDropLeader + forceHorizontalLowerLeftDrop (内側 X クランプ解放) で円外へ伸ばす。
 *
 * 本関数は「候補識別」のみを行う前フィルタで、実 clip 判定と採否は emit 側
 * applyLowerLeftDropFallback の do-no-harm に委ねる (実際に見切れている placement のみドロップを
 * 試し、clips 厳密減・他非悪化の時だけ採用)。よってゲートは緩くてよい。フィルネーム特例ではなく
 * 幾何 + モード + 閉形式見切れ判定でゲートする:
 *  - twoLineLeftStackMode / topBandClusterMode でない (独自の viewBox 基準配置 / 12時集約を持ち
 *    下left ドロップと噛み合わないため除外)。leftStackMode / triad / 通常は許可。
 *  - 候補は side==="left" && isUpperLeft && isLong && 非 flip、非「その他」、9時直近帯 (150–210°)
 *  - 長体下限幅 (scaledLabelWidthUnits, nameScaleX=nameCondenseSteps[0], 2行) が、最も水平な
 *    ラベルが水平軸付近へ来た時の最左 anchor = -(pieRadius + clearance) で viewBox 左端を越える
 *    (最悪ケースの前フィルタ。実 clip でなければ fallback がスキップする)
 * 該当が複数あれば最も 9時に近い (cos が最小) 1 件のみへ付与する。
 */
function markClippedUpperLeftLongDrop(
  left: LayoutItemReady[],
  diagnostics: Diagnostics,
  cfg: PieLayoutConfig,
): void {
  if (diagnostics.twoLineLeftStackMode || diagnostics.topBandClusterMode) return;

  const floorScale = cfg.nameCondenseSteps[0] ?? 0.7;
  const viewBoxLeft = -cfg.svgWidthPx / 2 / cfg.pxPerUnit;
  const tol = 0.02; // ≈ 3px 安全代 (前フィルタなので実際に見切れる場合のみ通す)
  // 最も水平な (9時直近) 長名ラベルは overlap 解消等で水平軸付近へ来やすく、end-anchor 右端が
  // 円の最大幅 (赤道) で pieClearance クランプされる。よって取り得る最左の anchor =
  // -(pieRadius + clearance)。長体下限でもこの最悪ケースで viewBox 左端を越えるなら見切れ得る。
  const worstAnchorX = -(cfg.pieRadius + cfg.pieLabelClearance);
  const candidates = left.filter((it) => {
    if (it.flipToRight || it.flipToLeft) return false;
    if (!(it.isUpperLeft && it.isLong)) return false;
    if (it.name.startsWith("その他")) return false;
    if (!angleInBand(normalizeAngle(it.midAngle), 180, 30)) return false;
    const width = scaledLabelWidthUnits(it.name, it.percentText ?? "", 2, floorScale, cfg);
    return worstAnchorX - width < viewBoxLeft - tol;
  });
  if (candidates.length === 0) return;
  let best = candidates[0];
  for (const it of candidates) {
    if (Math.cos(degToRad(it.midAngle)) < Math.cos(degToRad(best.midAngle))) best = it;
  }
  // 識別のみ。通常レイアウト/カスケードは無変更 (rim 2 行で見切れる baseline のまま) に保ち、
  // svg_export 側 applyLowerLeftDropFallback が emit 最終段で下left ドロップを試し、チャート全体の
  // 不具合 (countDefects) が clips 厳密減・他非悪化の時だけ採用する (do-no-harm)。密チャートで
  // 交差/反転を生む場合は revert され、当該チャートは無変更 = 回帰ゼロ。
  best.lowerLeftDropLeader = true;
}

/**
 * 「1強(≥90%)+極小トップ2枚」型 (例 manulife_country: 日本99.3/フランス0.6/米国0.1) で、上左に並ぶ
 * 極小スライス2枚の双方に forceOutsideLeader を立て、svg_export runCascadeOnce が rank 9 起点
 * (buildOutsideLeaderDraft) で leader を引けるようにする。これをしないと、2枚が上左で混み合い片方の
 * leader が相手のラベル box / 円貫通ガードに落ちて消える (= フランスに leader が出ない症状)。
 *
 * 交差回避の要は「各スライスを自分の側へ逃がす」: 12時に近い方 (near) を topBandSmallRight で右上、
 * 遠い方 (far) を generic radial で左上へ。左寄りスライスの leader を右へ回すと near の riser を跨いで
 * 交差するため、左スライス→左・右スライス→右に振り分けて互いの riser に到達させない。
 *
 * ゲート (この構成だけに限定し他チャートへ波及させない):
 *  - leftStackMode / topBandClusterMode でない (≥4 件密集の別系統)
 *  - 最大スライス ≥ 90% (1強)
 *  - 総スライス数 == 3 (1強 + 周辺2枚)
 *  - 上左 (mid>90) の small・top-band (72–108°)・非「その他」・非長名 スライスがちょうど 2 枚
 */
function markForcedTopSliverLeader(left: LayoutItemReady[], diagnostics: Diagnostics): void {
  if (diagnostics.leftStackMode || diagnostics.topBandClusterMode) return;
  if ((diagnostics.rankValuesFull?.[0] ?? 0) < 90) return;
  if (diagnostics.totalCount !== 3) return;
  // !isLong: 本 leader 付与は各スライスを 1 行ラベルで左右に振り分ける。長名は 1 行化で過剰長体
  // (scaleX 下限 0.6) になり可読性が落ちるため対象外 (例 asset_domestic「国内投資信託証券」)。
  const slivers = topBandLeftSlivers(left, "small", "exclude");
  if (slivers.length !== 2) return;
  let near = slivers[0];
  let far = slivers[0];
  for (const it of slivers) {
    if (Math.abs(it.midAngle - 90) < Math.abs(near.midAngle - 90)) near = it;
    if (Math.abs(it.midAngle - 90) > Math.abs(far.midAngle - 90)) far = it;
  }
  // 両極小を rank 9 (buildOutsideLeaderDraft) 起点へ強制し、双方に leader を引かせる。
  // leader 交差を避ける鍵は「各スライスを自分の側へ逃がす」こと: 12時より左寄り (mid が大きい)
  // の far を左上 (generic radial)、12時に近い near を右上 (topBandSmallRight) へ。これにより
  // 左スライスの leader を右へ回して near の riser を跨ぐ交差が起きない。各 leader は自 anchor
  // から外側へ向かうだけなので互いの riser に到達しない。leaderless rim で確定させず rank 9 起点に。
  near.forceOutsideLeader = true;
  far.forceOutsideLeader = true;
  near.topBandSmallRight = true;
}

/**
 * 「1強(≥90%) + 上左に極小トップ3枚(うち1枚が長名)」型 (例 fund_country_20240710:
 * 日本93.6/ルクセンブルク4.1/ケイマン諸島1.5/ジャージー0.9) で、12時シームに最も近い極小1枚
 * (ジャージー) に topBandSmallRight + forceOutsideLeader を立て、右上へ L 字 leader 付きで逃がす。
 * これにより上左に 3 枚密集して窮屈な状態を解き、残る 2 枚 (ケイマン・ルクセンブルク) は左に留めた
 * まま上方向へ寄る。
 *
 * markForcedTopSliverLeader (総数3・極小2枚型) は両スライバを rank9 へ送る作りで、緩めて流用すると
 * manulife_country を回帰させ、かつ far (ケイマン) まで左放射 leader に巻き込むため別マーカーにする。
 * 右へ動かすのは 12時最寄りの 1 枚のみ・左 2 枚は据え置きとし、leader を反対側へ抜けさせて交差を防ぐ。
 *
 * ルクセンブルク(7文字)は isLong のため下のスライバ抽出 (!isLong) から自動除外され、leader ルーティング
 * 対象にならない (1行化で過剰長体・可読性低下を避ける既存方針)。同帯に長名スライバが 1 枚以上ある事を
 * 「3枚密集のうち1枚が長名」構成の証人として要求し、manulife / world_bond 等と分離する。
 *
 * ゲート (この構成だけに限定):
 *  - leftStackMode / topBandClusterMode でない (≥4 件密集の別系統)
 *  - 最大スライス ≥ 90% (1強)
 *  - 総スライス数 == 4 (1強 + 周辺3枚)
 *  - 上左 (mid>90) の small・top-band(72–108°)・非「その他」・非長名 スライバがちょうど 2 枚
 *  - 同帯に長名の small スライバが 1 枚以上 (= 周辺3枚のうち1枚が長名である証人)
 */
function markForcedTopSliverEscapeRight(left: LayoutItemReady[], diagnostics: Diagnostics): void {
  if (diagnostics.leftStackMode || diagnostics.topBandClusterMode) return;
  if ((diagnostics.rankValuesFull?.[0] ?? 0) < 90) return;
  if (diagnostics.totalCount !== 4) return;
  const slivers = topBandLeftSlivers(left, "small", "exclude");
  if (slivers.length !== 2) return;
  const hasLongTopBandSliver = topBandLeftSlivers(left, "small", "require").length > 0;
  if (!hasLongTopBandSliver) return;
  // 12時(90°)に最も近い 1 枚(=ジャージー)だけを rank9 (buildOutsideLeaderDraft) 起点へ送り、
  // topBandSmallRight で右上 L 字 leader を引かせる。左 2 枚は無印で左に据え置く。
  const near = nearestToTwelveOClock(slivers);
  near.forceOutsideLeader = true;
  near.topBandSmallRight = true;
}

/**
 * 「1強(80–90%) + 上左に極小1枚 + 上中央を『その他』が占有」型 (例 world_bond_idx_asset:
 * 外国債券87.1/外国投資信託11.9/外国債券先物0.2/その他0.8) で、上左に孤立する極小1枚に
 * forceOutsideLeader を立て rank 9 (buildOutsideLeaderDraft) 起点へ送り、自スライス真上付近の
 * 外側リングへ寄せて放射状 leader を引かせる。これをしないと当該極小は leaderless rim ラベルとして
 * 左上隅へ流され、自スライス (≈12時) から大きく乖離したまま線が付かない。
 *
 * markForcedTopSliverLeader (≥90%・3枚・極小2枚型) とは別構成のため専用マーカーにする。緩めて
 * 統合すると asset_domestic_equity 等の正常な lone-sliver (上中央へ既に leader 済) が誤発火する。
 *
 * 上中央/右は『その他』が占有するため topBandSmallRight は立てず、放射 (左寄り) 配置を選ぶ。
 *
 * ゲート (この構成だけに限定):
 *  - leftStackMode / topBandClusterMode でない
 *  - 最大スライスが 80–90% (≥90% は markForcedTopSliverLeader / 高ドミナント lone-sliver の領分)
 *  - 上左 (mid>90) の tiny・top-band(72–108°)・非「その他」・非長名 スライスがちょうど 1 枚
 *  - top-band に percent≥0.5 の『その他』が存在 (上中央の逃げ場を占有している証人)
 *  - 総スライス数 == 4 (多スライス図への波及防止)
 */
function markLoneTopSliverLeader(
  candidates: LayoutItemReady[],
  left: LayoutItemReady[],
  diagnostics: Diagnostics,
): void {
  if (diagnostics.leftStackMode || diagnostics.topBandClusterMode) return;
  const dominant = diagnostics.rankValuesFull?.[0] ?? 0;
  if (dominant < 80 || dominant >= 90) return;
  if (diagnostics.totalCount !== 4) return;
  const slivers = topBandLeftSlivers(left, "tiny", "exclude");
  if (slivers.length !== 1) return;
  const topBandSonohokaOccupied = candidates.some(
    (it) =>
      it.name.startsWith("その他") &&
      angleInBand(normalizeAngle(it.midAngle), 90, TOP_BAND_HALF_WIDTH_DEG) &&
      (it.percent ?? 0) >= 0.5,
  );
  if (!topBandSonohokaOccupied) return;
  // forceOutsideLeader で rank 9 (放射 leader) 起点へ。loneTopSliverLeader は
  // cascadeWithSonohokaPick に「その他を右上へ確定させ中央 box の貫通 suppression を避ける」
  // ことを伝える印 (極小の up-and-over leader が生き残る条件)。
  slivers[0].forceOutsideLeader = true;
  slivers[0].loneTopSliverLeader = true;
}

// 6時 (270°) 中心の「真下中央」帯の半幅 (度)。BOTTOM_BAND_HALF_WIDTH_DEG(18) より狭く、
// |cos| 閾値と併せて「ほぼ真下」のみを拾う。
const BOTTOM_CENTER_HALF_DEG = 8;

/**
 * 6時直下 (mid 270°±BOTTOM_CENTER_HALF_DEG, |cos|<cosTol) の非 dominant スライスを、左右の列に
 * 折らず pie 真下中央へ leaderless で据える印 bottomCenterBelow を立てる。
 * 背景: 当該スライスの rim draft は既に anchor=middle/x≈0/skipLeader=true だが、箱上端が円内へ
 * 食い込むと cascade の pie 侵入判定で leader rank まで降格し、overlap nudge で横へ流れて
 * L 字 leader が付いてしまう。本印付きは buildOutsideRimDraft で「pie 直下へ押し下げた中央配置」を
 * 返し、cascade で pie 侵入降格を免除する。
 * ゲート (ほぼ真下の単独スライスのみに限定): 非 dominant(<80%) / mid 270°±BOTTOM_CENTER_HALF_DEG かつ
 * |cos(mid)|<cosTol / pie 直下 2 行が canvas 下端に収まる高さ / 該当 1 件のみ /
 * !topBandClusterMode かつ !leftStackMode。
 */
function markBottomCenterBelow(
  candidates: LayoutItemReady[],
  diagnostics: Diagnostics,
  cfg: PieLayoutConfig,
): void {
  if (diagnostics.topBandClusterMode || diagnostics.leftStackMode) return;
  const cosTol = 0.06; // 真下付近のみを拾う cos 許容差 (小さいほど真下限定)
  const inBand = (it: LayoutItemReady) =>
    angleInBand(normalizeAngle(it.midAngle), 270, BOTTOM_CENTER_HALF_DEG) &&
    Math.abs(Math.cos(degToRad(it.midAngle))) < cosTol &&
    (it.percent ?? 0) < DOMINANT_BELOW_CENTER_MIN_PCT;
  const cands = candidates.filter(inBand);
  if (cands.length !== 1) return;
  const it = cands[0];
  const clearance = radialFraction(cfg, 0.012, 0.12);
  const boxTop = -(cfg.pieRadius + clearance);
  const boxBottom = boxTop - labelHeightUnits(Math.min(2, it.textLines ?? 2), cfg);
  const tol = 2 / (cfg.mmPerUnit * cfg.svgUnitsPerMm);
  if (boxBottom < cfg.canvasYlim[0] - tol) return;
  it.bottomCenterBelow = true;
}

/**
 * 密集側 (左に小スライスが縦に詰まる leftStackMode の左列) の通常 rim ラベルに
 * denseSideOutsidePush を立てる。buildOutsideRimDraft がこの印を見て rim 半径に
 * cfg.denseSideOutsideRadiusFactor を掛け、その列のラベルだけ円から少し離して窮屈さを緩和する。
 *
 * 対象を leftStackMode の左列に限定し、かつ「その他」や上帯への特殊逃がし (topBandSmallRight /
 * forceOutsideLeader / loneTopSliverLeader / clusterTopBand) と真下中央 (bottomCenterBelow) は
 * 除外する: これらは水平/専用 leader を持ち、半径を伸ばすと『その他』の横 leader 等と新たに交差
 * するため (regression 実測)。inside 行きになる item に立っても buildOutsideRimDraft は通らず無害。
 */
function markDenseSideOutsidePush(
  left: LayoutItemReady[],
  diagnostics: Diagnostics,
): void {
  if (!diagnostics.leftStackMode) return;
  for (const it of left) {
    if (it.name.startsWith("その他")) continue;
    if (it.topBandSmallRight || it.forceOutsideLeader || it.loneTopSliverLeader) continue;
    if (it.clusterTopBand || it.bottomCenterBelow) continue;
    // 上帯 (12時近傍) の小スライスは『その他』の水平 leader と交差しやすく、B (交差修復) の
    // 射程外 (『その他』は上帯扱いで stack 除外) なので押し出さない。
    if (it.isTop) continue;
    it.denseSideOutsidePush = true;
  }
}

/** 各 item の finalX を確定する。 */
function placeX(
  sideItems: LayoutItemReady[],
  side: "left" | "right",
  diagnostics: Diagnostics,
  cfg: PieLayoutConfig,
): void {
  const radius = cfg.scaledLabelRadius;
  const innerRadius = radius - PIE_RADIUS_INSET;
  sideItems.forEach((item) => {
    const y = Math.max(-innerRadius, Math.min(innerRadius, item.finalY));
    const yRatio = Math.abs(y) / radius;
    let xScale = 1.16 - 0.16 * yRatio;
    if (item.isBottom) xScale += 0.03;
    else if (y < cfg.lowerBandYThreshold) xScale += 0.02;
    if (item.isUpperLeft && item.isLong) xScale += 0.02;
    if (item.isUpperLeft) {
      const topTier = Math.max(0, Math.min(1, (150 - item.midAngle) / 60));
      let denseBoost = 0;
      if (diagnostics.modeTags.includes("upper_left_small_dense")) {
        denseBoost += 0.12 + 0.1 * topTier;
        const rank = item.upperLeftRank ?? 0;
        const count = Math.max(1, item.upperLeftCount ?? 1);
        const rankRatio = rank / Math.max(1, count - 1);
        denseBoost += 0.05 * (1 - rankRatio);
      }
      if (diagnostics.upperLeftLongDense) denseBoost += 0.04;
      if (diagnostics.topSmallDense) denseBoost += 0.02;
      if (item.textLines >= 3) denseBoost += 0.04;
      if (item.isVeryLong) denseBoost += 0.03;
      xScale += denseBoost;
    }
    const baseX = Math.sqrt(Math.max(0, radius * radius - y * y));
    const x = baseX * xScale;
    item.finalY = y;
    item.finalX = side === "left" ? -x : x;
  });
}

/** 中央 pie 寄せ風の small slice X spread。 */
function spreadSmallSlicesX(side: "left" | "right", items: LayoutItemReady[], cfg: PieLayoutConfig): void {
  const smalls = items.filter(
    (it) =>
      !it.flipToRight &&
      !it.isUpperLeft &&
      it.percent! < cfg.smallSliceThreshold &&
      Math.abs(it.finalY) > cfg.pieRadius * 0.7,
  );
  if (smalls.length < 3) return;
  smalls.sort((a, b) => b.finalY - a.finalY);
  const innerBound = cfg.scaledLabelRadius + cfg.cornerGap;
  const xMin = side === "left" ? cfg.canvasXlim[0] : innerBound;
  const xMax = side === "left" ? -innerBound : cfg.canvasXlim[1];
  smalls.forEach((it, i) => {
    const t = (i + 0.5) / smalls.length;
    const targetX = xMin + (xMax - xMin) * t;
    it.finalX = it.finalX * 0.4 + targetX * 0.6;
  });
}

/**
 * dominant ≥ DOMINANT_OUTSIDE_EDGE_MIN_PCT (=50%) で 1 行 rim 配置 ("名前 25%") した時に
 * label 端が canvasXlim を超えるかを cascade probe なしのクローズドフォームで判定する。
 * svg_export 側 overrideDominantOutsideEdgeOverflow と等価な発火条件を再現することで、
 * layout 段の upper-left finalY シフト判定にも同じ条件を流用する。
 */
function hasDominantOutsideEdgeOverflow1Line(
  candidates: LayoutItemReady[],
  cfg: PieLayoutConfig,
): boolean {
  const [xmin, xmax] = cfg.canvasXlim;
  // svg_export 側 DOMINANT_OUTSIDE_OVERFLOW_TOLERANCE_PX (=4px) と同値で揃える。
  const tol = 4 / (cfg.mmPerUnit * cfg.svgUnitsPerMm);
  for (const item of candidates) {
    if ((item.percent ?? 0) < DOMINANT_OUTSIDE_EDGE_MIN_PCT) continue;
    const angle = normalizeAngle(item.midAngle ?? 0);
    if (angleInBand(angle, 90, TOP_BAND_HALF_WIDTH_DEG)) continue;
    if (angleInBand(angle, 270, BOTTOM_BAND_HALF_WIDTH_DEG)) continue;
    const cosA = Math.cos(degToRad(angle));
    if (Math.abs(cosA) < DOMINANT_OUTSIDE_ANCHOR_COS_THRESHOLD) continue;
    const widthUnits = visualTextWidthUnits(
      [`${item.name} ${item.percentText ?? ""}`],
      cfg,
    );
    const anchorX = cosA > 0 ? cfg.pieRadius : -cfg.pieRadius;
    const labelRight = cosA > 0 ? anchorX + widthUnits : anchorX;
    const labelLeft = cosA > 0 ? anchorX : anchorX - widthUnits;
    if (labelRight > xmax + tol || labelLeft < xmin - tol) return true;
  }
  return false;
}

// =============================================================================
// 6. layoutLabels — メインエントリ (公開 API)
// =============================================================================
/**
 * items (name/value 配列) からラベル配置結果を返す。
 *
 * 処理順序:
 *   1) 候補生成 + 左右分離
 *   2) 各サイドで縦方向の重なり解消
 *   3) 6 時方向の小スライスを下に押し下げる特別処理
 *   4) 左上が天井を突き抜ける場合は一部を右側に flip (stack を圧縮)
 *   5) 残った左上群の描画用 Y を決定
 *   6) X を確定し、必要に応じて X 反転 (flipToRight / flipToLeft) を適用
 */
export function layoutLabels(items: LayoutItem[], cfg: PieLayoutConfig): LayoutResult {
  const filtered = items.filter((item) => Number.isFinite(Number(item.value)));
  if (filtered.length === 0) {
    throw new Error("At least one item is required.");
  }

  const names = filtered.map((item) => item.name);
  const values = filtered.map((item) => Math.abs(Number(item.value)));
  const signedValues = filtered.map((item) => Number(item.signedValue ?? item.value));
  const compactFlags = filtered.map((item) => Boolean(item.compactLabel));
  const forceFlipFlags = filtered.map((item) => Boolean(item.forceFlipToRight));
  const horizontalLowerLeftFlags = filtered.map((item) =>
    Boolean(item.forceHorizontalLowerLeftDrop),
  );
  const mids = calcMidAngles(values, cfg);
  const { items: candidates, diagnostics } = buildCandidates(
    names,
    values,
    signedValues,
    mids,
    cfg,
    compactFlags,
  );
  for (let i = 0; i < candidates.length; i += 1) {
    if (forceFlipFlags[i]) candidates[i].flipToRight = true;
    if (horizontalLowerLeftFlags[i]) candidates[i].forceHorizontalLowerLeftDrop = true;
  }

  const left = candidates.filter((item) => item.side === "left");
  const right = candidates.filter((item) => item.side === "right");

  resolveSidePositions(left, "left", diagnostics, cfg);
  resolveSidePositions(right, "right", diagnostics, cfg);
  applyBottomSpecial(left, cfg);
  applyBottomSpecial(right, cfg);

  flipUpperLeftStackToRight(left, diagnostics, cfg);

  // 左側密集 (Diagnostics.leftStackMode) 時、左側の非 flip item は cascade を 1 行起点
  // ("名前 25%") で走らせる。`compactLabel`/`textLines=1` は cascade 到達前の幅計測が
  // 1 行レイアウトと整合するように合わせる。「入る分だけ 1 行」方針。
  // 例外: 1 行 "名前 25%" が実 viewBox 左端を越える長名は 1 行強制をスキップして 2 行起点を
  // 維持する。本判定で漏れた中位の超過 (1 行では収まるが overlap で押されて viewBox を越える
  // ラベル) は svg_export 側 overrideOverflowPreferOneLine が描画後に 2 行へ戻して救済する
  // 二段ガード構成。位置 (左帯のどこにあるか) だけで 2 行へ戻すことはしない。
  if (diagnostics.leftStackMode) {
    // 「入る分だけ 1 行」: 1 行 "名前 25%" が実 viewBox (svgWidthPx) の左端に収まるラベルは
    // 1 行優先。可動域 canvasXlim ではなく viewBox 端を境界に使う — rim 配置 (dominantOutsideEdge)
    // も svgWidthPx 基準で判定されるため、ここも揃える。これにより canvasXlim には収まらないが
    // viewBox には収まる中位長ラベルを 1 行化し、短名 2 行/長名 1 行の不揃いを解消する。
    // 真に viewBox を越える長名は 2 行起点を維持し、取りこぼし (1 行では収まるが overlap で
    // 押し出されるもの) は svg_export 側 overrideOverflowPreferOneLine が viewBox 基準で
    // 事後的に 2 行へ戻す。
    const viewBoxLeft = -cfg.svgWidthPx / 2 / cfg.pxPerUnit;
    const deepOverflowTol = 0.04; // ≈ 6 SVG px の安全代
    for (const it of left) {
      if (it.flipToRight || it.flipToLeft) continue;
      const text1 = `${it.name} ${it.percentText ?? ""}`;
      const width1 = visualTextWidthUnits([text1], cfg);
      const cosA = Math.cos(degToRad(it.midAngle));
      const textXRim = cosA * cfg.pieRadius;
      const leftEdge1Line =
        Math.abs(cosA) < 0.15 ? textXRim - width1 / 2 : textXRim - width1;
      if (leftEdge1Line < viewBoxLeft - deepOverflowTol) continue;
      it.preferOneLineCascade = true;
      it.compactLabel = true;
      it.textLines = 1;
    }
  }

  // topBandClusterMode: 12時近傍クラスタ構成員にフラグを立てる。Y順序再割当は
  // svg_export 側 applyTopBandClusterReorder で実施する。
  // flipToRight 済み item も含めて拾う (cascade の rim 配置は flipToRight を参照しないため、
  // flip されていても 12時クラスタ member として並び替え対象にする)
  if (diagnostics.topBandClusterMode) {
    const cluster = left.filter(
      (it) =>
        it.isSmall &&
        Math.abs(it.midAngle - 90) <= 30,
    );
    if (cluster.length >= 4) {
      for (const it of cluster) {
        it.clusterTopBand = true;
        if (Math.abs(it.midAngle - 90) <= 5) it.clusterTopBandBottom = true;
      }
    }
  }

  // 左密集 + dominant outside-edge の 2 行復帰見込みなら、左上スタック全体を下方向にシフト。
  // svg_export 側で dominant 2 行化が成立する条件をクローズドフォームで先回り判定し、
  // 左上のスタック上端に縦の余裕を作る。1 行強制 (preferOneLineCascade=true) はそのまま維持する —
  // 2 行起点に戻すと小スライス同士で leader 交差が増え regression するため、シフトのみで対応。
  if (diagnostics.leftStackMode && hasDominantOutsideEdgeOverflow1Line(candidates, cfg)) {
    const extra = 0.1 * cfg.gapScale;
    for (const it of left) {
      if (it.isUpperLeft && !it.flipToRight) {
        it.finalY = Math.max(cfg.scaledYBottom, (it.finalY ?? 0) - extra);
      }
    }
  }

  assignUpperLeftRenderY(left, diagnostics, cfg);
  markTopBandSmallRight(left, diagnostics);
  markClippedUpperLeftLongDrop(left, diagnostics, cfg);
  markForcedTopSliverLeader(left, diagnostics);
  markForcedTopSliverEscapeRight(left, diagnostics);
  markLoneTopSliverLeader(candidates, left, diagnostics);
  markBottomCenterBelow(candidates, diagnostics, cfg);
  markDenseSideOutsidePush(left, diagnostics);
  placeX(left, "left", diagnostics, cfg);
  placeX(right, "right", diagnostics, cfg);

  spreadSmallSlicesX("left", left, cfg);
  spreadSmallSlicesX("right", right, cfg);

  applyFlipToRight(left, cfg);
  applyBottomFlipToLeft(left, right, cfg);

  return { labels: [...left, ...right], diagnostics };
}
