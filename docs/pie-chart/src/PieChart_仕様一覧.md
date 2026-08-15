---
audience: spec
title: PieChart 仕様一覧（入出力 / CLI・設定 / テスト）
---

対象: 円グラフ SVG レンダラ PieChart ・ 版 1.1 ・ 出典: pie-chart/ 実装コード・テスト

# 入出力定義

| No | 区分 | 項目 | 型/形式 | 説明 |
|:--:|:--:|---|---|---|
| 1 | 入力 | samples.json | `Record<string, {description, items}>` | 内蔵83サンプル。各 items は Item 配列 |
| 2 | 入力 | Item.name | `string` | スライス名（凡例ラベル） |
| 3 | 入力 | Item.value | `number` | スライス値。割合は内部で算出 |
| 4 | 入力 | JSONファイル | `Item[] ([{name, value}, ...])` | --data-file で指定 |
| 5 | 入力 | JSON直渡し | `Item[] (CLI文字列)` | --data-json で直接指定 |
| 6 | 入力 | Excel(xlsx) | `2列固定 (左=name, 右=value)` | --xlsx + --sheet + --range（例 A2:B11。見出し行は含めない） |
| 7 | 入力 | DB(SQL Server) | `読み取りクエリの結果セット` | --sql。先頭2列 or --name-col/--value-col。Windows統合認証・msnodesqlv8隔離。exe 版は非対応 |
| 8 | 出力 | SVG文字列 | `600×450px 固定` | スライスpath・ラベル・リーダー線・WOFF2埋込フォント |
| 9 | 出力 | テキスト要素 | `<text>（実テキスト）` | ラベルとパーセンテージは後から検索可能 |
| 10 | 出力 | リーダー線 | `<path>（引出線）` | 決定的シリアライズ（同一入力→同一バイト） |

# CLI・設定

| No | 区分 | コマンド/パラメータ | 既定/値域 | 説明 |
|:--:|---|---|---|---|
| 1 | コマンド | `list` |  | サンプル一覧表示 |
| 2 | コマンド | `one` |  | 1件レンダリング |
| 3 | コマンド | `batch` |  | 全件生成（out/） |
| 4 | コマンド | `license` |  | 埋込フォントの OFL ライセンス本文を表示 |
| 5 | オプション | `--sample` |  | サンプル名で選択 |
| 6 | オプション | `--data-file` |  | JSONファイル指定 |
| 7 | オプション | `--data-json` |  | JSON文字列を直渡し |
| 8 | オプション | `--xlsx / --sheet / --range` |  | Excel範囲入力（3 つとも必須。例 A2:B11） |
| 9 | オプション | `--sql` |  | SQL Serverへ読み取りクエリ（形式チェックのみ。読み取り専用は接続アカウント権限で担保）。exe 版は非対応 |
| 10 | オプション | `--db-server / --db-name` | `env DB_SERVER / DB_NAME` | 接続先（既定 localhost / env）。Windows統合認証固定 |
| 11 | オプション | `--name-col / --value-col` | `先頭2列` | 両指定で列名解決。無指定は先頭2列 |
| 12 | オプション | `--font-weight` | `400 \| 700` | フォントウェイト切替 |
| 13 | オプション | `--stroke-ratio` | `number` | faux-bold のストローク調整 |
| 14 | オプション | `--output-file / --output-dir` |  | 出力先指定 |
| 15 | 設定 | `svgWidthPx / svgHeightPx` | `600 / 450` | SVG寸法（固定） |
| 16 | 設定 | `pieHeightRatio` | `0.7` | 直径 = 450 × 0.7 = 315px |
| 17 | 設定 | `baselineFontSize` | `20` | 基準フォントサイズ |
| 18 | 設定 | `fontSize` | `40` | 実描画。40 × 0.68 ≈ 27.2px |
| 19 | 設定 | `labelRadius` | `1.19` | ラベル配置半径倍率 |
| 20 | 設定 | `startangle` | `90.0` | 12時を0°に |
| 21 | 設定 | `minGap` | `0.16` | ラベル最小間隔 |
| 22 | 設定 | `smallSliceThreshold` | `6.0` | 小スライス判定（%） |
| 23 | 設定 | `denseCountThreshold` | `9` | 密判定のスライス数閾値 |

# テスト仕様

| No | テスト | テスト観点 | 期待結果 | 結果 |
|:--:|---|---|---|:--:|
| 1 | `test/input_load.test.ts` | タプル/オブジェクト変換・型強制・エラーケース | 正規化が仕様どおり | 未 |
| 2 | `test/input_xlsx.test.ts` | 範囲解析（`parseRange`）・2 列固定・書式不正エラー | Excel入力が正しく読める | 未 |
| 3 | `test/input_db.test.ts` | 接続文字列の許可リスト・`assertLooksLikeSelect` の形式チェック・列解決 | DB入力の入口が仕様どおり | 未 |
| 4 | `test/input_limits.test.ts` | 入力の資源上限（件数・ラベル長・range 行数・データ長・値の総和）の退行ガード | 上限超過が明示エラー | 未 |
| 5 | `test/config.test.ts` | パラメータ override・派生スケール計算・配色（`makeColors`） | config が一致 | 未 |
| 6 | `test/geometry.test.ts` | 座標変換・BBox・overlap・ナッジ | 幾何計算が正しい | 未 |
| 7 | `test/placement.test.ts` | leader path・上部「その他」の帯判定と rim 配置 | ラベル配置が一致 | 未 |
| 8 | `test/post_layout.test.ts` | overlap解消・cascade・viewBox nudge | 後処理が一致 | 未 |
| 9 | `test/leader_invariants.test.ts` | 回帰10サンプル+番兵3で交差/円内貫通ゼロ・曲がり ≤1 | leader不変条件を保証 | 未 |
| 10 | `test/glyph_advance.test.ts` | 実フォントglyph metrics（推定でない） | 字幅が実測一致 | 未 |
| 11 | `test/mark_flags.test.ts` / `final_score.test.ts` / `render_hash.test.ts` | マーカー発火表・finalScore・合成入力 SVG ハッシュのゴールデン | スナップショット一致 | 未 |
| 12 | `test/emit_passes.test.ts` / `seam_snapshot.test.ts` | emit/scoring パス列の固定・seam snapshot の revert 完全性 | パス列と snapshot が整合 | 未 |
| 13 | `test/oracle_sync.test.ts` / `output_escaping.test.ts` | オラクル複製定数の drift・設定値の出力エスケープ | drift/素通しなし | 未 |
| 14 | `test/sea_runtime.test.ts` / `subset_font_fs.test.ts` / `build_pins.test.ts` / `sea_packaging.test.ts` | SEA のアセット許可リスト・モジュール解決封鎖・同梱物の pin・exe 実機検査（既定 skip） | 迂回入力が失敗する | 未 |
| 15 | `src/verify/svg.ts`（`npm run verify`） | 83サンプル全件: ラベル数・overlap・円内侵入・交差・はみ出し | ERROR ゼロ | 未 |
| 16 | `src/verify/consistency.ts`（`npm run verify:consistency`） | 採点判断（scorer）↔ emit SVG の一致検証 | scorer↔emit が乖離なし | 未 |
| 17 | `batch + out/_baseline`（`npm run batch:diff`） | 決定的出力の byte-diff | baseline と完全一致 | 未 |
