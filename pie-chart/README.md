# pie-chart

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
- `npm run cli -- one --sql "SELECT 区分, 比率 FROM dbo.資産配分" --db-name usrap --output-file out/test.svg`
- `npm run cli -- batch --output-dir out/svg`
- `npm run cli -- batch --input-dir data --output-dir out/svg`

`one` の入力は `--sample` / `--data-file` / `--data-json` / `--xlsx + --sheet + --range` / `--sql` のいずれか(`--output-file` 必須)。`batch` は既定で全サンプル、`--samples a,b,c` で対象を絞れる。`--input-dir` 指定時はそのディレクトリ内の `*.json` を一括処理する。

#### Excel 入力の決まり

- `--range` は 2 列固定(左=name、右=value)。3 列以上 / 1 列はエラー。
- **ヘッダ行は指定しない**(データ行のみ渡す)。先頭行が「区分」「比率」のような文字列だと `Non-numeric value at row N` で落ちる。
- 空行はスキップ、name 空欄や value 数値変換不可は明示エラー。
- 数式セルは結果値、リッチテキスト/ハイパーリンクも展開して取り込む。
- exceljs 依存は `src/xlsx_loader.ts` に隔離(`parseRange` / `loadXlsxItems`)。

#### DB(SQL Server)入力の決まり

- 入力は単一の SELECT 文。複文(文中 `;`)・非 SELECT(UPDATE/DELETE 等)は拒否する。
- 列解決は Excel と同思想: `--name-col` / `--value-col` を**両方**指定すれば列名で、無指定なら
  結果セットの**先頭 2 列**を name/value とする(3 列以上で未指定はあいまいエラー)。
- 接続先は `--db-server`(既定 env `DB_SERVER` / `localhost`)・`--db-name`(既定 env `DB_NAME`)。
  認証は **Windows 統合認証**固定(`Trusted_Connection=yes`)で資格情報は持たない。
  ODBC ドライバは既定 `ODBC Driver 17 for SQL Server`(env `DB_ODBC_DRIVER` で変更可)。
- ネイティブドライバ `msnodesqlv8` は `optionalDependencies`。**遅延 require** のため、未導入でも
  他入力(sample/json/xlsx)と `tsc` は動く。DB 入力使用時のみ導入が必要。
- 接続・SQL 依存は `src/db_loader.ts` に隔離(`buildConnectionString` / `assertSelectOnly` /
  `rowsToItems` / `loadDbItems`)。editor フェーズ2(`editor/server/src/db/pool.ts`)と同パターン。

### exe 配布(Node SEA + 外部参照)

非開発者へ配る実行ファイルを `npm run build:exe`(`scripts/build-exe.mjs`、または
`build-exe.bat` をダブルクリック)で生成する。**配布物は `dist-exe/` フォルダ一式**:

```
dist-exe/
├── pie-chart.exe          — Node SEA 実行体(cli を esbuild で単一 CJS 化して inject)
├── fonts/                 — 埋込元の woff2(BIZ UDPGothic 400/700)
└── node_modules/          — subset-font + 依存(harfbuzzjs wasm 等)
```

- **フォントと subset-font は exe に埋め込まず外部参照する**。これにより subset-font 内の
  `require.resolve('harfbuzzjs/hb-subset.wasm')` が実行時の Node 解決で効き、**フォントが
  サブセットされて出力 SVG が小さくなる**(CLI/tsx 版と **byte-identical**)。フォント自体は
  従来どおり SVG 内へ base64 で subset 埋込されるため WYSIWYG・単体表示は不変。
- `font.ts` の `seaExeDir` / `getSubsetFont` が SEA 実行時に exe ディレクトリ基準で
  `fonts/` と `node_modules/subset-font` を解決する(cwd 非依存)。
- 使い方は CLI と同じ: `pie-chart.exe one --sample asset_gbca_pdf_like --output-file t.svg` など。
- ビルド依存: `esbuild` / `postject`(devDependencies)。`subset-font` 依存ツリーは build 時に
  npm で `dist-exe/node_modules` へ隔離 install する(版は dev と一致させる)。**オフライン配布時は
  これらをバンドルへ含める**([[offline-bundle-distribution]])。
- DB 入力(`--sql`)はネイティブ `msnodesqlv8` を要するため exe には含めない。利用時は
  `dist-exe/node_modules` へ `msnodesqlv8` を追加する(描画・Excel 入力は追加不要で動く)。

### 全件生成 + ビューア

- `npm run batch` — 全 87 サンプルを `out/svg_js/` に出力し、`out/compare.html`(A4 想定・1 ページ 12 件のページ送り)を更新
- `npm run verify` — 生成済み SVG のラベル数・bbox オーバーラップ・円内侵入・引出線交差・viewBox はみ出し・引出線屈曲数を自動検証(引数で対象ディレクトリを指定可。既定は `out/svg_js`)

## ディレクトリ構成 (11 files)

```
pie-chart/
├── package.json
├── tsconfig.json
├── samples.json                — サンプルデータ (87 件・object 形式)
├── fonts/                     — 埋込フォント (BIZ UDPGothic WOFF2 400/700 + OFL ライセンス)
├── src/
│   ├── types.ts                — 共通型 (Item / LayoutItem / Placement / Diagnostics / PieLayoutConfig)
│   ├── config.ts               — createPieLayoutConfig + makeColors
│   ├── data.ts                 — samples / normalizeInputItems / resolveInputData*
│   ├── xlsx_loader.ts          — Excel 入力 (exceljs 依存隔離)
│   ├── db_loader.ts            — DB(SQL Server)SELECT 入力 (msnodesqlv8 依存隔離)
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

## コメント規約

コメント規約の正典は **`docs/コメント規約.md`**（全プロジェクト共通）。言語・識別子バッククォート・
クロスファイル参照・体裁（`=` 罫線の装飾ボックスヘッダ、`// ── N. ラベル ──` 節区切り）など
共通事項はそちらを参照すること。pie-chart もこの規約に準拠する。

- **出力不変の検証（pie-chart 固有）**: コメントのみの変更でも `out/_baseline` に対し SVG を
  byte-diff し、出力が完全に不変であることを確認する (`npm run batch` 後に SHA256 比較)。
  これは SVG 出力の決定性に密な pie-chart 限定の鉄則。

## 注意

- `1 viewBox unit = 1px` 固定。キャンバスは **600×450px 固定**(`config.ts` の `svgWidthPx` / `svgHeightPx`）。
- 円グラフ本体の直径は**高さの 70% 固定**(`pieHeightRatio` 0.7)で、**fontSize 非依存**。pie は常にキャンバス中央に置かれ、横余白は `(svgWidthPx − 直径) / 2` で自動決定される。
- 文字サイズは `config.ts` の `fontSize` 既定 **40**(`baselineFontSize` 20 を基準に派生スケールが連動）。実描画は `fontSize × textRenderScale`(=40×0.68=**27.2px**) で `<text font-size>` に出力される。
- 長体 (nameScaleX) は**ラベル単位**: はみ出すラベルだけ `applyFinalCondenseToFit` で縮め、`relaxNameCondense` がキャンバス・pie・隣接ラベルに当たらない範囲で原寸 (sx=1 上限) へ戻す。旧来の「1 つでも長体なら全ラベルを統一圧縮」は廃止 (収まるラベルは原寸のまま)。
- **上部「その他」の右上逃がしは pie キャップ上へ持ち上げる** (`label_placement.ts` `topRightLiftedRimDraft`): 箱下端を `pieRadius + クリアランス` に揃え (= 箱全体が円の上)、`pieClampXLimits` が横押し出しを起こさないようにして短い縦/斜め leader で結ぶ。`topBandSonohokaRight` 右パス / `topBandSmallRight` / `clusterTopBandBottomRight` が共有。旧実装は箱下端が円の y 域に入り pie クリアランスが textX を右へ押し出し、100〜180px の水平 leader がチャート上部を横断していた。
- **下限長体でも見切れる長名は 2 行分割で収める** (`svg_geom.ts` `splitLongName` + emit 最終段の `applySplitNameFallback`): 名前を `[前半, 後半+%]` の 2 行に割り (例 `ニュージーランド・ドル`)、`・`/script 境界を優先・括弧内/小書きカナ前では割らない。採否は `countDefects` の chart 全体 do-no-harm ゲート (clips 厳密減・他カテゴリ非悪化) で決め、部分的にしか収まらない分割は revert する。採点 (`finalizeForScoring`) には入れず emit のみ (候補選択を乱さない / finalScore は emit 後の同 placements から数えるため scorer↔emit 整合は保たれる)。
- **fontSize=40 での tight-pack warning(現況: 2026-06-12 更新 / その他リーダー短縮 + 名前 2 行分割の追加後に再計測)**: 現行設定 (600×450px / 直径 70% / fontSize=40) では `npm run verify` が **15/86 サンプル**で警告する(計 25 件)。警告は全て WARN 級(ERROR 級の leader 交差/円内貫通は 0 を維持)。内訳:
  - label viewBox はみ出し: 21 件(**大半は condense-to-fit / 2 行分割で縮小済**。残るのは下記の構造的残件)
  - leader 交差: **0 件** / leader 円内侵入: **0 件** / leader through label: **0 件** / label inside pie: **0 件**(`test/leader_invariants.test.ts` が回帰 9 サンプル + 番兵 3 サンプルで不変条件をガード)
  - label overlap: 2 件(`stress_one_dominant_9`。fontSize 40 の cascade 配置で発生する密集残件)
  - label order inversion: 2 件(`page16_country_allocation` / `pdf_510037_02_world_bond_idx_country`。1 曲げ leader 制約下の構造的残件)
- **構造的に残る viewBox はみ出し(対象外として既知)**: いずれも長名を `applyFinalCondenseToFit`(下限 sx=0.7)・`splitLongName` 2 行分割でも収まらないケース。
  - 長カタカナ単一語(`スウェーデンクローナ`/`ノルウェークローネ`/`オフショア人民元` 等): 600×450px / fontSize 40 では 2 行分割しても後半行 (`クローナ 8.0%` 等) が canvas 幅を超える密スタック位置に残る。`ニュージーランド・ドル` 等、上部の細い pie 帯に置ける長名は 2 行分割で解消済。
  - 支配スライス右端(`債券先物(イギリス) 41.8%`): rim 右端に配置余地なし。中央下/スライス内誘導はカスケード新規追加(別タスク)。
  - これらの解消は**別タスク**で対応する。値が動いたら本節を更新すること。**新規回帰と区別すること**。
- TypeScript は `strict: true`(`noImplicitAny: false` で段階導入、`strictNullChecks: true` 有効）。
