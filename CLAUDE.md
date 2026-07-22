# プロジェクトルール

## Git / ブランチ運用

### 常設ブランチと squash 分岐

- `chore/deps-latest-offline-bundle` は **常設の作業ブランチ**で、`main` より先行している。
- このブランチの PR は **squash マージ**で `main` に取り込む。そのため `main` には
  ブランチの実体（非 squash 履歴）を 1 コミットに圧縮した squash コミットだけが乗る。
  結果として `main` は常に「ブランチ作業の squash 済み旧版」になる。

### squash 分岐による PR コンフリクトの解消（必須手順）

このブランチから `main` への PR が **CONFLICTING**（`mergeStateStatus: DIRTY`）になった場合、
ほぼ常に上記の squash 分岐が原因。次の手順で解消する:

1. `git fetch origin` 後、`git log --oneline HEAD..origin/main` で **ブランチに無い
   `main` 側コミット**を列挙する。
2. それらが**本ブランチ由来の過去 PR の squash コミット**（例: `Chore/deps latest
   offline bundle (#NN)`）であることを確認する。＝実体はブランチに既存。
3. 確認できたら `git merge -s ours origin/main` で取り込む（ブランチ側を保持し、
   squash 版の重複変更は捨てる）。
4. push する。PR は `MERGEABLE` / `CLEAN` になる。

> ⚠️ `merge -s ours` は `main` 側の変更を**意図的に捨てる**。手順 2 を飛ばさないこと。
> もし `main` 側にブランチ由来でない独立コミットがあれば ours では消えるため、その場合は
> 通常マージ＋コンフリクト解消に切り替える。

### PR マージ

- マージ方式は **squash**（`gh pr merge <N> --squash`）。
- 常設ブランチは**削除しない**（`--delete-branch=false`）。
- マージ前に CI（`verify` チェック）の通過を待つ。

### コミット / push フック（既存・参考）

- **pre-commit**: `lint-staged` が `editor/**` に `biome check --write` を実行。
  未修正の biome エラーがあるとステージが入れ替わる事故があるため、editor 配下を
  変更したコミット前は `pnpm exec biome check --write editor/<対象>` を**先行実行**して
  状態を確定させる（対象は変更ファイルに限定し、無関係な再整形を広げない）。
- **post-commit**: `offline/publish-offline-bundle.ps1` がローリングタグ
  `offline-bundle-v1` を HEAD へ移動し、重量物バンドルは content key 差分時のみ再生成。
  ベストエフォート（コミットはブロックしない）。無効化は `OFFLINE_PUBLISH_SKIP=1`。
- **pre-push**（`.husky/pre-push` → `scripts/pre-push.mjs`）: ブランチ push では
  `ci:affected` を走らせるが、**タグのみの push（上記タグ移動など）は CI をスキップ**する。
  これが無いと、post-commit のタグ push が pre-push のフル CI を発火させ、commit フック内の
  `GIT_AUTHOR_NAME` 漏れで `gitRepo.test` が落ちてタグ push が中断し、リリースが更新されない。
- **auto-push**（`.claude/hooks/auto-push.cjs`）: commit 後に現ブランチを origin へ push。
  履歴を amend した場合はリモートが古い同内容コミットのまま分岐するため、ツリー一致を
  確認のうえ `git push --force-with-lease` で揃える。

## Biome 運用

- 対象範囲は `biome.json` で意図的に限定している: **formatter は `editor/**` と `pie-chart/**`**
  （`out`/`dist` 等は除外）、**linter / assist（import 整理）はトップレベルの `linter.includes` /
  `assist.includes` で `editor/**` のみ**。graph-editor / pdf-to-svg（mockup・生成 web 資産・HTML
  を含み高リスク）へは拡大しない（未整形コードに 8000+ errors / 10000+ warnings が噴出し、
  多くは自動修正不可）。
- **`overrides` は使わない**: `overrides[].linter:{enabled:false}` を足すと Biome 2.4.16 は
  override 対象の **formatter 設定まで既定（tab + double-quote）へ戻して**大量誤整形を起こす
  （editor のクォート反転 約214 ファイル / pie-chart 全行タブ化 16k 行差分の実績）。
  範囲の出し分けは上記のとおり `linter.includes` / `assist.includes` で行うのが唯一の安全な方法。

## PowerShell スクリプト（.ps1）

- スクリプトの**置き場ルール**（入口=プロジェクト直下 / 裏方=`<project>/scripts/`）と入口一覧は
  ルート `README.md` の「スクリプトの置き場ルール」「入口スクリプト一覧」を正典とする。
- `.ps1` を新規追加する場合は、**必ず同階層に同名の `.bat` ランチャを併せて作成**する。
  `.bat` が無い `.ps1` は不可。既存で `.bat` が欠けているものは改修して揃える。
- `.bat` は **実行ポリシー Bypass** で `.ps1` を起動する。引数はそのまま転送する。
  雛形は次のとおり（`<name>.ps1` を実際のファイル名に置換）:

  ```bat
  @echo off
  chcp 65001 >nul
  rem 同梱の <name>.ps1 を実行ポリシー Bypass で実行（引数はそのまま転送）。
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0<name>.ps1" %*
  exit /b %ERRORLEVEL%
  ```

  - `-NoProfile -ExecutionPolicy Bypass -File "%~dp0<name>.ps1" %*` は固定。`%~dp0` で
    `.bat` 自身の場所を基準に解決し、どこから起動しても同じ `.ps1` を指す。
  - `exit /b %ERRORLEVEL%` で `.ps1` の終了コードをそのまま返す。
- 文字コードの扱いは [[offline-bundle-distribution]] と同様: 日本語を含む `.ps1` は
  **UTF-8 BOM 必須**（cp932 環境での文字化け回避）。`.bat` は cmd の JP コードページで
  壊れない範囲に留め、非ASCII を使う場合は冒頭で `chcp 65001 >nul` を入れる。
  非ASCII を避けたい `.bat`（例: `offline/setup-offline-local.bat`）は ASCII のみで書く。

## コメント規約（全体）

- コメント規約の正典は **`docs/コメント規約.md`**（全プロジェクト共通）。共通原則（なぜを書く /
  日本語散文 + 英語ドメイン用語 / 識別子バッククォート / クロスファイル参照形式 / 重複は集約 /
  100 桁・ASCII 括弧）と言語別付録（`.ts/.js` 装飾ボックス・`// ── N. ──`、`.py` docstring・
  `# ── ラベル ──`、`.ps1` comment-based help）はそちらを参照。
- **コード修正時は既存・新規いずれのコードも必ず本規約に従う**こと。
- 強制の仕組み: `Edit`/`Write` 時に規約をリマインドする PreToolUse フック
  (`.claude/hooks/comment-convention-reminder.cjs`) と、機械判定可能な項目を検査する CI チェック
  (`pnpm run check:comments`、`ci` に組込み) を併設する。
- pie-chart 配下は上記に加えて、コメントのみの変更でも `out/_baseline` との **byte-diff 不変**が鉄則
  （詳細は下記 pie-chart 節）。

## ドキュメント（.docx / .xlsx）

- 配布ドキュメントのフォントは **BIZ UD ファミリ**に統一する: 本文 `BIZ UDPGothic`（プロポーショナル）、
  等幅 `BIZ UDGothic`（コード・識別子・けた揃え）。両者は同一 BIZ UD ファミリなので混在して見えない。
  MS Gothic / Meiryo UI の混在は廃止。Windows 10+ 同梱（無ければ Microsoft Store の BIZ UD フォント）。
  - すべてのランで ASCII(`w:ascii`/`w:hAnsi`)・東アジア(`w:eastAsia`)の双方に同じフォント名を設定する。
  - python-docx の場合: `run.font.name = "BIZ UDPGothic"` に加え、
    `run._element.rPr.rFonts.set(qn("w:eastAsia"), "BIZ UDPGothic")` を必ず併設する
    （`eastAsia` を設定しないと日本語グリフが既定フォントに落ちる）。等幅は `BIZ UDGothic`。
  - 配色は既存トークン（ACCENT `#1F5C99` / INK `#20242C` / MUTED `#606874` 等）を使い、新色を増やさない。
- 文書種別で生成系を出し分ける。原稿は `docs/<project>/src/` に置き、`docs/_build/build_all.py`
  （または `.bat`）で一括生成する:
  - **流れる文書**（操作手順書・設計書・配布運用手順書）→ `*.md`（Markdown 正典）→ 共通エンジン
    `docs/_build/md2docx.py` で **Word(.docx)**。front-matter `style` で案3 カード型(`guide`)／
    案2 テクニカル型(`spec`) を出し分け（無指定はファイル名・title から推定）。`out` が出力 docx 名、
    画像基準は `docs/<project>/images/`。
  - **表が主役の文書**（画面項目定義・入出力定義・DB 定義・テスト仕様）→ `*.xlsx.yaml` →
    `docs/_build/md2xlsx.py`（openpyxl）で **Excel(.xlsx)**。Word 版と共通トークンで、ヘッダ塗り・
    ゼブラ・細罫線・ウィンドウ枠固定・オートフィルタ・A4 横の印刷設定を組む。`md2xlsx.py` は
    PyYAML を使わず必要な YAML サブセットを自前パースする（オフライン依存追加を避けるため）。
  - 両エンジンの既定フォント定数（`JP` / `MONO`）も上記 BIZ UD 規約に一致させる。
- 図版（アーキテクチャ図など）は **SVG が正典**（`docs/<project>/images/*.svg`）で、Word へは隣の
  同名 PNG を挿入する（python-docx は SVG 非対応）。PNG はコミット済み成果物とし、SVG を変更した
  ときだけ `python docs/_build/svg2png.py` で手動再生成する（Playwright 依存のため `build_all.py`
  には組み込まない）。

## editor 2系統の原則（根幹・必ず順守）

editor の編集体験は **2系統**で、これはツールの根幹である。**コード修正時は新規・既存いずれも
必ず本原則に従う**こと（コメント規約と同格の強制ルール）。

- **編集タブ（既存編集）** = 会社・ファンド・基準日・版の **実値が埋め込まれた値埋め込み済み
  HTML** を編集する。差し込み値ハイライトは **出さない**（値は実値であり、地の本文として表示）。
  - 経路: `EditTabView` → `/edit/:id`（**query なし**）。
  - 値の源: ローカルは per-fund 実サンプル `editor/web/src/api/fixtures/sample/<fund>.json` を
    `genFilled.ts` で `fixtures/filled/*.html`（= `tpl.filled`）へ反映。本番は **ファイルに値が
    埋め込み済み**で DB 取得は不要（REST が値埋め込み済みファイルを `filled` で返す前提）。
- **テンプレ作成タブ（新規作成）** = 属性から Jinja スケルトンを作り、**共通sample
  （`sampleCommon`）** で表示のみ値入りに見せる。差し込み値は placeholder として **ハイライト
  表示する**（作成中の可視化）。
  - 経路: `CreateTabView` → `/edit/:id?created=1`。`toFilled(tpl.html, 共通sample)` を編集。

**不変条件**: 編集経路 = `tpl.filled`（per-fund 実値）+ ハイライト無し / 作成経路 =
`toFilled`（共通sample）+ ハイライト有り。経路の見分けは `route.query.created === '1'`。
ハイライトは `setVarsHighlight` が canvas body の `jinja-vars-highlight` クラスで出し分ける。

- ⚠ 絶対にやらない: ①素の `.jinja-chip.jinja-var` に `background` を直書きする（編集タブへ
  ハイライトが漏れる＝過去の `aa9bd65` 退行）。②filled/サンプルを全ファンド共通ダミーに潰す
  （編集タブが実値を失う＝過去の `42938a0` 退行）。
- **テンプレ作成の鉄則**: `toFilled` はテキストノードのみ値差込で、**属性内 Jinja は差し込まれない**
  （round-trip 保持のため原文のまま残る）。ゆえにデータ連動チャート（座標・幅を Jinja 属性で出す
  SVG/CSS）は編集キャンバスで空表示になるため**テンプレに入れない**。グラフは固定ジオメトリの
  静的 inline `<svg>` ＋隣接の値入りテーブル（テキスト）で構成する
  （雛形: `AM01_510037_20240710_交付版.html`）。
- 経緯メモ: 編集画面=値入りHTML編集は `7902a5f` で確立。本原則の関連ファイル — `loadForEdit`
  (`templateEditorService.ts`) / `jinjaComponents.ts`(ハイライトCSS) / `useGrapes.ts`
  (`setVarsHighlight`) / `useTemplateEditor.ts`(経路判定) / `sampleCommon.ts`・`sampleData.ts`・
  `genFilled.ts`(データ源) / `CreateTabView.vue`(query)。
- 強制の仕組み: PreToolUse フック `.claude/hooks/editor-two-systems-reminder.cjs`（上記ファイル
  編集時にリマインド）と、CI チェック（`editor/web/test` の 2系統ガードテスト、`pnpm run ci`
  に組込）を併設する。

## pie-chart

- 旧称 `graph2`（円グラフ SVG レンダラ）。2026-06 に `pie-chart` へ改称。
- SVG 出力は決定的。挙動保証は `npm run batch` → `npm run batch:diff`（`out/_baseline` との
  **byte-diff** を SHA256 で全件自動比較）。コメント/リファクタ等は出力バイト不変が鉄則。
  検証手順の正典は `pie-chart/README.md` の「検証」節。
- `.claude/hooks/pie-chart-baseline.cjs`（PreToolUse: Write|Edit）が編集前に
  `out/_baseline` を自動生成する。
- 配置パイプラインの設計正典は `pie-chart/ARCHITECTURE.md`（モード×パス対応表・do-no-harm
  ゲート使い分け・却下済み設計案）。下記 import でセッション起動時に読み込む。

@pie-chart/ARCHITECTURE.md
