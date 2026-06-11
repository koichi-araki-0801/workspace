# graph2

TypeScript 製の円グラフ SVG レンダラ。`{name, value}` の配列(JSON / Excel / サンプル)を入力に、ラベルと引出線を自動配置した円グラフ SVG を生成する。2〜3 人チームでメンテしやすい粒度にモジュール分割している。
`out/svg_js/` の SVG 出力は 87 サンプルの回帰テスト (`verify_svg.ts`) で検証する。
**レンダリング層は外部ライブラリ依存ゼロ**(D3.js 等は不採用)。Excel 入力のみ `exceljs`、フォント埋込のみ `subset-font` に依存し、それぞれ入力層・フォント層に隔離している。

## セットアップ

```bash
npm install
npm run check   # tsc --noEmit で型チェック
npm run batch   # tsx test_batch.ts — 87 サンプル一括生成
npm run verify  # tsx verify_svg.ts — 自動検証
```

## 使い方

### CLI

CLI は `npm run cli -- <command>`(または直接 `tsx cli.ts <command>`)で実行する。

- `npm run cli -- list`
- `npm run cli -- one --sample asset_gbca_pdf_like --output-file out/test.svg`
- `npm run cli -- one --data-file data/example.json --output-file out/test.svg`
- `npm run cli -- one --data-json '[{"name":"A","value":60},{"name":"B","value":40}]' --output-file out/test.svg`
- `npm run cli -- one --xlsx data.xlsx --sheet Sheet1 --range A2:B11 --output-file out/test.svg`
- `npm run cli -- batch --output-dir out/svg`
- `npm run cli -- batch --input-dir data --output-dir out/svg`

`one` の入力は `--sample` / `--data-file` / `--data-json` / `--xlsx + --sheet + --range` のいずれか(`--output-file` 必須)。`batch` は既定で全サンプル、`--samples a,b,c` で対象を絞れる。`--input-dir` 指定時はそのディレクトリ内の `*.json` を一括処理する。

#### Excel 入力の決まり

- `--range` は 2 列固定(左=name、右=value)。3 列以上 / 1 列はエラー。
- **ヘッダ行は指定しない**(データ行のみ渡す)。先頭行が「区分」「比率」のような文字列だと `Non-numeric value at row N` で落ちる。
- 空行はスキップ、name 空欄や value 数値変換不可は明示エラー。
- 数式セルは結果値、リッチテキスト/ハイパーリンクも展開して取り込む。
- exceljs 依存は `src/xlsx_loader.ts` に隔離(`parseRange` / `loadXlsxItems`)。

### 全件生成 + ビューア

- `npm run batch` — 全 87 サンプルを `out/svg_js/` に出力し、`out/compare.html`(A4 想定・1 ページ 12 件のページ送り)を更新
- `npm run verify` — 生成済み SVG のラベル数・bbox オーバーラップ・円内侵入・引出線交差・viewBox はみ出し・引出線屈曲数を自動検証(引数で対象ディレクトリを指定可。既定は `out/svg_js`)

## ディレクトリ構成 (11 files)

```
graph2/
├── package.json
├── tsconfig.json
├── samples.json                — サンプルデータ (87 件・object 形式)
├── fonts/BIZUDPGothic-Bold.woff2 — 埋込フォント (BIZ UDPゴシック Bold)
├── src/
│   ├── types.ts                — 共通型 (Item / LayoutItem / Placement / Diagnostics / PieLayoutConfig)
│   ├── config.ts               — createPieLayoutConfig + makeColors
│   ├── data.ts                 — samples / normalizeInputItems / resolveInputData*
│   ├── xlsx_loader.ts          — Excel 入力 (exceljs 依存隔離)
│   ├── svg_geom.ts             — 幾何/測定/ナッジ (副作用なし)
│   ├── layout.ts               — layoutLabels orchestrator
│   │                             (profiles / diagnostics / resolve / flip /
│   │                              upper-left render Y / left-stack / placeX を section 構成)
│   ├── label_placement.ts      — drawLabelFragments + 10 種 placeXxxLabel
│   │                             (constants / leader / place_*×10 / orchestrator を section 構成)
│   └── svg_export/             — SVG 出力層 (関心事ごとに分離)
│       ├── index.ts            — renderPdfStylePieToSvg orchestrator
│       ├── rendering.ts        — 座標変換 + slice path + text + 視覚 em 推定
│       ├── post_layout.ts      — overlap 解消 / compactify cascade /
│       │                         半角カナ fallback / 視覚 viewBox nudge
│       └── font.ts             — TTF → WOFF2 サブセット埋込 (async I/O + キャッシュ)
├── cli.ts                      — CLI (list / one / batch)
├── test_batch.ts               — 87 件一括生成 + compare.html
└── verify_svg.ts               — 自動検証
```

## アーキテクチャ

レンダリング層は外部ライブラリを使わず、**プレーンな TypeScript で SVG タグの文字列を組み立てる**。Node でもブラウザでも同一コードが動く(DOM API・`<canvas>`・selection 抽象に依存しない)。Excel 入力のみ `exceljs`(`xlsx_loader.ts`)、フォント埋込のみ `subset-font`(`svg_export/font.ts`)に依存し、いずれも端の層に隔離している。

```
入力 (samples.json / JSON / 配列 / xlsx)
   │  (data.ts: normalizeInputItems / resolveInputData{,Async}、xlsx は xlsx_loader.ts)
   ▼
Item[] {name, value}
   │
   ▼
renderPdfStylePieToSvg (async, svg_export/index.ts)   ← 最終アセンブリ・ヘアピン leader 省略・leader 交差検査
   ├─→ config.ts             createPieLayoutConfig / makeColors          (寸法・スケール・配色)
   ├─→ layout.ts             layoutLabels                                (論理座標でラベル位置決定)
   ├─→ svg_export/rendering.ts  createCoordinateSystem / buildSlicePath / computeArcs / textFragment
   ├─→ label_placement.ts    drawLabelFragments / leaderPath             (経路選択 + 引出線 path)
   ├─→ svg_export/post_layout.ts  resolveLabelOverlaps / runCompactCascade /
   │                              applyVisualViewBoxNudge
   └─→ svg_export/font.ts    buildFontFaceDefs                           (TTF → WOFF2 埋込)
   ▼
RenderResult { svg, diagnostics, config }
```

### レイヤごとの役割

| レイヤ | ファイル | 責務 |
|---|---|---|
| 型 | `src/types.ts` | 全体共通の TS interface(`Item` / `LayoutItem` / `Placement` / `Diagnostics` / `PieLayoutConfig` 等) |
| データ | `src/data.ts` + `samples.json` + `src/xlsx_loader.ts` | サンプル読込、JSON / Excel 入力、`{name, value}` 正規化 |
| 設定 | `src/config.ts` | pt 基準寸法・フォント・派生スケール getter 群(`createPieLayoutConfig`)+ 配色(`makeColors`) |
| レイアウト | `src/layout.ts` | 論理座標系でのラベル位置決定(左右割当・Y 解決・上左カスケード・X 配置・flip 判定)。`layoutLabels` を section 構成 |
| 幾何 | `src/svg_geom.ts` | 純粋幾何/測定/ナッジ系ヘルパー(座標変換なし、SVG 文字列生成なし、副作用なし) |
| 経路選択 | `src/label_placement.ts` | 角度ゾーン別の `placeXxxLabel` 群 10 種と `drawLabelFragments` のオーケストレーション。引出線 SVG path(`leaderPath`)と end-point / segment ナッジ |
| 描画 | `src/svg_export/rendering.ts` | 論理座標 → SVG pt への座標変換、スライス path・テキスト要素、視覚 em 幅推定(純粋関数) |
| 後処理 | `src/svg_export/post_layout.ts` | overlap 解消(対角押し + 縦分離の 2 パス）・compact cascade・半角カナ fallback・視覚 viewBox nudge |
| フォント | `src/svg_export/font.ts` | WOFF2 サブセット埋込(async I/O + キャッシュ。`subset-font` 依存、失敗時は full TTF に fallback) |
| 統合 | `src/svg_export/index.ts` | `renderPdfStylePieToSvg` の最終アセンブリ、ヘアピン leader 省略(なす角 > 135°）、leader 交差検査 |
| エントリ | `cli.ts` / `test_batch.ts` / `verify_svg.ts` | CLI / 一括生成 + ビューア / 自動検証 |

### ラベル配置の流れ(`layout.ts` 核心部）

1. **角度計算** (`calcMidAngles`) — 各スライスの中心角度を `startangle` から累積
2. **プロファイル化** (`buildProfiles`) — 角度から `side` (left/right)、`isUpperLeft`、`isSmall`、`isLong` 等のフラグ
3. **混雑診断** (`runDiagnostics`) — 領域別カウントから `upper_left_small_dense`、`top_small_dense` 等の `modeTags`
4. **Y 解決** (`resolveSidePositions`) — 左右各サイドで `gap` を確保しつつ縦位置を反復調整
5. **flip 判定** (`flipUpperLeftStackToRight` / `applyFlipToRight` / `applyBottomFlipToLeft`) — 左上スタックが上端を超える/下帯が混む場合に反対側へ flip
6. **上左カスケード** (`assignUpperLeftRenderY`) — 上左象限は専用処理で上方向にスタック
7. **X 配置** (`placeX`) — 楕円リング上に配置: `x = √(r² - y²) × xScale`

### リーダー線の分岐(`label_placement.ts`)

`drawLabelFragments` は角度・密度から配置関数を 1 つ選び、`leaderPath` で引出線を描くオーケストレータ。実際の配置計算は角度ゾーンごとに **10 関数**へ分割:

- `placeTopBandRightLabel` — 上帯 90°±18° の右出し(L 字: 垂直 → 水平 → ラベル）
- `placeTopBandUpperLeftLabel` — 上帯のうち上左象限側
- `placeBottomBandLabel` — 下帯 270°±14°
- `placeLowerLeftLabel` — 下左象限(`leaderBendPoint` で曲げ点、pie 円外まで bend を押し出し）
- `placeDominantBelowCenterLabel` — 下半分にある支配スライス(真下中央 + leader なし）
- `placeDominantOutsideEdgeLabel` — 下右で優勢なスライスを外側エッジへ逃がす
- `placeInsideSliceLabel` — スライス内部に収めるラベル
- `placeUpperLeftLabel` — 上左象限(`upperLeftBendPoint`、大きく上昇する場合は L 字に切替）
- `placeLeftStackLabel` — 長い左ラベルの 2 行スタック
- `placeDefaultLabel` — その他

各関数は `{ fragments, textX, textY, anchor, baseline, lineEnd*, allowSegmentNudge }` 系を返し、`svg_export/rendering.ts` の `textFragment` が `<text>` を組み立て、`svg_export/post_layout.ts` の `resolveLabelOverlaps` がラベル同士の重なりを反復解消する。

### 分割方針

- **`layout.ts` / `label_placement.ts` は 1 ファイル**: 公開 API は 1 関数 (`layoutLabels` / `drawLabelFragments`) で、サブモジュール化は内部詳細にすぎず grep 性が下がる。section header コメントで「profiles / diagnostics / ...」を識別できれば十分
- **`svg_export/` は subdir 維持**: rendering (純粋関数) / post_layout (placement 修正) / font (async I/O + 独自依存) / orchestrator は性質が異なるため分けるメリットあり

## 注意

- `1 viewBox unit = 1px` 固定。キャンバスは **600×450px 固定**(`config.ts` の `svgWidthPx` / `svgHeightPx`）。
- 円グラフ本体の直径は**高さの 70% 固定**(`pieHeightRatio` 0.7)で、**fontSize 非依存**。pie は常にキャンバス中央に置かれ、横余白は `(svgWidthPx − 直径) / 2` で自動決定される。
- 文字サイズは `config.ts` の `fontSize` 既定 **40**(`baselineFontSize` 20 を基準に派生スケールが連動）。実描画は `fontSize × textRenderScale`(=40×0.68=**27.2px**) で `<text font-size>` に出力される。
- 長体 (nameScaleX) は**ラベル単位**: はみ出すラベルだけ `applyFinalCondenseToFit` で縮め、`relaxNameCondense` がキャンバス・pie・隣接ラベルに当たらない範囲で原寸 (sx=1 上限) へ戻す。旧来の「1 つでも長体なら全ラベルを統一圧縮」は廃止 (収まるラベルは原寸のまま)。
- **fontSize=40 での tight-pack warning(現況: 2026-06-11 更新 / fontSize 40 化 + 長体のラベル単位化後に再計測)**: 現行設定 (600×450px / 直径 70% / fontSize=40) では `npm run verify` が **18/86 サンプル**で警告する(68 件クリーン・計34件)。fontSize 39 時点の 14/86(23件)から増えた分は、フォント拡大で最密サンプルの幅圧が上がったことによる(警告は全て WARN 級。ERROR 級の leader 交差/円内貫通は 0 を維持)。内訳:
  - label viewBox はみ出し: 25 件(**大半は condense-to-fit で縮小済**。残るのは下記の構造的残件)
  - leader 交差: **0 件** / leader 円内侵入: **0 件**(`test/leader_invariants.test.ts` が回帰 5 サンプル + 番兵 3 サンプルで不変条件をガード。fontSize 40 で `currency_many_small_10` に出た交差は `repairResidualLeaderDefects` の交差対 footprint スワップが through/inversion へ振り替えて解消)
  - label overlap: 2 件(`currency_long_labels_8` 48px / `currency_low_diff_10` 21px。長体の有無に依らず fontSize 40 の cascade 配置で発生する密集残件)
  - leader through label: 4 件 / label order inversion: 2 件 / label inside pie (7px): 1 件(`stress_top_cluster_8` と、交差→through/inversion 振替後の `currency_many_small_10`・`page16_country_allocation`。いずれも 1 曲げ leader 制約下で回廊が物理的に確保できない構造的残件)
- **構造的に残る viewBox はみ出し(対象外として既知)**: いずれも長名を最終 `applyFinalCondenseToFit`(下限 sx=0.7)で縮めても収まらないケース。
  - 長カタカナ単一語(`スウェーデンクローナ`/`ノルウェークローネ`/`オフショア人民元` 等): 1 行では収まらず、根本解は中間分割2行化(別タスク)。
  - 支配スライス右端(`債券先物(イギリス) 41.8%`): rim 右端に配置余地なし。中央下/スライス内誘導はカスケード新規追加(別タスク)。
  - これらの解消は**別タスク**で対応する。値が動いたら本節を更新すること。**新規回帰と区別すること**。
- TypeScript は `strict: true`(`noImplicitAny: false` で段階導入、`strictNullChecks: true` 有効）。
