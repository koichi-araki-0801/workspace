---
audience: spec
title: PieChart 仕様一覧（入出力 / CLI・設定 / テスト）
---

対象: 円グラフ SVG レンダラ PieChart ・ 版 1.0 ・ 出典: pie-chart/ 実装コード・テスト

# 入出力定義

| No | 区分 | 項目 | 型/形式 | 説明 |
|:--:|:--:|---|---|---|
| 1 | 入力 | samples.json | `Record<string, {description, items}>` | 内蔵87サンプル。各 items は Item 配列 |
| 2 | 入力 | Item.name | `string` | スライス名（凡例ラベル） |
| 3 | 入力 | Item.value | `number` | スライス値。割合は内部で算出 |
| 4 | 入力 | JSONファイル | `Item[]（[{name, value}, ...]）` | --data-file で指定 |
| 5 | 入力 | JSON直渡し | `Item[]（CLI文字列）` | --data-json で直接指定 |
| 6 | 入力 | Excel(xlsx) | `2列固定（左=name, 右=value）` | --xlsx + --sheet + --range（例 A1:B11） |
| 7 | 入力 | DB(SQL Server) | `単一SELECT文の結果セット` | --sql。先頭2列 or --name-col/--value-col。Windows統合認証・msnodesqlv8隔離 |
| 8 | 出力 | SVG文字列 | `600×450px 固定` | スライスpath・ラベル・リーダー線・WOFF2埋込フォント |
| 9 | 出力 | テキスト要素 | `<text>（実テキスト）` | ラベルとパーセンテージは後から検索可能 |
| 10 | 出力 | リーダー線 | `<path>（引出線）` | 決定的シリアライズ（同一入力→同一バイト） |

# CLI・設定

| No | 区分 | コマンド/パラメータ | 既定/値域 | 説明 |
|:--:|---|---|---|---|
| 1 | コマンド | `list` |  | サンプル一覧表示 |
| 2 | コマンド | `one` |  | 1件レンダリング |
| 3 | コマンド | `batch` |  | 全件生成（out/） |
| 4 | オプション | `--sample` |  | サンプル名で選択 |
| 5 | オプション | `--data-file` |  | JSONファイル指定 |
| 6 | オプション | `--data-json` |  | JSON文字列を直渡し |
| 7 | オプション | `--xlsx / --sheet / --range` |  | Excel範囲入力（例 A1:B11） |
| 8 | オプション | `--sql` |  | SQL Serverへ単一SELECT。結果セットから取り込み |
| 9 | オプション | `--db-server / --db-name` | `env DB_SERVER / DB_NAME` | 接続先（既定 localhost / env）。Windows統合認証固定 |
| 10 | オプション | `--name-col / --value-col` | `先頭2列` | 両指定で列名解決。無指定は先頭2列 |
| 11 | オプション | `--font-weight` | `400 \| 700` | フォントウェイト切替 |
| 12 | オプション | `--stroke-ratio` | `number` | faux-bold のストローク調整 |
| 13 | オプション | `--output-file / --output-dir` |  | 出力先指定 |
| 14 | 設定 | `svgWidthPx / svgHeightPx` | `600 / 450` | SVG寸法（固定） |
| 15 | 設定 | `pieHeightRatio` | `0.7` | 直径 = 450 × 0.7 = 315px |
| 16 | 設定 | `baselineFontSize` | `20` | 基準フォントサイズ |
| 17 | 設定 | `fontSize` | `40` | 実描画。40 × 0.68 ≈ 27.2px |
| 18 | 設定 | `labelRadius` | `1.19` | ラベル配置半径倍率 |
| 19 | 設定 | `startangle` | `90.0` | 12時を0°に |
| 20 | 設定 | `minGap` | `0.16` | ラベル最小間隔 |
| 21 | 設定 | `smallSliceThreshold` | `6.0` | 小スライス判定（%） |
| 22 | 設定 | `denseCountThreshold` | `9` | 密判定のスライス数閾値 |

# テスト仕様

| No | テスト | テスト観点 | 期待結果 | 結果 |
|:--:|---|---|---|:--:|
| 1 | `data.test.ts` | タプル/オブジェクト変換・型強制・エラーケース | 正規化が仕様どおり | 未 |
| 2 | `config.test.ts` | パラメータ override・派生スケール計算 | config が一致 | 未 |
| 3 | `xlsx_loader.test.ts` | 範囲解析・数式セル展開・非数値エラー | Excel入力が正しく読める | 未 |
| 4 | `svg_geom.test.ts` | 座標変換・BBox・overlap・ナッジ | 幾何計算が正しい | 未 |
| 5 | `label_placement.test.ts` | 10種の配置関数・leader path | ラベル配置が一致 | 未 |
| 6 | `post_layout.test.ts` | overlap解消・cascade・viewBox nudge | 後処理が一致 | 未 |
| 7 | `leader_invariants.test.ts` | 回帰9サンプル+番兵3で交差/円内貫通ゼロ | leader不変条件を保証 | 未 |
| 8 | `glyph_advance.test.ts` | 実フォントglyph metrics（推定でない） | 字幅が実測一致 | 未 |
| 9 | `verify_svg.ts` | 87サンプル全件: ラベル数・overlap・円内侵入・交差・はみ出し | ERROR ゼロ | 未 |
| 10 | `verify_consistency.ts` | 採点判断（scorer）↔ emit SVG の一致検証 | scorer↔emit が乖離なし | 未 |
| 11 | `batch + out/_baseline` | 決定的出力の byte-diff | baseline と完全一致 | 未 |
