// =============================================================================
// types.ts — 共通型定義
// -----------------------------------------------------------------------------
// pie-chart 全体で参照する基本データ型。strictNullChecks 有効下で運用するため、
// 段階的に付与されるフィールドは `?` を付け、参照側は `!`/`?.` で扱う。挙動互換を
// 最優先するため、graph 側の JS が許容している型ゆらぎ(undefined / null / 0 等)は
// そのまま受け入れる。
// =============================================================================

/** 入力 1 件 (raw)。Excel / JSON / sample いずれの経路でもこの形に正規化される。 */
export interface Item {
  name: string;
  value: number;
}

/**
 * レイアウト計算を通じて 1 スライスを表す内部型。
 * 入力(name/value) → profile(分類) → candidate(配置座標) → render(描画用 Y / flip)
 * と段階的にフィールドが付与されるため、name/value 以外はすべて optional。
 * **index signature は意図的に持たない**（フィールド名の綴り違いや
 * 型と実体の乖離をコンパイル時に検出するため）。
 */
export interface LayoutItem {
  name: string;
  value: number;
  signedValue?: number;
  percent?: number;
  percentText?: string;
  color?: string;

  // 角度・分類 (buildProfiles)
  midAngle?: number;
  side?: 'left' | 'right';
  isSmall?: boolean;
  isTiny?: boolean;
  isTop?: boolean;
  isBottom?: boolean;
  isUpperLeft?: boolean;
  isUpperRight?: boolean;
  isLong?: boolean;
  isVeryLong?: boolean;
  compactLabel?: boolean;
  estLines?: number;

  // 配置座標 (buildCandidates / resolveSidePositions / placeX)
  anchorX?: number;
  anchorY?: number;
  naturalY?: number;
  textLines?: number;
  finalX?: number;
  finalY?: number;
  upperLeftRenderY?: number;

  // flip / band メタ
  flipToRight?: boolean;
  flipToLeft?: boolean;
  forceFlipToRight?: boolean;
  forceHorizontalLowerLeftDrop?: boolean;

  // 左上スタック メタ (assignUpperLeftMetadata / svg_geom)
  upperLeftRank?: number;
  upperLeftCount?: number;
  upperLeftSmallDense?: boolean;
  upperLeftLongDense?: boolean;
  upperLeftTriad?: boolean;

  // 統一カスケードの rim 配置で textY を自然 rim (sin*pieR) ではなく layout 事前計算の
  // 縦スタック値 `upperLeftRenderY` に置換させる印。`upperLeftTriadEligible` かつ上左 3 件以上で
  // 自然 rim が縦に重なる時のみ `assignUpperLeftRenderY` で立てる (`buildOutsideRimDraft` が参照)。
  useStackRimY?: boolean;

  // 左側密集時 (`Diagnostics.leftStackMode`) に cascade を 1 行起点から開始させるヒント。
  preferOneLineCascade?: boolean;

  // 左側密集 (`leftStackMode`) で、1 行へ降格すると viewBox 左端を見切れる幅広左ラベルを
  // 2 行 (rank ≤ 4) に留める印。`useStackRimY` と同じく `runCascadeOnce` の 1 行降格ガードで
  // 参照する。`runLabelCascade` が「2 行化で chart の不具合数が厳密に減る時だけ」立てて再走させ、
  // 減らなければ revert する do-no-harm 運用 (`leftStackMode` は `upperLeftTriadEligible`=false で
  // `useStackRimY` 対象外のため、その代替として 2 行維持を実現する)。
  keepTwoLineLeftStack?: boolean;

  // 上部「その他」を右上へ第一優先で置く際の、右配置が失敗したラベルの左上フォールバック印。
  // `runLabelCascade` のフォールバックパスで立てると `topBandSonohokaRight` が無効化され左上配置に戻る。
  topRightRejected?: boolean;

  // 12時近傍 (mid 90°±30°) に 4 以上の small slice が集まる `Diagnostics.topBandClusterMode` の
  // 構成員ラベル印。`runLabelCascade` 後段 `applyTopBandClusterReorder` の対象になる。
  clusterTopBand?: boolean;
  // 上記のうち 12時 真近 (mid 90°±5°) のラベル印。クラスタの最下段に追加 gap で固定する対象。
  clusterTopBandBottom?: boolean;

  // 12時直左の小スライス (top-band) が上左で混雑する時、12時に最も近い1件を右上空白へ
  // 逃がす印。`layout.ts` の `markTopBandSmallRight` で立て、`label_placement.ts` の `topBandSmallRight` が
  // 参照して `topBandSonohokaRight` と同じ右上 rim 配置を返す。
  topBandSmallRight?: boolean;

  // 6時直下 (mid 270°±BOTTOM_CENTER_HALF_DEG, |cos|<閾値) の非 dominant スライスを、左右の列に
  // 折らず pie 真下中央へ leaderless で据える印。`layout.ts` の `markBottomCenterBelow` が立て、
  // `label_placement.ts` の `bottomCenterBelow` が参照する。
  bottomCenterBelow?: boolean;

  // 「1強(≥90%)+極小トップ2枚」型 (例 manulife_country) で、上左に並ぶ極小スライスを rim 配置
  // (leaderless)で確定させず rank 9 (`buildOutsideLeaderDraft`) 起点へ強制し leader を引かせる印。
  // `layout.ts` の `markForcedTopSliverLeader` が双方に立て、`index.ts` の `runCascadeOnce` が参照する。
  forceOutsideLeader?: boolean;

  // 9時直近の幅広・長名 上左ラベルが、長体下限でも viewBox 左端を見切れる構成 (例
  // world_bond_idx_currency「オフショア人民元」) で立てる印。`layout.ts` の `markClippedUpperLeftLongDrop`
  // が当該 1 ラベルに付与し、`index.ts` の `runCascadeOnce` が rank 9 起点 (`buildLowerLeftDropLeaderDraft`)
  // へ送る。円が横へ逃げ帯が広い下left (水平軸下) へ 2 行のまま配置し、slice rim から斜めリーダーで
  // 接続する (参考PDF「オーストラリア」配置)。`forceHorizontalLowerLeftDrop` (内側 X クランプ解放) と
  // `twoLineLeftColumn` (condense/relax を viewBox 基準に) を併せて立てる。
  lowerLeftDropLeader?: boolean;

  // 「1強(80–90%) + 上左に極小1枚 + 上中央を『その他』が占有」型 (例 world_bond_idx_asset) の
  // 孤立極小スライス印。`forceOutsideLeader` と併せて `layout.ts` の `markLoneTopSliverLeader` が立てる。
  // この印が立つチャートでは `index.ts` の `cascadeWithSonohokaPick` が『その他』を右上へ確定させ
  // (右逃がし)、極小の up-and-over leader が『その他』の中央 box を貫く suppression を回避する。
  loneTopSliverLeader?: boolean;

  // 密集側 (片側に外側ラベルが多く寄った列) の外側ラベル印。`buildOutsideRimDraft` が
  // rim 半径に `cfg.denseSideOutsideRadiusFactor` を掛けて円から少し離す。
  // `layout.ts` の `markDenseSideOutsidePush` が立てる。
  denseSideOutsidePush?: boolean;

  // 「二分割」型 (例 pdf_510037_01_fund_asset: 投信証券54.3/親投信証券44.6/その他1.0) で、
  // 右半分を占める優勢スライス (最大・≥50%・右) の内側ラベル印。`label_placement.ts` の
  // `computeInsideOptions` が wedge 重心の代わりに右半径中点・縦中央 (cfg.pieRadius/2, 0) へ
  // center を上書きする。`layout.ts` の `markBisectedPie` が立てる。
  bisectedDominantCenter?: boolean;

  // 「1強+小複数」型 (例 currency_balanced_5: 円62/米ドル20/ユーロ9/英5/その他4) の単独優勢スライス
  // (最大・≥50%・<80%・右) の印。`computeInsideOptions` が内側フィットのアンカーを重心 (中心至近で
  // 縁を突き抜ける) から外へ押し出して探索し、bisector 方向の自然位置のまま内側へ収める。中央固定
  // (`bisectedDominantCenter`) はしない。`layout.ts` の `markSingleDominantInside` が立てる。
  singleDominantInside?: boolean;

  // 同「二分割」型の左半分を占める第2スライス (2番目・≥35%・左) の印。外側 rim 配置のまま
  // (テキスト位置不変)、`leader_geometry.ts` の `computeDrawnLeader` が `ALWAYS_DRAW_OUTSIDE_LEADERS`
  // を上書きして leader を消す (スライス直近で冗長なため)。`layout.ts` の `markBisectedPie` が立てる。
  bisectedSecondSliceNoLeader?: boolean;
}

/**
 * `layoutLabels` が返す診断フラグ・件数の集合。フィールドは**全て明示宣言**する
 * (index signature は持たない)。`collectSliceCounts` が出すカウントのうち diag に載せる
 * のは後段で読むものだけ (それ以外はフラグ算出のローカル値に留める)。
 */
export interface Diagnostics {
  modeTags: string[];
  isHighDensity: () => boolean;
  manyItems?: boolean;
  ultraDenseItems?: boolean;
  oneSideDense?: boolean;
  oneSideVeryDense?: boolean;
  topSmallDense?: boolean;
  topTinyDense?: boolean;
  longLabelDense?: boolean;
  lowerGapIsTight?: boolean;
  upperLeftLongDense?: boolean;
  upperRightLongDense?: boolean;
  leftStackMode?: boolean;
  /** 片側 (左) に外側ラベルが多数 (>=6) 寄る過密チャートで、左列を全 2 行のまま canvas 全高の
   *  密ピッチ縦 1 列へ再配置するモード (`applyTwoLineLeftColumn`)。`leftStackMode` (1 行強制) とは
   *  排他で、参考 PDF の「左多数ラベルを全 2 行で密に縦積み」を再現する。 */
  twoLineLeftStackMode?: boolean;
  /** 12時近傍 (mid 90°±30°) に small slice が 4 件以上ある時の専用モード。
   *  `applyTopBandClusterReorder` で Y順序を `midAngle` 順に再割当し、12時 真近 (mid 90°±5°)
   *  ラベルはクラスタ最下段+gap に固定する。
   */
  topBandClusterMode?: boolean;
  forceLowerLeftCompactBand?: boolean;
  keepUpperLeft2Lines?: boolean;
  allowTopBandThreeFlip?: boolean;
  upperLeftTriadEligible?: boolean;
  upperLeftSmallCount?: number;
  /** 左列 (上部「その他」を除く左側ラベル) の件数。`twoLineLeftStackMode` の判定入力。 */
  leftColumnCount?: number;
  upperRightSmallCount?: number;
  bottomSmallCount?: number;
  /** 12時近傍 (mid 90°±30°) かつ small の slice 件数 (`topBandClusterMode` の判定入力)。 */
  topBandClusterCount?: number;
  totalCount?: number;
  rankValuesFull?: number[];
  /** emit 実配置 (最終後段適用後) を内部スコアラ `countDefects` で数えた不具合数。
   *  採点 (`countDefects`, 実描画基準) と emit SVG の一致は `verify_consistency` がアサートする。 */
  finalScore?: { clips: number; crossings: number; pie: number; total: number };
}

/**
 * `buildCandidates` 通過後の LayoutItem。midAngle / anchorX/Y / naturalY / textLines /
 * finalX/Y / upperLeftRenderY / percentText は **必ず** 初期化される (初期値 0 / 算出値) ので、
 * 下流の placement 系・SVG 出力で `!` を付けずに参照できる。
 *
 * 設計意図: `LayoutItem` は段階的に組み立てる "建造中" の状態を表す。`LayoutItemReady`
 * は「buildCandidates が一通り埋め終わった」状態の narrowing 型として隣に置く。
 * 公開 API (`LayoutResult.labels`) も `LayoutItemReady[]` で返す。
 */
export type LayoutItemReady = LayoutItem & {
  midAngle: number;
  anchorX: number;
  anchorY: number;
  naturalY: number;
  textLines: number;
  finalX: number;
  finalY: number;
  upperLeftRenderY: number;
  percentText: string;
};

/** layoutLabels の戻り値。 */
export interface LayoutResult {
  labels: LayoutItemReady[];
  diagnostics: Diagnostics;
}

/**
 * カスケード (`finalizePlacement`) → 後処理 (`post_layout`) → SVG 出力 (`index.ts`) 間で
 * 受け渡すテキスト配置情報。引出線端点・bbox 上下限・各種フラグを保持する。
 */
export interface Placement {
  x: number;
  y: number;
  anchor: 'start' | 'middle' | 'end';
  baseline: 'top' | 'bottom' | 'middle';
  lines: string[];
  item: LayoutItem;
  measured?: { width: number; height: number };
  leaderAnchor: { x: number; y: number };
  leaderBend: { x: number; y: number };
  leaderEndpoint: { x: number; y: number };
  leaderBendFollowsEndpointY: boolean;
  leaderBendFollowsEndpointX: boolean;
  maxTextX?: number;
  minTextX?: number;
  maxTextY?: number;
  minTextY?: number;
  origTextX: number;
  origTextY: number;
  upperLeftHairpinCheck: boolean;
  skipLeader: boolean;
  insideSlice: boolean;
  /** 円外 (rim / leader) 配置由来。emit 段で「遠ければ leader 復活」判定の対象。 */
  dominantOutsideEdge?: boolean;
  /**
   * 名前(2行時=上行 / 1行時=名前部分)に掛ける横方向圧縮率 (長体)。未指定/1 は原寸。
   * `cfg.nameCondenseSteps` (例 [0.7, 0.6]) のいずれか。% 部分は常に原寸。
   */
  nameScaleX?: number;
  /** 1 行レイアウト ("名前 25%") で名前部分のみ圧縮するか。2 行時は常に上行のみで無関係。 */
  condenseNamePortionOnly?: boolean;
  /**
   * 名前を語中で 2 行へ割ったラベルを表すフラグ (lines = [名前前半, 名前後半+" "+%])。語割れ 2 行は
   * pie-chart 全体で廃止したため **現在はどこからも立てない** (常に false/未設定)。2 行救済は名前を割らない
   * 標準 `[名前, %]` 形 (`toTwoLineNamePlacement` / `overrideOverflowPreferOneLine`) のみ。フラグ自体は
   * 幅算定 (`placementExtent`) / emit (`condense.name`) の後方互換のため型に残置する。
   */
  nameSplit?: boolean;
  /**
   * 上部「その他」を右上へ第一優先で配置したラベル。`clampToAnchorSide` の「中心跨ぎ引き戻し」を
   * 免除する (`anchorX` が僅かに負でも右側へ置けるように)。`topBandSonohokaRight` 由来。
   */
  forceTopRight?: boolean;
  /**
   * 円外 rim/leader 配置で pie クリアランスを保証すべきラベル (`draft.pieClearance` 由来)。
   * `clampPlacement` が **現在の y** から pie クリアランス X 上下限を動的に再計算し、
   * viewBox 端制約より優先させる (ラベルが draft より大きい |y| へ動いて円が太くなった位置でも
   * 円内へ食い込まないようにする)。`clampAndBuildPlacement` の静的計算は draft 時点の y で固定
   * されるため、後段で y が動いた時の保証はこのフラグ経由の動的クランプが担う。
   */
  pieClearance?: boolean;
  /**
   * `twoLineLeftStackMode` で円から離して縦積みした左列ラベル。円とラベルの間に隙間を作り
   * リーダー線を見えるようにするため、後段の水平クランプ (`applyVisualViewBoxNudge` /
   * `applyFinalCondenseToFit` / `detectVisualHorizontalOverflow`) は `canvasXlim` の端マージンではなく
   * viewBox 端 (`svgWidthPx`) まで可動域として許す。`applyTwoLineLeftColumn` が立てる。
   */
  twoLineLeftColumn?: boolean;
  /**
   * `applyVerticalDeclipFallback` が縦 spread で上/下へ動かして採用したラベル。リーダーを箱の縦中央
   * (`leaderAttachTargetY`) ではなく **アンカー側の縁の水平中央** (上へ動かした=アンカーが下なら下縁中央)
   * へ接続し、長い斜めリーダーを見やすくする。`computeDrawnLeader` の `alwaysDraw` 経路でのみ効く
   * (描画パス限定・scorer 不変)。フラグを立てるラベルは見切れチャートの移動採用分のみ = 他チャート byte 不変。
   */
  declipBottomLeader?: boolean;
  /**
   * 「二分割」型の第2スライス (左) ラベル印 (`item.bisectedSecondSliceNoLeader` 由来)。
   * `computeDrawnLeader` が `ALWAYS_DRAW_OUTSIDE_LEADERS` を上書きして leader を確定スキップする
   * (スライス直近で線が冗長なため。テキスト位置は不変)。`clampAndBuildPlacement` が item から複写。
   */
  bisectedSecondSliceNoLeader?: boolean;
}

/**
 * createPieLayoutConfig の戻り値。基本フィールド + 多数の派生 getter を**全て明示宣言**する
 * (index signature は持たない)。綴り違いをコンパイル時に検出するため。新しい getter/フィールドを
 * `config.ts` に足したら、ここにも宣言を追加すること。
 */
export interface PieLayoutConfig {
  // 基本フィールド
  baselineFontSize: number;
  svgWidthPx: number;
  svgHeightPx: number;
  pieRadius: number;
  pieHeightRatio: number;
  labelRadius: number;
  startangle: number;
  counterclock: boolean;
  backgroundColor: string;
  fontSize: number;
  fontFamily: string;
  fontWeight: string;
  /** faux-bold: text に塗りと同色の stroke を載せる量 (font-size 比, 0=無効)。advance 不変。 */
  textWeightStrokeRatio: number;
  embedFont: boolean;
  embedFontPath: string;
  embedFontFamilyName: string;
  percentFormat: (value: number) => string;
  lineSpacing: number;
  textColor: string;
  lineColor: string;
  lineWidth: number;
  textRenderScale: number;
  leaderRenderScale: number;
  labelRadiusRenderScale: number;
  // 密集側 (片側に外側ラベルが多く寄った列) の rim ラベル半径倍率。1.0 で従来。密集側だけ
  // ラベルを円から少し離して窮屈さと leader 交差圧を緩和する (`markDenseSideOutsidePush`)。
  denseSideOutsideRadiusFactor: number;
  radialExitRenderScale: number;
  radialExitLen: number;
  yTop: number;
  yBottom: number;
  minGap: number;
  minGapMultiline: number;
  minGapDense: number;
  minGapUltraDense: number;
  smallSliceThreshold: number;
  tinySliceThreshold: number;
  topZoneDeg: number;
  bottomZoneDeg: number;
  denseCountThreshold: number;
  ultraDenseCountThreshold: number;
  oneSideDenseThreshold: number;
  oneSideVeryDenseThreshold: number;
  topSmallDenseThreshold: number;
  topTinyDenseThreshold: number;
  longLabelLen: number;
  veryLongLabelLen: number;
  longLabelDenseThreshold: number;
  lowerDiffSmallThreshold: number;
  compactLabel: boolean;
  insideSliceEnabled: boolean;
  insideSliceClearance: number;
  insideSliceAngularClearanceDeg: number;
  /** 外側ラベルの text bbox と円との最小ギャップ (論理単位 = pieRadius 比)。 */
  pieLabelClearance: number;
  darkSliceTextColor: string;
  darkSliceFillIndexMin: number;
  grayScale4: string[];
  charWidthFactor: number;
  lineHeightFactor: number;
  visualFullwidthEm: number;
  visualHalfwidthEm: number;
  /** 名前(長体)圧縮の試行段。大きい順に試し「収まる最大」を採る。例 [0.7, 0.6]。 */
  nameCondenseSteps: number[];

  // 派生 getter (一部抜粋。実装は `config.ts` を参照)
  readonly fontScale: number;
  readonly geometryScale: number;
  readonly gapScale: number;
  readonly svgUnitsPerMm: number;
  readonly fontSizeUnits: number;
  readonly lineHeightPx: number;
  readonly marginCapPx: number;
  readonly marginCapHorizontalPx: number;
  readonly pieDiameterPx: number;
  readonly pieRadiusPx: number;
  readonly pxPerUnit: number;
  readonly mmPerUnit: number;
  readonly fontSizeMm: number;
  readonly canvasYlim: [number, number];
  readonly canvasXlim: [number, number];
  readonly scaledXlim: [number, number];
  readonly scaledYTop: number;
  readonly scaledYBottom: number;
  readonly scaledLabelRadius: number;
  readonly renderLabelRadius: number;
  readonly scaledRadialExitLen: number;
  readonly renderRadialExitLen: number;
  readonly scaledMinGap: number;
  readonly scaledMinGapMultiline: number;
  readonly scaledMinGapDense: number;
  readonly scaledMinGapUltraDense: number;
  readonly fixedSvgWidthUnits: number;
  readonly fixedSvgHeightUnits: number;
  readonly fixedSvgWidthMm: number;
  readonly fixedSvgHeightMm: number;
  readonly leaderStrokeUnits: number;
  readonly canvasSafetyMargin: number;
  readonly cornerGap: number;
  readonly rightNaturalYOffset: number;
  readonly lowerLeftNaturalYNudge: number;
  readonly leftInitTopInset: number;
  readonly bottomSpecialY: number;
  readonly lowerBandYThreshold: number;
  readonly flipHorizontalCap: number;
  readonly flipPieClearance: number;
  readonly singleSliceLabelOffset: number;
}

/** sample 1 件分の構造 (samples.json)。 */
export interface SampleEntry {
  description?: string;
  items: Item[] | Array<[string, number]>;
}

/** samples.json 全体 */
export type Samples = Record<string, SampleEntry>;

/** 座標変換ヘルパ。論理座標 (pieRadius=1.0) → SVG ピクセル。 */
export type Scale = (v: number) => number;

/** renderPdfStylePieToSvg の戻り値。 */
export interface RenderResult {
  svg: string;
  diagnostics: Diagnostics;
  config: PieLayoutConfig;
}
