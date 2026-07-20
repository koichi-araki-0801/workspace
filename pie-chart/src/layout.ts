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
  radToDeg,
  labelCongestionOffsetDeg,
  isOtherCategory,
  pxToLogical,
} from './svg_geom.js';
import {
  TOP_BAND_HALF_WIDTH_DEG,
  LEFT_STACK_UPPER_ESCAPE_HALF_WIDTH_DEG,
  BOTTOM_BAND_HALF_WIDTH_DEG,
  DOMINANT_OUTSIDE_EDGE_MIN_PCT,
  DOMINANT_OUTSIDE_ANCHOR_COS_THRESHOLD,
  DOMINANT_BELOW_CENTER_MIN_PCT,
  BISECT_SECOND_MIN_PCT,
  BISECT_PAIR_MIN_PCT,
} from './label_placement.js';
import type {
  PieLayoutConfig,
  LayoutResult,
  LayoutItem,
  LayoutItemReady,
  Diagnostics,
} from './types.js';

// =============================================================================
// 1. profiles — slice 分類とプロファイル構築
// =============================================================================

/** 角度から左右どちら側のラベルになるかを判定 */
function classifySide(angle: number): 'left' | 'right' {
  return angle > 90 && angle < 270 ? 'left' : 'right';
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
  return arcAngles(values, cfg).map(({ midAngle }) => normalizeAngle(radToDeg(midAngle)));
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
  anchorMids?: number[],
): { items: LayoutItemReady[]; diagnostics: Diagnostics } {
  const profiles = buildProfiles(names, values, signedValues, mids, cfg, compactFlags);
  const diagnostics = runDiagnostics(profiles, cfg);

  // buildProfiles は midAngle/signedValue/estLines を必ず埋めるため、ここでの `!` は
  // ロジック保証だけが付いている (型上は LayoutItem の optional)。
  // `mids` はラベル配置に使う角(密集回避でオフセット済みのことがある)。`anchorMids` は引出線起点に使う
  // **真のスライス角**(未指定時は同一=従来挙動)。これでラベルだけ回し引出線は実スライスへ斜めに繋ぐ。
  const items: LayoutItemReady[] = profiles.map((profile, index) => {
    const radian = degToRad(profile.midAngle!);
    // anchor 角も buildProfiles と同じく normalizeAngle を通す。これで offset=0 のとき profile.midAngle と
    // ビット単位一致し、回転非対象サンプルの出力が従来と完全同一になる(FP 差で leader 分岐が変わらない)。
    const anchorRadian = degToRad(
      normalizeAngle(anchorMids ? anchorMids[index] : profile.midAngle!),
    );
    const anchorX = Math.cos(anchorRadian) * cfg.pieRadius;
    const anchorY = Math.sin(anchorRadian) * cfg.pieRadius;
    // naturalY は「ラベルが座りたい高さ」なので回転後の角(radian)基準で測る(anchorY ではない)。
    const labelRimY = Math.sin(radian) * cfg.pieRadius;
    let naturalY: number;

    if (profile.side === 'right') {
      naturalY = labelRimY - cfg.rightNaturalYOffset;
    } else if (profile.side === 'left' && labelRimY < 0) {
      naturalY = labelRimY + cfg.lowerLeftNaturalYNudge;
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
    leftCount: countIf((p) => p.side === 'left'),
    rightCount: countIf((p) => p.side === 'right'),
    // 左列 (上部「その他」を除く左側ラベル) の件数。twoLineLeftStackMode の入力。
    leftColumnCount: countIf((p) => p.side === 'left' && !isOtherCategory(p.name)),
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
  if (diag.manyItems) diag.modeTags.push('many_items');
  if (diag.ultraDenseItems) diag.modeTags.push('ultra_dense_items');
  if (diag.oneSideDense) diag.modeTags.push('one_side_dense');
  if (diag.oneSideVeryDense) diag.modeTags.push('one_side_very_dense');
  if (diag.topSmallDense) diag.modeTags.push('top_small_dense');
  if (diag.topTinyDense) diag.modeTags.push('top_tiny_dense');
  if (diag.lowerGapIsTight) diag.modeTags.push('lower_gap_tight');
  if (diag.longLabelDense) diag.modeTags.push('long_label_dense');
  if (diag.upperLeftLongDense) diag.modeTags.push('upper_left_long_dense');
  if (diag.upperRightLongDense) diag.modeTags.push('upper_right_long_dense');
  if (diag.upperLeftSmallCount! >= 3) diag.modeTags.push('upper_left_small_dense');
  if (diag.upperRightSmallCount! >= 3) diag.modeTags.push('upper_right_small_dense');
  if (diag.bottomSmallCount! >= 2) diag.modeTags.push('bottom_small_dense');

  // dominantWithDensePeriphery: 支配 slice (>=50%) + ultra-dense 周辺。
  const dominantWithDensePeriphery =
    diag.rankValuesFull![0] >= 50 &&
    diag.ultraDenseItems &&
    diag.upperLeftSmallCount! >= 3 &&
    diag.totalCount! >= 10;
  if (dominantWithDensePeriphery) diag.modeTags.push('dominantWithDensePeriphery');

  // leftStackMode: 左側 small slice >=4 件で発火する汎用ケース。
  const leftStackMode = diag.upperLeftSmallCount! >= 4;
  diag.leftStackMode = leftStackMode;
  if (leftStackMode) diag.modeTags.push('left_stack');

  // twoLineLeftStackMode: 左列 (その他除く) に外側ラベルが多数 (>=6) 寄る過密チャートで、全 2 行を
  // 維持したまま canvas 全高の密ピッチ縦 1 列へ再配置する (applyTwoLineLeftColumn)。leftStackMode
  // (1 行強制) とは排他。通常カスケードが縦に入りきらず 1 件を 1 行へ降格→左端見切れする症状を、
  // 縦クランプ (scaledLabelRadius) を外して全高を使うことで解消し、参考 PDF の全 2 行縦積みを再現する。
  const twoLineLeftStackMode = !leftStackMode && (diag.leftColumnCount ?? 0) >= 6;
  diag.twoLineLeftStackMode = twoLineLeftStackMode;
  if (twoLineLeftStackMode) diag.modeTags.push('two_line_left_stack');

  // topBandClusterMode: 12時近傍 (mid 90°±30°) に small slice が 4 件以上集まる密集ケース。
  // 12時 真近のスライスを含むと leftStackMode と並行発火する。applyTopBandClusterReorder で
  // Y順序を midAngle 順に並べ替え、12時 真近ラベルはクラスタ最下段+gap に固定する。
  const topBandClusterMode = (diag.topBandClusterCount ?? 0) >= 4;
  diag.topBandClusterMode = topBandClusterMode;
  if (topBandClusterMode) diag.modeTags.push('top_band_cluster');

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
  if (item.isUpperLeft && diagnostics.modeTags.includes('upper_left_small_dense')) {
    gap += 0.07 * cfg.gapScale;
    if (item.textLines >= 2) gap += 0.05 * cfg.gapScale;
    if (item.textLines >= 3 || item.isLong) gap += 0.05 * cfg.gapScale;
    if (item.textLines >= 3) gap += 0.08 * cfg.gapScale;
  }
  return gap;
}

/** 隣接ペアに必要な gap。両者ともマルチライン時は更に余裕を持たせる。 */
function pairGap(
  a: LayoutItemReady,
  b: LayoutItemReady,
  diagnostics: Diagnostics,
  cfg: PieLayoutConfig,
): number {
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
function setInitialFinalY(
  sideItems: LayoutItemReady[],
  side: 'left' | 'right',
  cfg: PieLayoutConfig,
): void {
  const yInitTop = side === 'right' ? cfg.scaledYTop : cfg.scaledYTop - cfg.leftInitTopInset;
  sideItems.forEach((item) => {
    item.finalY = Math.max(cfg.scaledYBottom, Math.min(yInitTop, item.naturalY));
  });
}

/** 右側のみの上→下 + 下→上 の 2 パス重なり解消 (端でクランプ)。 */
function resolveRightSidePositions(
  sideItems: LayoutItemReady[],
  diagnostics: Diagnostics,
  cfg: PieLayoutConfig,
): void {
  sideItems.sort((a, b) => Math.sin(degToRad(b.midAngle)) - Math.sin(degToRad(a.midAngle)));
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
function resolveLeftSidePositions(
  sideItems: LayoutItemReady[],
  diagnostics: Diagnostics,
  cfg: PieLayoutConfig,
): void {
  const upper = sideItems.filter((item) => item.naturalY > 0).sort((a, b) => a.finalY - b.finalY);
  const lower = sideItems.filter((item) => item.naturalY <= 0).sort((a, b) => b.finalY - a.finalY);

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
  side: 'left' | 'right',
  diagnostics: Diagnostics,
  cfg: PieLayoutConfig,
): void {
  if (sideItems.length === 0) return;
  setInitialFinalY(sideItems, side, cfg);
  if (side === 'right') {
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
  let stackTop = Math.sin(degToRad(bottom.midAngle)) + upperLeftMinRiseBase(bottom.midAngle, cfg);
  for (let i = 1; i < sorted.length; i += 1) {
    const linesA = forceOneLine ? 1 : sorted[i - 1].textLines;
    const linesB = forceOneLine ? 1 : sorted[i].textLines;
    stackTop += upperLeftStackGap(linesA, linesB, cfg);
  }
  return stackTop;
}

/** 残候補のうち midAngle が (minDeg, maxDeg] にあり、90° に最も近いものを返す。 */
function pickFlipCandidate(
  remaining: LayoutItemReady[],
  minDeg: number,
  maxDeg: number,
): LayoutItemReady | null {
  const candidates = remaining.filter((item) => item.midAngle > minDeg && item.midAngle <= maxDeg);
  if (candidates.length === 0) return null;
  return candidates.reduce((best, current) => (current.midAngle < best.midAngle ? current : best));
}

/**
 * 6 時近辺で右側に来た小スライスを左側へ flip。さらに既存左側 item と
 * 縦位置が近い場合は左側を上へ追い出して衝突を回避する。
 */
function applyBottomFlipToLeft(
  left: LayoutItemReady[],
  right: LayoutItemReady[],
  cfg: PieLayoutConfig,
): void {
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
  const refAngleDeg = radToDeg(Math.asin(sinThreshold));
  return 180 - refAngleDeg;
}

/**
 * 左上群が天井を超えた場合、トップバンド寄りの item を右側へ flip して stack を圧縮する。
 */
function flipUpperLeftStackToRight(
  left: LayoutItemReady[],
  diagnostics: Diagnostics,
  cfg: PieLayoutConfig,
): void {
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
    .sort((a, b) => a.tier! - b.tier! || a.item.midAngle - b.item.midAngle);

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
    diagnostics.modeTags.includes('upper_left_small_dense') &&
    remaining.length >= flipDensePass3Threshold(cfg)
  ) {
    const toFlip = pickFlipCandidate(remaining, FLIP_PRIMARY_MAX_DEG, flipDenseExtendedMaxDeg(cfg));
    if (toFlip != null) {
      toFlip.flipToRight = true;
      remaining = remaining.filter((i) => i !== toFlip);
    }
  }

  // allowTopBandThreeFlip: もう 1 件追加 flip。
  if (diagnostics.allowTopBandThreeFlip && remaining.length >= flipAllowThreeMinRemaining(cfg)) {
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
  const upperLeftTriadActive = upper.length === 3 && diagnostics.upperLeftTriadEligible === true;
  if (upperLeftTriadActive && !diagnostics.modeTags.includes('upperLeftTriad')) {
    diagnostics.modeTags.push('upperLeftTriad');
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
  const upper = [
    ...sideItems.filter((item) => item.isUpperLeft && !item.flipToRight && !item.topBandSmallRight),
  ].sort((a, b) => a.finalY - b.finalY);
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
 * 統一カスケード rim 配置向け: upperLeftTriadEligible かつ上左 2 件以上で、自然 rim
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
    (it) =>
      it.isUpperLeft &&
      !it.flipToRight &&
      !it.topBandSmallRight &&
      Number.isFinite(it.upperLeftRenderY),
  );
  if (eligible.length < 2) return;
  const overlapTol = pxToLogical(cfg, 8);
  const minSep = labelHeightUnits(2, cfg) + overlapTol;
  const rimY = (it: LayoutItemReady) => Math.sin(degToRad(it.midAngle)) * cfg.pieRadius;
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
  size: 'small' | 'tiny',
  long: 'exclude' | 'require',
): LayoutItemReady[] {
  return items.filter(
    (it) =>
      (size === 'tiny' ? it.isTiny : it.isSmall) &&
      it.midAngle > 90 &&
      angleInBand(normalizeAngle(it.midAngle), 90, TOP_BAND_HALF_WIDTH_DEG) &&
      !isOtherCategory(it.name) &&
      (long === 'require' ? it.isLong : !it.isLong),
  );
}

/**
 * leftStackMode / topBandClusterMode いずれかの密集別系統モードか。mark*** 系の共通除外ゲート
 * (≥4 件密集はそれぞれ専用の再配置を持つため、1強型の特例マーカーは発火させない)。
 */
function isDenseClusterMode(diag: Diagnostics): boolean {
  return diag.leftStackMode === true || diag.topBandClusterMode === true;
}

/**
 * 1強チャート判定: 最大スライス (`rankValuesFull` 先頭) が minPct% 以上を占めるか。mark*** 系の
 * ドミナント帯ゲート。閾値 (90 / 80 / 80–90 帯) はサンプル対応の履歴と共に呼び出し側へ残す —
 * 定数へ集約すると「どのサンプルがどの帯で発火するか」の文脈がゲートから見えなくなる。
 */
function isDominantTop(diag: Diagnostics, minPct: number): boolean {
  return (diag.rankValuesFull?.[0] ?? 0) >= minPct;
}

// -----------------------------------------------------------------------------
// 混雑の幾何計測。mark*** 系の発火ゲートを「スライス枚数・％の列挙」から「画面上の混雑そのもの」へ
// 寄せるための測定関数。いずれもチャート寸法に対する無次元比を返し、px 直値も枚数も含まない
// (同じ見た目のチャートには同じ判定が出る、が設計目標)。`resolveSidePositions` の後に呼ぶこと
// (finalY が確定していないと変位が測れない)。
// -----------------------------------------------------------------------------

/**
 * その側のラベルが「真のスライス角の Y (`naturalY`)」からどれだけ押しのけられたかの平均量を、
 * ラベル 1 行の高さで割った無次元値。縦の押し合いが起きているかを直接測る。
 *
 * 0 に近い = 各ラベルが自スライスの正面に座れている。1 を超える = 平均で 1 行分以上ずれており、
 * 引出線が放射方向を向かなくなる (どのスライス由来か読めない短スタブが出る条件)。
 */
function sideStackDisplacement(sideItems: LayoutItemReady[], cfg: PieLayoutConfig): number {
  if (sideItems.length === 0) return 0;
  const total = sideItems.reduce((sum, it) => sum + Math.abs(it.finalY - it.naturalY), 0);
  return total / sideItems.length / labelHeightUnits(1, cfg);
}

/**
 * その側のラベル列を縦に並べるのに必要な長さ ÷ 縦の使用可能長 (`scaledYTop`〜`scaledYBottom`)。
 * 必要長は **各ラベル箱の高さ + 箱間の最小ギャップ** で、これは「入るか入らないか」の式そのもの。
 *
 * 1 を超える = どう並べても入らない = 必ず押し合いが起きる、という幾何的に意味のある境界になる。
 * 逆に逃がし先として使える側かの判定にも使う (小さいほど空いている)。
 *
 * 内側配置になるか外側リムに出るかは cascade が後で決めるため、ここでは**全 item を占有として数える**
 * (保守側: 反対側に item が多いチャートへは逃がさない)。
 */
function sideColumnPackingRatio(sideItems: LayoutItemReady[], cfg: PieLayoutConfig): number {
  const span = cfg.scaledYTop - cfg.scaledYBottom;
  if (span <= 0) return 1;
  const boxes = sideItems.reduce((sum, it) => sum + labelHeightUnits(it.textLines, cfg), 0);
  const gaps = Math.max(0, sideItems.length - 1) * cfg.scaledMinGap;
  return (boxes + gaps) / span;
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
 * 立てて右上空白へ逃がす (`label_placement.ts` の `topBandSmallRight` が参照)。これにより上左に小
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
      !isOtherCategory(it.name) &&
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
    if (isOtherCategory(it.name)) return false;
    if (!angleInBand(normalizeAngle(it.midAngle), 180, 30)) return false;
    const width = scaledLabelWidthUnits(it.name, it.percentText ?? '', 2, floorScale, cfg);
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
 * 「1強スライス + 上左 top-band に極小スライバ」型チャートで、極小スライバに leader を引かせる/
 * 右上へ逃がすフラグを立てる 4 構成をテーブル駆動で判定する。元は独立 4 マーカー
 * (`markForcedTopSliverLeader` / `markForcedTopSliverEscapeRight` / `markLoneTopSliverLeader` /
 * `markDominantTopSliverWithOther`) で、共通骨格 (denseCluster 除外 → dominant 帯 → 総数 →
 * top-band スライバ収集 → 枚数 → witness → フラグ付与) をルール表 `TOP_BAND_SLIVER_RULES` へ
 * 集約したもの。
 *
 * 各構成は 1〜2 サンプルの狭い形状にだけ発火する (各ルールの `example`)。ゲートの数値
 * (dominant 帯 / 総数 / スライバ枚数 / witness) が構成を分離しており、緩めると隣の構成を回帰させる
 * — テーブルは緩和ではなく「どの形状にどの配置」の一覧化。全ルールを順に評価する (元の 4 関数を順に
 * 呼ぶのと等価。ゲートは排他的なので実際は 1 つだけ発火する)。
 *
 * `apply` の配置差 (フラグの組合せ → 下流 leader 形状):
 *  - `nearFarSplit`: near を右上 L 字 (`topBandSmallRight`)・far を左上放射 (`forceOutsideLeader` のみ)。
 *    左右へ振り分けて互いの riser 交差を防ぐ (near/far は 12時距離で決める)。
 *  - `nearEscapeRight`: 12時最寄り 1 枚だけ右上 L 字、残りは左に据え置く。
 *  - `loneRadialWithSonohoka`: 1 枚を放射 leader + `loneTopSliverLeader`
 *    (`cascadeWithSonohokaPick` へ「その他」右上確定を伝える副作用印)。
 *  - `dominantRadial`: 1 枚を放射 leader のみ (その他は無印で既存右上経路を維持)。
 */
interface TopBandSliverRule {
  readonly example: string;
  readonly domMinPct: number;
  readonly domMaxExclusivePct?: number;
  readonly totalCount: number;
  readonly sliverSize: 'small' | 'tiny';
  readonly sliverCount: number;
  readonly witness: (left: LayoutItemReady[], candidates: LayoutItemReady[]) => boolean;
  readonly apply: (slivers: LayoutItemReady[]) => void;
}

// near (12時最寄り) を右上 L 字・far (12時最遠) を左上放射へ振り分ける。
// 元 `markForcedTopSliverLeader`。1 行化の過剰長体を避けるため witness 側で長名を除外済み。
const nearFarSplit = (slivers: LayoutItemReady[]): void => {
  let near = slivers[0];
  let far = slivers[0];
  for (const it of slivers) {
    if (Math.abs(it.midAngle - 90) < Math.abs(near.midAngle - 90)) near = it;
    if (Math.abs(it.midAngle - 90) > Math.abs(far.midAngle - 90)) far = it;
  }
  near.forceOutsideLeader = true;
  far.forceOutsideLeader = true;
  near.topBandSmallRight = true;
};

const nearEscapeRight = (slivers: LayoutItemReady[]): void => {
  const near = nearestToTwelveOClock(slivers);
  near.forceOutsideLeader = true;
  near.topBandSmallRight = true;
};

const loneRadialWithSonohoka = (slivers: LayoutItemReady[]): void => {
  slivers[0].forceOutsideLeader = true;
  slivers[0].loneTopSliverLeader = true;
};

const dominantRadial = (slivers: LayoutItemReady[]): void => {
  slivers[0].forceOutsideLeader = true;
};

const TOP_BAND_SLIVER_RULES: readonly TopBandSliverRule[] = [
  // manulife_country (日本99.3/フランス0.6/米国0.1): 極小2枚を左右へ振り分け。
  {
    example: 'manulife_country',
    domMinPct: 90,
    totalCount: 3,
    sliverSize: 'small',
    sliverCount: 2,
    witness: () => true,
    apply: nearFarSplit,
  },
  // fund_country_20240710 (日本93.6/ルクセンブルク4.1/ケイマン1.5/ジャージー0.9):
  // 周辺3枚のうち1枚が長名 (ルクセンブルク=isLong で抽出外) である事を証人に、12時最寄り1枚を右上へ。
  {
    example: 'fund_country_20240710',
    domMinPct: 90,
    totalCount: 4,
    sliverSize: 'small',
    sliverCount: 2,
    witness: (left) => topBandLeftSlivers(left, 'small', 'require').length > 0,
    apply: nearEscapeRight,
  },
  // world_bond_idx_asset (外国債券87.1/外国投資信託11.9/外国債券先物0.2/その他0.8):
  // 80–90% + top-band の「その他」≥0.5 が上中央を占有。孤立極小1枚を放射 leader へ。
  {
    example: 'world_bond_idx_asset',
    domMinPct: 80,
    domMaxExclusivePct: 90,
    totalCount: 4,
    sliverSize: 'tiny',
    sliverCount: 1,
    witness: (_left, candidates) =>
      candidates.some(
        (it) =>
          isOtherCategory(it.name) &&
          angleInBand(normalizeAngle(it.midAngle), 90, TOP_BAND_HALF_WIDTH_DEG) &&
          (it.percent ?? 0) >= 0.5,
      ),
    apply: loneRadialWithSonohoka,
  },
  // jp_equity_idx_asset (国内株式98.2/先物1.7/その他0.1): 極小2枚の片方が「その他」。
  // 非「その他」極小1枚を放射 leader へ (その他は無印で既存右上経路)。
  {
    example: 'jp_equity_idx_asset',
    domMinPct: 90,
    totalCount: 3,
    sliverSize: 'small',
    sliverCount: 1,
    witness: (_left, candidates) =>
      candidates.some(
        (it) =>
          isOtherCategory(it.name) &&
          it.isSmall &&
          angleInBand(normalizeAngle(it.midAngle), 90, TOP_BAND_HALF_WIDTH_DEG),
      ),
    apply: dominantRadial,
  },
];

function markTopBandSlivers(
  candidates: LayoutItemReady[],
  left: LayoutItemReady[],
  diagnostics: Diagnostics,
): void {
  if (isDenseClusterMode(diagnostics)) return;
  for (const r of TOP_BAND_SLIVER_RULES) {
    if (!isDominantTop(diagnostics, r.domMinPct)) continue;
    if (r.domMaxExclusivePct !== undefined && isDominantTop(diagnostics, r.domMaxExclusivePct)) {
      continue;
    }
    if (diagnostics.totalCount !== r.totalCount) continue;
    const slivers = topBandLeftSlivers(left, r.sliverSize, 'exclude');
    if (slivers.length !== r.sliverCount) continue;
    if (!r.witness(left, candidates)) continue;
    r.apply(slivers);
  }
}

/**
 * 左列が縦に詰まりきったチャートで、上左の小スライス最大 `count` 枚を右上の空白へ逃がす。
 *
 * 症状: 左列が縦の使用可能長を超えて詰め込まれると、各ラベルが真のスライス角から押しのけられ、
 * pie クリアランスと viewBox 端に挟まれて横にも動けなくなる。結果として引出線が円縁に沿った
 * 短いスタブになり、平行に並んだ隣同士でどちらのスライス由来か読めなくなる
 * (`svg_export/leader_geometry.ts` の `countBundledRimStubs` が数える形)。逃がして左列の枚数を
 * 減らすと、残るラベルが自スライスの正面へ戻り引出線が放射方向を向く。
 *
 * ゲートは **混雑の幾何計測だけ** で書く (枚数・％の列挙をしない):
 *  - 左列の占有率 > 1 (`sideRimOccupancy`) = 縦に入りきらず必ず押し合いが起きている
 *  - 左列の平均変位 > 1 行 (`sideStackDisplacement`) = 実際にスライス角から離れている
 *  - 右側の占有率 < 1/2 (`sideRimOccupancy`) = 逃がし先のリムが空いている
 *  - `!topBandClusterMode` (専用の再配置を持つ別モードとの二重発火防止)
 *
 * 何枚逃がすかはここでは決めない。`svg_export/index.ts` の `pickLeftStackUpperEscape` が 0 枚から
 * 増やして do-no-harm で選ぶ。配置座標は既存 `topRightLiftedRimDraft` 経路をそのまま使う。
 */
function markLeftStackUpperEscapeRight(
  left: LayoutItemReady[],
  right: LayoutItemReady[],
  diagnostics: Diagnostics,
  cfg: PieLayoutConfig,
  count: number,
): void {
  if (count <= 0) return;
  if (diagnostics.topBandClusterMode === true) return;
  if (sideColumnPackingRatio(left, cfg) <= 1) return;
  if (sideStackDisplacement(left, cfg) <= 1) return;
  if (sideColumnPackingRatio(right, cfg) >= 0.5) return;
  const candidates = leftStackUpperEscapeCandidates(left);
  // forceOutsideLeader で rank 9 起点 (buildOutsideLeaderDraft) = 1 行フォーム。右上の縦余白は
  // 冠〜viewBox 上端で約 2 箱分しかなく、2 行だと積んだ下段が円に食い込む
  // (`markLeftStackTopBandEscapeRight` と同じ理由)。
  for (const it of candidates.slice(0, count)) {
    it.topBandSmallRight = true;
    it.forceOutsideLeader = true;
    it.flipToRight = false;
  }
}

/**
 * `markLeftStackUpperEscapeRight` の逃がし候補を 12時に近い順で返す。帯は上左象限 (90–180°) の
 * 12時側の半分 = 90〜135°。これより 9時寄りのスライスを右上へ渡すと引出線がチャート上部を横断する
 * 長い横線になるため、象限の半分が自然な上限になる。「その他」は専用経路 (`topBandSonohokaRight`)
 * を持つので除外、既に別マーカーが逃がし済の item も対象外にして経路の二重適用を防ぐ。
 */
function leftStackUpperEscapeCandidates(left: LayoutItemReady[]): LayoutItemReady[] {
  return left
    .filter(
      (it) =>
        it.isSmall &&
        it.midAngle > 90 &&
        angleInBand(normalizeAngle(it.midAngle), 90, LEFT_STACK_UPPER_ESCAPE_HALF_WIDTH_DEG) &&
        !isOtherCategory(it.name) &&
        !it.topBandSmallRight,
    )
    .sort((a, b) => Math.abs(a.midAngle - 90) - Math.abs(b.midAngle - 90));
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
  const tol = pxToLogical(cfg, 2);
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
function markDenseSideOutsidePush(left: LayoutItemReady[], diagnostics: Diagnostics): void {
  if (!diagnostics.leftStackMode) return;
  for (const it of left) {
    if (isOtherCategory(it.name)) continue;
    if (it.topBandSmallRight || it.forceOutsideLeader || it.loneTopSliverLeader) continue;
    if (it.clusterTopBand || it.bottomCenterBelow) continue;
    // 上帯 (12時近傍) の小スライスは『その他』の水平 leader と交差しやすく、B (交差修復) の
    // 射程外 (『その他』は上帯扱いで stack 除外) なので押し出さない。
    if (it.isTop) continue;
    it.denseSideOutsidePush = true;
  }
}

/**
 * 「二分割」型 (上位2スライスが円のほぼ全体を占める) を検知し、2 つの印を立てる。
 *   - 優勢 (最大・≥`DOMINANT_OUTSIDE_EDGE_MIN_PCT`%・右): `bisectedDominantCenter` → 内側ラベルを
 *     右半径中点・縦中央へ
 *   - 第2 (2番目・≥`BISECT_SECOND_MIN_PCT`%・左): `bisectedSecondSliceNoLeader` → rim leader を消す
 * 成立条件は最大 ≥50%・第2 ≥25%・両者合算 ≥`BISECT_PAIR_MIN_PCT`(90%)。残りスライスの個別条件は
 * 不要 (合算 ≥90% で残り合計は ≤10%、`s1≥25` は `s0≤75<80` を保証し 1強型を自動除外)。例 54.3/44.6・
 * 55.6/36.7/7.7・67/33・72/28。`startangle=90`+時計回りで最大は右・第2は左に来るが、念のため side でも検証。
 */
function markBisectedPie(candidates: LayoutItemReady[]): void {
  if (candidates.length < 2) return;
  const byPct = [...candidates].sort((a, b) => (b.percent ?? 0) - (a.percent ?? 0));
  const s0 = byPct[0];
  const s1 = byPct[1];
  if ((s0.percent ?? 0) < DOMINANT_OUTSIDE_EDGE_MIN_PCT) return;
  if ((s1.percent ?? 0) < BISECT_SECOND_MIN_PCT) return;
  if ((s0.percent ?? 0) + (s1.percent ?? 0) < BISECT_PAIR_MIN_PCT) return;
  if (s0.side !== 'right' || s1.side !== 'left') return;
  s0.bisectedDominantCenter = true;
  s1.bisectedSecondSliceNoLeader = true;
}

/**
 * 「1強+小複数」型 (二分割に非該当の単独優勢) を検知し `singleDominantInside` を立てる。
 * 最大スライスが右・50–80% で、`markBisectedPie` が立てる二分割中央配置の対象外のとき、
 * 内側フィットのアンカーを外へ押し出して bisector 方向の自然位置のまま内側へ収める
 * (中央固定はしない)。≥80% は既存の真下中央パスへ、<50% は外側のまま。
 * `markBisectedPie` の後に呼び、二分割で確定済の s0 は再マークしない。
 */
function markSingleDominantInside(candidates: LayoutItemReady[]): void {
  if (candidates.length < 2) return;
  const s0 = [...candidates].sort((a, b) => (b.percent ?? 0) - (a.percent ?? 0))[0];
  if (s0.bisectedDominantCenter) return;
  if (s0.side !== 'right') return;
  const pct = s0.percent ?? 0;
  if (pct < DOMINANT_OUTSIDE_EDGE_MIN_PCT) return;
  if (pct >= DOMINANT_BELOW_CENTER_MIN_PCT) return;
  s0.singleDominantInside = true;
}

/** 各 item の finalX を確定する。 */
function placeX(
  sideItems: LayoutItemReady[],
  side: 'left' | 'right',
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
      if (diagnostics.modeTags.includes('upper_left_small_dense')) {
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
    item.finalX = side === 'left' ? -x : x;
  });
}

/** 中央 pie 寄せ風の small slice X spread。 */
function spreadSmallSlicesX(
  side: 'left' | 'right',
  items: LayoutItemReady[],
  cfg: PieLayoutConfig,
): void {
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
  const xMin = side === 'left' ? cfg.canvasXlim[0] : innerBound;
  const xMax = side === 'left' ? -innerBound : cfg.canvasXlim[1];
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
  const tol = pxToLogical(cfg, 4);
  for (const item of candidates) {
    if ((item.percent ?? 0) < DOMINANT_OUTSIDE_EDGE_MIN_PCT) continue;
    const angle = normalizeAngle(item.midAngle ?? 0);
    if (angleInBand(angle, 90, TOP_BAND_HALF_WIDTH_DEG)) continue;
    if (angleInBand(angle, 270, BOTTOM_BAND_HALF_WIDTH_DEG)) continue;
    const cosA = Math.cos(degToRad(angle));
    if (Math.abs(cosA) < DOMINANT_OUTSIDE_ANCHOR_COS_THRESHOLD) continue;
    const widthUnits = visualTextWidthUnits([`${item.name} ${item.percentText ?? ''}`], cfg);
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
export function layoutLabels(
  items: LayoutItem[],
  cfg: PieLayoutConfig,
  labelRotateOverrideDeg?: number,
  upperEscapeCount = 0,
): LayoutResult {
  const filtered = items.filter((item) => Number.isFinite(Number(item.value)));
  if (filtered.length === 0) {
    throw new Error('At least one item is required.');
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
  // 左下密集を検知したら、扇形は固定のままラベルの配置角だけを反時計回りへ少しずつ回す
  // (中国を右下・フランスを旧・中国位置へ…の挙動)。引出線は真のスライス角 `mids` に繋ぎ続ける。
  // `labelRotateOverrideDeg` 明示時はそれを使う(呼び出し側の do-no-harm 比較で 0=非回転を試すため)。
  const labelOffset =
    labelRotateOverrideDeg !== undefined
      ? labelRotateOverrideDeg
      : cfg.counterclock
        ? 0
        : labelCongestionOffsetDeg(values, names, cfg);
  // `その他` は円内(inside-slice)に留めたいので回転対象から外す(配置角=真のスライス角のまま)。
  const labelMids =
    labelOffset === 0
      ? mids
      : mids.map((m, i) => (isOtherCategory(names[i]) ? m : normalizeAngle(m + labelOffset)));
  const { items: candidates, diagnostics } = buildCandidates(
    names,
    values,
    signedValues,
    labelMids,
    cfg,
    compactFlags,
    mids,
  );
  for (let i = 0; i < candidates.length; i += 1) {
    if (forceFlipFlags[i]) candidates[i].flipToRight = true;
    if (horizontalLowerLeftFlags[i]) candidates[i].forceHorizontalLowerLeftDrop = true;
  }

  const left = candidates.filter((item) => item.side === 'left');
  const right = candidates.filter((item) => item.side === 'right');

  resolveSidePositions(left, 'left', diagnostics, cfg);
  resolveSidePositions(right, 'right', diagnostics, cfg);
  applyBottomSpecial(left, cfg);
  applyBottomSpecial(right, cfg);

  flipUpperLeftStackToRight(left, diagnostics, cfg);
  // leftStackMode で右リムが空く非 dominant 形状は、12時最寄りの小スライス最大2枚を右上へ逃がす
  // (topBandSmallRight)。assignUpperLeftRenderY / 1 行強制 / flip 前に立て、escapee を上左スタックから
  // 除外して残りを上方向へ再分配する。
  // 左列が縦に入りきらないチャートの上左小スライスを右上へ逃がす (枚数は呼び出し側の探索が決める)。
  // 上の専用マーカーと同じく assignUpperLeftRenderY / 1 行強制 / flip より前に立てる必要がある。
  diagnostics.upperEscapeCandidateCount = leftStackUpperEscapeCandidates(left).length;
  markLeftStackUpperEscapeRight(left, right, diagnostics, cfg, upperEscapeCount);

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
      if (it.flipToRight || it.flipToLeft || it.topBandSmallRight) continue;
      const text1 = `${it.name} ${it.percentText ?? ''}`;
      const width1 = visualTextWidthUnits([text1], cfg);
      const cosA = Math.cos(degToRad(it.midAngle));
      const textXRim = cosA * cfg.pieRadius;
      const leftEdge1Line = Math.abs(cosA) < 0.15 ? textXRim - width1 / 2 : textXRim - width1;
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
    const cluster = left.filter((it) => it.isSmall && Math.abs(it.midAngle - 90) <= 30);
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
  markTopBandSlivers(candidates, left, diagnostics);
  markBottomCenterBelow(candidates, diagnostics, cfg);
  markDenseSideOutsidePush(left, diagnostics);
  markBisectedPie(candidates);
  markSingleDominantInside(candidates);
  placeX(left, 'left', diagnostics, cfg);
  placeX(right, 'right', diagnostics, cfg);

  spreadSmallSlicesX('left', left, cfg);
  spreadSmallSlicesX('right', right, cfg);

  applyFlipToRight(left, cfg);
  applyBottomFlipToLeft(left, right, cfg);

  return { labels: [...left, ...right], diagnostics };
}
