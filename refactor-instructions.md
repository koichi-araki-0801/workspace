# リファクタリング指示書（refactor-instructions.md）

> 本書は実装担当モデル向けの指示書である。目的は**既存仕様を壊さずに技術的負債を減らし、今後変更しやすい状態にする**こと。見た目の綺麗さは目的ではない。古いコード＝悪ではない。**証拠なく大きな削除・全面書き換えをしてはならない。**

## 1. Objective

- editor（server / shared / web）、pie-chart、graph-editor、pdf-to-svg を対象に、本書 Debt Map に列挙した負債を、小さく戻しやすい単位で解消する。
- 各変更は既存挙動を保存し、フェーズごとに検証コマンドで確認する。
- 「提案のみ」と記された項目は**実装せず**、設計提案を Markdown で書いて止まる。

## 2. Project Understanding（前提知識）

### モノレポ構成（pnpm workspace、Node >=24 / pnpm >=11）

| ワークスペース | 役割 | エントリ |
|---|---|---|
| `editor/shared` (`@editor/shared`) | 共有 TS 型・DTO・Result/AppError・Repository 契約の正典 | `src/index.ts` |
| `editor/server` | Fastify + TS。テンプレ管理 REST・PDF 生成・git 版管理・承認ワークフロー | `src/app.ts` |
| `editor/web` | Vue3 + Vite + Pinia + GrapesJS。Jinja テンプレの GUI 編集・プレビュー・版比較・承認画面 | Vite (`:24681`) |
| `pie-chart` | 円グラフ SVG レンダラ（旧 graph2）。**SVG 出力は決定的、byte-diff 不変が鉄則** | `src/cli.ts` |
| `graph-editor` | pie-chart SVG のラベル位置エディタ（Python + Edge シェル） | `app.py` |
| `pdf-to-svg` | PDF→SVG 変換・用語統一デスクトップツール（Python + Edge シェル） | `run.py` |

ほかに `docs/`（Markdown/YAML 原稿 → docx/xlsx 生成）、`offline/`（GitHub Releases 経由のオフラインバンドル配布）、`scripts/`（CI・掃除）、`git-tools/`（air-gapped 用同梱バイナリ）。

### editor のデータフロー

- `route（Zod validate）→ repository（AppError throw）→ files/git/db → 中央 errorHandler が HTTP 変換`。サーバは throw 統一、web の rest 層が Result へ変換。
- REST パスの正典は `editor/shared/src/api-paths.ts`。OpenAPI は `editor/server/src/openapi/document.ts` が生成し、`openapi.test.ts` が全パス掲載を保証。
- web は Repository DI（`editor/web/src/api/repositories.ts`）で local（fixtures + localStorage）/ rest の二系統を `VITE_API_MODE` で切替。
- 実ファイル書込の唯一の物理経路は `editor/server/src/repositories/templateRepo.ts` の `applyConfirmedSave`（snapshot→write→git commit→失敗時ロールバック）。承認ワークフロー（`reviewRepo.approveReview`）と緊急直接保存（`confirmSave`、`requireApprover` 施錠）が共有する。

### 外部依存・環境

- air-gapped 運用が前提。**新規 npm/pip 依存の追加は原則禁止**（オフラインバンドルの content key に影響）。
- git 操作は `editor/server/src/git/gitRepo.ts` が CLI 直叩き（依存追加回避のため）。
- SQL Server（フェーズ2、`msnodesqlv8` optional）は未デプロイ。`middleware/auth.ts` は coverage 除外中。

## 3. Behaviors To Preserve（絶対に壊してはいけない挙動）

1. **editor 2系統の原則**（ルート CLAUDE.md 参照・最重要）: 編集タブ＝`tpl.filled`（per-fund 実値）＋ハイライト無し / 作成タブ＝`toFilled`（共通sample）＋ハイライト有り。経路判定は `route.query.created === '1'`。素の `.jinja-chip.jinja-var` に background 直書き禁止（退行 aa9bd65）。filled/サンプルの共通ダミー化禁止（退行 42938a0）。関連: `templateEditorService.ts` / `useGrapes.ts` の `setVarsHighlight` / `jinjaComponents.ts` / `genFilled.ts` / `CreateTabView.vue` / `sampleCommon.ts`。ガード: `test/twoSystems.guard.test.ts`。
2. **pie-chart の SVG byte 恒等**: いかなる変更後も `npm run batch` の出力が `out/_baseline` と byte 一致すること（コメントのみの変更でも）。
3. **gitRepo の identityEnv**: `GIT_AUTHOR_*`/`GIT_COMMITTER_*` を env で確定する仕組み（`gitRepo.ts:89-98`）と回帰テスト（`gitRepo.test.ts:67-83`）。外側フックからの env 漏れ事故の再発防止。
4. **worker fallback 機構**: `editor/web/src/workers/fallback.ts` のタイムアウト（30s）・`markBroken`・恒久フォールバック。プレビュー白紙障害の再発防止。
5. **api-paths ⇄ OpenAPI の同期**: `api-paths.ts` に足したパスは `document.ts` に載る（`openapi.test.ts` が守る）。
6. **coverage include 方式**: ルート `vitest.config.ts` は「テスト済みファイルのみ列挙して 85% ゲート」。include の削除・閾値の引き下げ禁止。
7. **承認ワークフローの職務分掌**: 自己承認拒否（admin 除く）、二重承認 409、submit の実ファイル非破壊、approve のみが `applyConfirmedSave` に到達。`PUT /templates/:id` は `requireApprover` 施錠。
8. **local モード（`requireAuth=false`）の無認証動作**: 認可ゲートが no-op になる現行仕様を変えない。
9. **オフライン配布の冪等性**: `offline/publish-offline-bundle.ps1` の content key 機構・ローリングタグ運用。
10. **保存済みデータ互換**: localStorage キー（`editor:reviews` 等）、`data/reviews/` のファイル形式、`baseHash` の djb2 値、git 履歴形式。既存データを読めなくする変更禁止。

## 4. Non-Negotiables（作業規律）

- **最初に `git status` を確認する。クリーンでなければ（未コミット変更があれば）作業を開始せず報告して止まる。** 本書は承認ワークフロー実装がコミット済みであることを前提とする。
- 既存の未コミット変更と自分の変更を混ぜない。
- 編集前に Baseline Commands の結果を記録する（§6）。
- 変更は小さく戻しやすい単位（1 コミット = 1 Debt ID を目安）にする。
- 無関係な整形・ついでのリファクタリングをしない。biome の対象範囲（lint は `editor/**` のみ、format は `editor/**`+`pie-chart/**`）を広げない。
- 既存挙動を勝手に変えない。正しさが不明な場合は実装を止めて質問する。
- 各フェーズごとに検証し、最後に実行したコマンドと結果を報告する（§9）。
- コメントは `docs/コメント規約.md` に従う（なぜを書く / 日本語散文 + 英語ドメイン用語 / 識別子バッククォート / 100 桁）。
- `.ps1` 新規作成時は同階層に同名 `.bat` ランチャ必須、日本語含む `.ps1` は UTF-8 BOM。
- editor 配下を変更したコミット前は `pnpm exec biome check --write editor/<対象>` を先行実行（lint-staged のステージ入替事故防止）。
- コミットは通常フローで行う（post-commit のバンドル公開・auto-push はベストエフォートで走る。無効化したい場合のみ `OFFLINE_PUBLISH_SKIP=1`）。フックを `--no-verify` で飛ばさない。

## 5. Stop And Ask Conditions（実装を止めて質問する条件）

- 正しい仕様がコードから判断できない（例: `fundRules.ts` の償還パーツ置換 TODO）。
- テストと実装が矛盾している。
- 削除候補コードが本当に不要か確証が持てない。
- 公開 API・DB schema・保存済みデータ（localStorage / `data/reviews/` / git 履歴 / baseHash 値）に影響する可能性がある。
- 認証・認可・外部連携（GitHub Releases、SQL Server）に影響する可能性がある。
- pie-chart で byte-diff が変化した（＝即中断・原因調査・報告）。
- 複数の設計案がありプロダクト判断が必要（§7 の「提案のみ」項目はすべてこれに該当）。
- 新規依存（npm / pip）を追加したくなった。

## 6. Baseline Commands（着手前に実行し結果を記録）

```powershell
git status                      # クリーンであること（必須条件）
git log --oneline -3            # 開始時点の HEAD を記録
pnpm run ci                     # フル検証の正典: check:comments && check:ci && typecheck && test:coverage(85%) && build && test:e2e
```

- 部分実行: `pnpm run ci:editor` / `ci:pie-chart` / `ci:graph-editor`（coverage 閾値は通らない点に注意。最終検証はフル `ci`）。
- typecheck が shared の型解決で落ちる場合は先に `pnpm --filter @editor/shared build`。
- pie-chart を触る前に: `cd pie-chart && npm run batch` 後、`out/svg_js` 全ファイルの SHA256 を記録（PowerShell: `Get-FileHash out/svg_js/*.svg`）。`.claude/hooks/pie-chart-baseline.cjs` が `out/_baseline` を自動生成するが、自分でもハッシュ一覧を保存しておく。
- Python 系: `pdf-to-svg` は `pytest`（`pdf-to-svg/tests/`）、graph-editor は `playwright test`（`graph-editor/test/*.e2e.ts`）。

## 7. Debt Map

各項目: **根拠 / なぜ負債か / 影響範囲 / リスク / 改善案 / 検証 / 可否**。
可否 = ✅今実装してよい / 🛑提案のみ（設計提案を書いて止まる）。

### 7.1 editor/server + shared

**S1. `getReview` の所有者フィルタ欠落（認可非対称）** — ✅

- 根拠: `editor/server/src/routes/reviews.routes.ts:52-54` は `requireAuth` のみ。一覧（`reviewRepo.ts:93` 付近）は非承認者を own のみに絞るのに、詳細取得は id 指定で他人の申請本体（html/css）を読める。
- なぜ負債: 一覧と詳細で認可規則が非対称。設計文書（`docs/editor/承認ワークフロー設計.md`）の可視範囲と不整合。
- 影響/リスク: サーバのみ。低（web の既存導線は own か approver 経由のみ）。local モード（requireAuth=false）は従来通り全通し。
- 改善案: `getReview` にも「approver/admin または申請者本人のみ」のフィルタを適用。該当しない場合は 403（既存 AppError 体系で）。
- 検証: `reviews.test.ts` 系にロール別アクセスのテストを追加（editor が他人の reqId → 403、本人 → 200、approver → 200）。

**S2. `baseHash` 突き合わせ未実装（並行性警告）** — ✅

- 根拠: `reviewRepo.ts:76` で submit 時に保存するが、`approveReview`（`reviewRepo.ts:108-139`）が現行版と突き合わせない。型コメント（`shared/src/index.ts:193-194`、`schemas.ts:350`）と設計文書は「承認時に不一致なら**警告、強制ブロックせず**」と明記。
- なぜ負債: 保存するだけで使われないフィールド＝死にかけの契約。設計済み仕様の実装漏れ。
- 影響/リスク: server（approve 応答に警告フィールド追加）＋ shared 型 ＋ web 承認画面の警告表示 ＋ OpenAPI。中リスク（API 応答形が変わるため、shared → server → web の順で型を通す）。
- 改善案: approve 時に現行テンプレの content key を再計算し、`baseHash` 不一致なら応答に `staleWarning: true`（命名は既存スキーマ慣習に合わせる）を含める。ブロックしない。web の `ReviewDiffView` で警告表示。
- 検証: server テスト（不一致で警告 true / 一致で false、承認自体は両方成功）、`openapi.test.ts` 通過、web は表示ロジックのユニットテスト。

**S3. reviews ルート層の HTTP 結合テスト不在** — ✅（安全網、S1/S2 より先に着手）

- 根拠: `editor/server/test/reviews.test.ts` は repo 直呼びのみ。ルート＋認可＋validate の結合は未検証。`listReviews` のロール別可視範囲・`getReview` 認可も未テスト。
- 改善案: Fastify inject による HTTP レベルテストを追加（submit→list→get→approve/reject、ロール別 401/403、zip 系は不要）。
- 検証: `pnpm run test:editor`。coverage include に既登録の範囲が下がらないこと。

**S4. reviews のクエリ手動パースが validate 機構と不統一** — ✅

- 根拠: `reviews.routes.ts:46-48` が status を手動パース。`ReviewListQuery` スキーマ（`openapi/schemas.ts:379`）が存在するのに `middleware/validate.ts` を通していない。
- 改善案: 既存 `validate` preHandler に統一。`templates.routes.ts:34-40` の series 必須チェック直書きも同様にスキーマへ寄せる（挙動＝エラー種別/メッセージが変わる場合は既存挙動に合わせるか、変わる旨を報告）。
- 検証: 既存＋S3 のテスト、`openapi.test.ts`。

**S5. `templateRepo.ts:204` の生 `console.warn`** — ✅

- 根拠: git コミット失敗のベストエフォート処理が構造化 logger でなく console 直書き。プロジェクト内で唯一の逸脱。
- 改善案: Fastify の pino logger（または既存のロガー注入経路）に置換。ログレベルは warn のまま。
- 検証: `pnpm run test:editor` / typecheck。

**S6. ルートハンドラの手動型キャスト（約35箇所）** — ✅（機械的・低リスクだが量が多いので独立コミット群に）

- 根拠: `request.params as { id: string }` / `request.body as z.infer<...>` が routes 全域に散在（`templates.routes.ts` 全域、`reviews.routes.ts:21-22,30,46` 等）。
- なぜ負債: validate 済みという前提が型に現れず、スキーマ変更時に黙って乖離する。
- 改善案: Fastify の RouteGeneric（`Params`/`Body`/`Querystring` ジェネリック）で型付けし as を撤去。1 ルートファイル = 1 コミット。
- 検証: `pnpm run typecheck` + `test:editor`。挙動変更ゼロ（型のみ）。

**S7. shared TS 型 ⇄ server Zod スキーマの二重定義** — 🛑提案のみ（ユーザー決定済み）

- 根拠: `openapi/schemas.ts:12`「index.ts と常に同期させること」。手動同期依存。
- 改善案の方向性だけ文書化: (a) shared に zod を導入し型導出へ一本化（web バンドルへの zod 混入と依存方向の検討が必要）、(b) 現状維持＋同期検査テスト追加、等の選択肢比較を書く。**実装しない。**

### 7.2 editor/web

**W1. reviews 機能のテスト・ゲート欠落** — ✅（安全網、最優先）

- 根拠: `features/reviews/services/reviewDiffService.ts`（98行）はテスト無し・coverage include 未登録。`api/local/reviewRepo.ts` は `test/reviewRepo.local.test.ts` が在るのに include 未登録。View 2本（`ReviewDiffView.vue` 290行 / `ReviewQueueView.vue` 135行）と `api/rest/reviewRepo.ts` も未テスト。同時期追加の `cropMarks.ts` / `workers/fallback.ts` は最初からテスト＋ゲート済みで非対称。
- 改善案: ① `reviewDiffService.ts` のユニットテスト新設 → include 登録、② `localReviewRepo` を include 登録（テスト既存）、③ rest 実装は他 rest リポと同水準（現状 rest 系は include 外）なので現状維持で可。
- 検証: `pnpm run test:coverage` が 85% を維持して通ること。

**W2. iframe 自動フィット処理の重複** — ✅

- 根拠: `ReviewDiffView.vue:89-110`（`fitTo`/`fitFrame`/ResizeObserver）が「CompareResultView と同方式」とコメント付きで別実装。
- 改善案: 共有 composable（例 `features/compare` か `components/` 配下、既存配置慣習に従う）へ抽出し両 View から利用。DOM 挙動は現状維持。
- 検証: 抽出した composable のユニットテスト（jsdom で ResizeObserver モック）、`test:editor`、目視は `pnpm run dev` で比較画面と承認画面。

**W3. ハイライト CSS の二重管理** — ✅

- 根拠: `ReviewDiffView.vue:76-84` の `HIGHLIGHT_CSS` が compare の `HL_*` 定数を import しつつ CSS 文字列を再定義（コメントで二重管理を自認）。
- 改善案: compare 側に CSS 文字列の単一ソースを設け、両者が参照。着色結果は byte 単位で現状一致させる。
- 検証: 既存 `htmlBlockDiff.test.ts` / `compareService.test.ts` ＋ W2 のテスト。

**W4. `AttributeBar.vue` の配置ずれ（features 間横断依存）** — ✅

- 根拠: `ReviewDiffView.vue:27`・`ReviewQueueView.vue:15` が `features/editor/AttributeBar.vue` を import。editor 固有名の下にある共有 UI。
- 改善案: `components/` へ移動し import を張り替え（git mv、中身は変更しない）。
- 検証: typecheck ＋ dev 起動での目視（editor / reviews 両画面）。

**W5. `ReviewDiffView.vue` のロジック直書き** — ✅（W2/W3 の後に）

- 根拠: iframe 管理・`buildDoc`・STATUS_BADGE 等を View 内に抱え、他 feature が composable/service へ委譲する慣習（例: `EditorView.vue` → `useTemplateEditor`）と非対称。
- 改善案: `features/reviews/` 配下に composable（例 `useReviewDiff.ts`）を新設してロジック移動。テンプレートの見た目・挙動は不変。
- 検証: 抽出分のユニットテスト追加＋include 登録、dev 起動目視。

**W6. `contentKey`(djb2) の独自実装** — 🛑提案のみ

- 根拠: `api/local/reviewRepo.ts:32-37`。`lib/blockKey.ts` の `rawKey` と役割が近い。
- 理由: **保存済み `baseHash` 値との互換**に影響しうる（ハッシュ関数を替えると既存申請の突き合わせが壊れる）。共有化する場合の移行方針を提案として書くに留める。

**W7. `useGrapes.ts`（901行）ほか editor 巨大 composable の分割** — 🛑提案のみ

- 根拠: `useGrapes.ts` 901 / `Inspector.vue` 653 / `EditorView.vue` 525。GrapesJS/iframe 依存で coverage ゲート外、安全網が無い。2系統の原則の中核（`setVarsHighlight`）を含む。
- 理由: テスト不能な巨大領域を安全網なしに動かすのは本書の趣旨に反する。分割案（責務境界・テスト戦略）を提案として書くに留める。

**W8. `fundRules.ts` の TODO（償還パーツ置換ルール）** — 🛑質問行き

- 根拠: `api/local/fundRules.ts:21,47` が TODO のままモック実装。`CreateTabView.vue:29` にも「⑦・モック」注記。
- 理由: 正しい仕様がコードから判断できない。触らず、§11 の質問として人間に返す。

### 7.3 pie-chart（byte-diff 不変の鉄則下）

**PC1. `assertOracleSync` が CI 外（オラクル定数の drift 検知が手動）** — ✅

- 根拠: `verify_svg.ts:79-86` が本体（`config.ts` 等）から定数を意図的に手動複製し、`assertOracleSync()`（`verify_svg.ts:103-172`）で照合するが、これは手動 `npm run verify` 時のみ実行。CI（`ci-affected.mjs:32-35` の pie-chart ステージ）は typecheck+test のみ。
- 改善案: `assertOracleSync` を呼ぶだけの小さな vitest テストを `pie-chart/test/` に追加（既存関数の再利用のみ、レンダリング不実行）。SVG 出力に一切触れない。
- 検証: `pnpm run test:pie-chart` 通過。**`npm run batch` → `out/_baseline` と byte 一致**（テスト追加のみなので当然一致するはずだが、鉄則なので必ず実施）。

**PC2. byte-diff 回帰（baseline 比較）が完全手動** — 🛑提案のみ

- 根拠: README は「batch 後に SHA256 比較」と記すが自動比較スクリプトは存在せず、`out/` は git 追跡外。CI に byte 恒等ゲートが無い。鉄則を守る最後の砦が人手。
- 理由: 自動化には「baseline SVG（83件）を git にコミットする」等のリポジトリ方針の決定が必要（生成物のコミット可否、オフラインバンドル content key への影響）。比較スクリプト案＋コミット方針の選択肢を提案として書くに留める。

**PC3. `svg_export/index.ts`（4135行）のゴッドファイル** — 🛑提案のみ

- 根拠: Pass1/Pass2 配置探索・スタック・クランプ等が同居。coverage 計測外（include はコメントで「verify_* が担当」と明記）。
- 理由: 純粋なファイル分割は原理上 byte 不変だが、baseline 比較が手動（PC2）のうちは検証コストが高くリスクに見合わない。PC2 の方針決定後に分割案を提案。

**PC4. `xlsx_loader.ts:60-78` の `any`（入力境界）** — ✅（小粒・任意）

- 根拠: exceljs の弱い型に対する `unwrapCellValue(value: any): any`。
- 改善案: `unknown` ＋ナローイングへ置換（型のみ、実行コードのパス不変）。
- 検証: `pnpm run typecheck:pie-chart` + `test:pie-chart` + **batch→baseline byte 一致**。

**PC5. `noImplicitAny:false`（pie-chart / graph-editor tsconfig）** — 🛑提案のみ

- 根拠: `pie-chart/tsconfig.json:8`、`graph-editor/tsconfig.json:6`。
- 理由: 有効化には広範な注釈追加が必要で変更量が大きい。型のみで byte 不変とはいえ、対象行数が多く本書の「小さく戻しやすい単位」に反する。段階案を提案に留める。

### 7.4 graph-editor / pdf-to-svg

**G1. Edge ランチャ Python の逐語重複** — 🛑提案のみ

- 根拠: `graph-editor/app.py:33-230` と `pdf-to-svg/src/app.py:30-167` で `_find_edge`/`_idle_watchdog`/`_watch_proc`/`EDGE_*` 定数がほぼ逐語コピー（`src/app.py:4` に「graph-editor と同方式」と明記）。
- 理由: 共有モジュール化は両アプリの exe ビルド（隔離 venv、`scripts/build.ps1`）とオフライン配布に影響する。パッケージング方式の判断が必要なため提案に留める。

**G2. フォント原本の物理重複（git 追跡 約26MB）** — 🛑提案のみ

- 根拠: `pdf-to-svg/fonts/`（TTF 約22MB）と `pie-chart/fonts/`（WOFF2 約4MB）が同一 BIZ UDPGothic を形式違いで重複同梱。
- 理由: 共有ディレクトリへの一本化はビルド・配布・オフラインバンドルに波及。提案のみ。

**G3. フロント JS の未テスト（`editor.js` 1109行 / `app.js` 927行）** — 一部✅

- 根拠: graph-editor `resources/web/js/editor.js`（1109行）と pdf-to-svg `resources/web/app.js`（927行）はユニットテスト無し。graph-editor は `leader_geom.cjs`（62行）のみテスト済み。
- 改善案（✅の範囲）: **リファクタせず**、既存の純粋モジュール `graph-editor/resources/web/js/label-state.js`（193行）に対する特性テスト（characterization test）を現状挙動そのままで追加。CommonJS/ブラウザ両対応が必要なら `leader_geom.cjs` の UMD パターンを踏襲。**editor.js / app.js 本体の分割は🛑提案のみ**（E2E の薄い安全網しかないため）。
- 検証: `pnpm run test:graph-editor`、`test:e2e`（graph-editor）。

**G4. pdf-to-svg フロントのテストゼロ素通り** — ✅（小粒）

- 根拠: `pdf-to-svg/package.json:7` の vitest が `--passWithNoTests`（テストが 1 本も無いのに緑になる）。
- 改善案: G3 同様の方針で、`resources/web/` 内の純粋関数（geometry 系等、実在を確認のうえ）に最小の特性テストを 1 本以上追加し、`--passWithNoTests` を外す。純粋関数が本当に抽出不能なら現状維持で報告。
- 検証: `pnpm --filter pdf-to-svg run test`。Python 側は `pytest` が既に充実（触らない）。

### 7.5 docs / 横断

**D1. `editor/README.md` の「Express」表記が実装（Fastify）と不一致** — ✅

- 根拠: README は「Express + TS」「Express から child_process」と記述、実装は Fastify（`editor/server/package.json`、`app.ts`）。
- 改善案: 表記を Fastify に修正（正誤訂正のみ、構成の書き直しはしない）。
- 検証: 目視。`docs/` の生成物（docx）再生成は不要（README は生成対象外）。

**D2. GH Actions が `check:comments` を含まない** — 🛑提案のみ

- 根拠: `.github/workflows/ci.yml` の verify job はローカル `pnpm run ci` と違い `check:comments` を呼ばない。
- 理由: CI 構成変更は運用判断（GH Actions は「保険」位置づけのメモあり）。1 行追加の提案として書くに留める。

## 8. Implementation Phases（この順に実施。各フェーズ末尾で検証・コミット・報告）

**Phase 0 — 現状確認とベースライン記録**

1. `git status` クリーン確認（違反なら即停止・報告）。`git log --oneline -3` 記録。
2. `pnpm run ci` を実行し全結果を記録（これが比較基準）。失敗するものが既にあれば**修正せず**報告して指示を仰ぐ。
3. pie-chart: `npm run batch` → `out/svg_js` の SHA256 一覧を記録。

**Phase 1 — 安全網の追加（挙動変更ゼロ）**

- S3（reviews HTTP 結合テスト）→ W1（reviewDiffService テスト＋include 登録、localReviewRepo include 登録）→ PC1（assertOracleSync の vitest 化）→ G3✅範囲（label-state.js 特性テスト）→ G4。
- 注意: このフェーズのテストは**現状挙動をそのまま固定**する。S1 の認可欠落は Phase 1 では「現状（editor が他人の申請を読める）」をテストに書かず、対象外にしておく（Phase 2 で仕様側に倒す）。

**Phase 2 — 仕様確定済みの機能穴の修正**

- S1（getReview 所有者フィルタ）→ S2（baseHash 警告。shared 型 → server → OpenAPI → web 表示の順）。
- 各修正はテストファースト（期待挙動のテストを先に書き、赤→緑を確認）。

**Phase 3 — 明らかに安全な整理**

- S5（console.warn→logger）→ S4（validate 統一）→ PC4（xlsx_loader の unknown 化）→ D1（README 正誤訂正）。

**Phase 4 — 小さな責務分離（web）**

- W2（iframe-fit composable 抽出）→ W3（ハイライト CSS 単一ソース）→ W4（AttributeBar 移動）→ W5（ReviewDiffView の composable 抽出）。
- 各ステップ後に `pnpm run test:editor` ＋ dev 起動で compare / reviews / editor 画面を目視。

**Phase 5 — 境界と型の明確化（server）**

- S6（RouteGeneric 型付け、1 ルートファイル＝1 コミット）。

**Phase 6 — 提案書の作成（実装しない）**

- S7 / W6 / W7 / PC2 / PC3 / PC5 / G1 / G2 / G3🛑範囲 / D2 について、`refactor-proposals.md` を新規作成し、各項目に「現状・選択肢・推奨・移行手順・リスク」を記述して**止まる**。承認なしに実装しない。

**最終 — フル検証**

- `pnpm run ci` を通す。pie-chart に触れた場合は `npm run batch` → baseline と byte 一致を確認、`npm run verify` も実行。

## 9. Verification Requirements

- 各フェーズ完了時: 該当領域の `pnpm run ci:editor` / `ci:pie-chart` / `ci:graph-editor` ＋ 変更内容に応じた個別テスト。
- 最終: フル `pnpm run ci`（coverage 85% ゲート含む）。
- pie-chart を 1 行でも触ったら: `npm run batch` → `out/_baseline` との byte 一致（SHA256 突合）。不一致なら**その変更を revert して報告**。
- web の UI に触れたら: `pnpm run dev` で該当画面を目視（編集タブでハイライトが出ない / 作成タブ `?created=1` で出る、の 2系統確認を含む）。
- テストを「通すために」既存アサーションを弱めることを禁止する。

## 10. Reporting Format（作業完了時の報告様式）

```
## 実施サマリ
- 完了した Debt ID とコミット一覧（1 行ずつ: ID / コミットハッシュ / 概要）
- 提案のみに留めた項目と提案書の場所
## 検証結果
- 実行したコマンドと結果（Baseline との差分。省略せず、失敗があればそのまま記載）
- pie-chart byte-diff の確認結果（該当時）
## 未完了・質問
- 止まった項目とその理由（Stop And Ask のどれに該当したか）
```

## 11. 実装前に確認すべき質問（人間への質問。回答があるまで該当項目に着手しない）

1. **fundRules の償還パーツ置換ルール**（W8）: `editor/web/src/api/local/fundRules.ts:21,47` の TODO の正しい仕様は何か。当面モックのまま維持でよいか。
2. **pie-chart baseline の git コミット可否**（PC2）: byte-diff 回帰を CI 自動化する場合、基準 SVG（83件）をリポジトリにコミットしてよいか（生成物コミットの方針判断）。
3. **S2 の警告フィールド名と UI 文言**: `baseHash` 不一致警告の応答フィールド名・承認画面での表示文言に指定はあるか（無ければ実装者が既存命名慣習で決めてよい、と本書は解釈する — 異論があれば回答されたい）。

## 12. Out-of-scope（本書では扱わない）

- 新機能の追加、UI デザイン変更。
- `docs/` 生成物（docx/xlsx）の再生成、`docs/_build/` エンジンの改修。
- `offline/` スクリプト群・GitHub Releases 運用・git-tools。
- SQL Server フェーズ2（`msnodesqlv8`、`middleware/auth.ts` の coverage 除外解除）。
- 依存パッケージの更新・追加・削除（npm / pip とも）。
- glyph_advance.ts（自動生成物）の手編集。
- git 履歴の書き換え、ブランチ運用の変更（squash 運用・常設ブランチは現状維持）。
