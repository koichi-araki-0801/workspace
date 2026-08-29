# リポジトリ横断 既存バグ修正 v2（全件）— 実行プラン

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 2026-08-18〜20 の 2 巡調査で確定した全バグ（critical 2 / high 15 / medium 30+ / low 若干）を Wave A〜G の 7 波で修正する。

**Architecture:** 指揮・修正後確認 = セッション本体（Fable 5）。実装 = Wave ごとに `model: "opus"` のサブエージェントへ Task 単位で委譲（TDD・1 Task = 1 コミット）。各 Task 完了時に指揮者が diff 精読 + テスト再実行 + reflog でコミット実在確認を行い、NG は差し戻す。Wave 完了ごとにユーザーへ報告。

**Tech Stack:** Python 3 + pytest（pdf-to-svg / docs）、素の JS + vitest + Playwright（graph-editor / pdf-to-svg）、Vue3 + TS + vitest（editor）、TS + vitest（pie-chart）、PowerShell + Pester（offline）、Node ESM（scripts / hooks）。

**Spec:** 調査結果の正典はスマホ向け計画ページ（Artifact「ワークスペース修正計画」）と本プラン各 Task の記述。Wave A の A1/A2、B の B1、E の E1、F の F1〜F3、G の G1 前半は詳細版 `docs/superpowers/plans/2026-08-18-repo-wide-bugfix-batch.md`（v1）にテストコード全文があり、実装者はそちらを一次資料とする。

## Global Constraints

- コメント規約 = `docs/コメント規約.md`。チャット圧縮文体をコード・コメント・コミットメッセージへ持ち込まない。
- コミットは `fix(<scope>): 日本語要約`。commit ごとに auto-push フックが走る（失敗時は放置せず指揮者へ報告）。
- 実装者は **コミット直後に `git log --oneline -1` と `git status --short` を出力し報告に含める**（コミット消失事故対策。指揮者は reflog で実在検証する）。
- pie-chart は byte 不変が鉄則。座標に触る Task は `npm run batch` → `npm run batch:diff` の差分を報告し、意図的差分は baseline + スナップショットを同コミットで更新。
- editor/** を変更するコミット前は `pnpm exec biome check --write editor/<対象>` を先行実行。
- `@editor/shared` に触れたら `tsc -b editor/server` を先行してから typecheck。
- 日本語を含む .ps1 は UTF-8 BOM 維持。
- フル CI はユーザーに `!` で依頼（実機 8GB 制約。プラン内の検証は領域別コマンドで行う）。
- 検証コマンド: pdf-to-svg = `cd pdf-to-svg && python -m pytest` / graph-editor = `pnpm run test:graph-editor` + `pnpm run typecheck:graph-editor`（+ e2e は Wave 末尾）/ editor = `pnpm run test:editor` + `pnpm run typecheck:editor` / pie-chart = `pnpm run test:pie-chart` / offline = `pnpm run ci:offline` / docs = `python -m pytest docs/_build` / scripts = `pnpm run test:scripts`。

---

## Wave A: pdf-to-svg（10 Task）

### A1: 削除一覧「戻す」を要素単位へ（critical）
v1 プラン Task 1 の全文どおり実装（`RestoreCommand` / `restoreElements` RPC / `removedList` の畳み込み行除外 / app.js 差し替え / e2e / docs 3 冊 + HTML 再生成）。
- 受け入れ: v1 Task 1 の Step 1 テスト 3 本 + e2e 追記が PASS。`HANDLERS` 24 メソッド。

### A2: dictAdd / dictDelete 後の reloadState（high）
v1 プラン Task 2 の全文どおり。
- 受け入れ: e2e「辞書追加だけで要確認 1」PASS。

### A3: undo / redo 後の全ページ invalidate（high）
**Files:** `resources/web/app.js`（`btn-undo`/`btn-redo` ハンドラ :732 付近、Ctrl+Z/Y :849 付近、`afterEdit` 分離）
- `afterEdit` は現在ページ用のまま残し、undo/redo 専用に `afterUndoRedo()` を新設: **全ページの svgCache を破棄** + `reloadState()` + `render()`。
- 受け入れ: state.test.js に「invalidateAll 相当でキャッシュ全消去」の単体（キャッシュ機構が state.js 側なら）または e2e「ページ 1 削除 → ページ 2 へ → Undo → ページ 1 に要素が再表示」PASS。

### A4: キーボードショートカットのフォーカス / 空状態ガード（high）
**Files:** `resources/web/app.js:849-852`
- `e.target` が input / textarea / contenteditable なら return。`S.TOTAL === 0` または `S.PAGES[S.page]` 不在なら return。`e.preventDefault()` を発火時のみ。
- 受け入れ: e2e「辞書入力欄で Ctrl+Z → 文書 undo が発火しない（削除一覧の件数不変）」PASS。

### A5: ZIP 書き出しの失敗通知と 8MiB 対策（high）
**Files:** `resources/web/app.js:877-920`（`doExport`）
- `doExport` 全体を try/catch し、失敗時 toast + ヒント復帰。
- 送信前に `entries` の合計文字数を概算し、8MiB（`MAX_RPC_BYTES`）の 9 割超なら entries を分割して複数 ZIP（`{zipName}_1.zip`, `_2.zip`…）で逐次ダウンロード。サーバ変更なし。
- 受け入れ: 単体（分割境界の計算関数を純関数に切り出して vitest）+ 失敗経路の e2e または手動確認報告。

### A6: mountPage の競合（wire 二重付与・旧 SVG 上の操作）（medium）
**Files:** `resources/web/app.js:209-228, 634-650`
- フェッチ開始時に host へ「読み込み中」表示を入れ旧 SVG を残さない。`.then(wireTrimStage)` 等は token 一致チェックの**内側**へ移し、不一致時は wire しない。
- 受け入れ: e2e（2 ページ以上の fixture でページ連続切替 → クリック選択が 1 回でトグル）PASS。

### A7: addFiles の途中失敗（medium）
**Files:** `resources/web/app.js:130-140`
- ループを try/catch し、失敗ファイル名を toast で通知、成功分は `reloadState()` を必ず実行してから終了。
- 受け入れ: 失敗パスの単体（rpc をモック）or e2e。

### A8: applyState 後の selFor / collapsed 残留（medium）
**Files:** `resources/web/state.js:94-109`、`resources/web/app.js`
- `applyState` でページ列が変わったとき `selFor` / `collapsed` もクリア（`svgCache`/`elSel` と同列へ）。
- 受け入れ: state.test.js に「removeFile 相当の applyState 後 selFor が空」追加、PASS。

### A9: planPage / removedList 失敗時の旧ペイン残留（medium）
**Files:** `resources/web/app.js:255, 381`
- 両取得を try/catch し、失敗時はペインへ「取得に失敗しました（再試行）」を表示（旧ページの行とクロージャを残さない）。
- 受け入れ: rpc モック単体 or 実装者の手動確認報告（e2e はサーバ例外注入が重いので任意）。

### A10: 辞書チェーン後の「戻す」で畳み込み行が復元不能（medium）
**Files:** `src/web/commands.py`（`ReplaceTextCommand.redo`）、`test/test_dict_revert.py`
- 方針: **`dict_revert` は最初の置換のものを保持**（既に revert 情報がある要素への再置換では上書きしない）。「戻す」は常に元の原文まで一段で戻り、extras も復元される。
- 受け入れ: 新テスト「A→B 置換（extras あり）→ B→C 再置換 → RevertDictMatch → text=A・extras 再表示・dict_revert=None」PASS。既存 test_dict_revert 全 PASS。

**Wave A 完了時:** `cd pdf-to-svg && python -m pytest` 全通過 + Playwright e2e 全通過 + docs 再生成差分コミット済みを確認して報告。

---

## Wave B: graph-editor（7 Task）

### B1: `_auto` を STATE_FIELDS へ + startLeaderDrag 修正（high）
v1 プラン Task 3 の全文どおり。

### B2: パーセント表示の再構築を実表示文字列ベースへ（high）
**Files:** `resources/web/js/label-state.js:120 付近`、`test/`（vitest 追加）
- 読込時に percent 行 tspan の **textContent をそのまま保持**し、`rebuildTextContent` はそれを再利用する。`data-percent` からの `${v}%` 再生成をやめる（`data-percent` は行判定にのみ使う）。
- 受け入れ: vitest「表示 `100.8%` / `△0.8%`・`data-percent=99.2/0.8` の DOM で行数 1⇄2 を往復してもテキスト不変」PASS（jsdom なしで文字列組み立て部を純関数化するか、既存流儀の DOM 非依存分離に従う）。

### B3: parsePieGeometry の全円ガード（high）
**Files:** `resources/web/js/pie-rules.js:9-19`、`test/`（既存の pie-rules vitest へ追加）
- `L` コマンド不在なら null を返す（`sliceMidAnchor` 側の `/M…L…A/` ガードと対称）。null 時は既存の `fallbackPieGeometry` 経路。
- 受け入れ: vitest「`M300,67.5 A…A…Z`（実サンプルの d 値）→ null」「楔形 d → 従来どおり cx,cy,r」PASS。

### B4: ファイル切替時の未保存編集確認（high）
**Files:** `resources/web/js/editor-render.js`（レール / カードのクリック）、`editor-io.js`
- 切替先が現ファイルと異なり、かつ `ed.labels.some(isLabelEdited)` なら confirm（btnReset と同系文言）。キャンセルで切替中止。
- 受け入れ: e2e「編集 → 別ファイルクリック → ダイアログ表示、キャンセルで編集保持」PASS。

### B5: キーボード配線の phase / フォーカスガード + 矢印キー履歴（medium）
**Files:** `resources/web/js/editor-events.js:70-107`、`editor.js:402-415`
- 入力フォーカスガードを配線の**先頭**へ。Ctrl+Z/Y/S/O・矢印・Delete は編集画面表示中（phase 2）のみ有効。
- 矢印キーは `keydown.repeat` の間 `pushHistory` を初回のみにする（リピート中は積まない）。
- 受け入れ: vitest（ガード関数の純関数化）+ e2e スモーク。

### B6: 行数 / 長体変更後の leader 端点再スナップ（medium）
**Files:** `resources/web/js/constants.js`（`INSPECTOR_ACTIONS` の lineCount / nameScaleX 系 run）、`editor.js`
- 該当 action の後処理として bbox 再計測 → `snapEndpointToFrame` を実行（`flushNow()` で DOM 確定後）。
- 受け入れ: e2e「2 行化後も末尾端点がラベル外枠上（既存不変条件テストの流儀）」PASS。

### B7: abortLoad の表示アイデンティティ残留（low）
**Files:** `resources/web/js/editor-io.js:20-35`
- `abortLoad` で `ed.name` / `ed.currentId` も空へ戻す。
- 受け入れ: 既存 vitest 流儀で単体 or e2e（不正 SVG 読込 → レールに「現在編集中」マークが残らない）。

**Wave B 完了時:** vitest + typecheck + `pnpm --filter graph-editor run test:e2e` 全通過（docs スクショ再撮影差分はそのままコミット）を確認して報告。

---

## Wave C: editor web（10 Task）

### C1: Redo の順序破壊（critical）
**Files:** `web/src/features/editor/useSnapshotHistory.ts:80`、`web/src/stores/editorSession.ts:96`、`web/test/useSnapshotHistory.test.ts`
- `future.shift()` → `future.pop()`。editorSession の永続 slice は末尾保持（`slice(-CAP)`）へ。
- 受け入れ: 新テスト「A→B→C 編集、undo×2 → redo で B、redo で C、past が [A,B] 相当」PASS。

### C2: 無編集 dirty ①: blur だけで draft / Redo 消滅（medium）
**Files:** `web/src/features/editor/Inspector.vue:189-203`、`useTemplateEditor.ts:218-228`（applyGeom）、`useGrapes.ts:531`（patchSelectedStyle）
- `commitNum` は現値と同値なら emit しない。`applyGeom` は差分ありのときだけ `pushUndo`。`patchSelectedStyle` は同値なら change コールバックを呼ばない。
- 受け入れ: テスト「幅入力欄 focus→blur（値不変）で dirty=false・undo 深さ不変」PASS。

### C3: 無編集 dirty ②: プレビュー / 精査遷移で draft 生成（medium）
**Files:** `web/src/features/editor/EditorView.vue:103-120`、`web/src/features/editor/useAutosave.ts:29-47`
- `flush()` は pending も dirty も無ければ no-op に。`goPreview` / `goReview` はそのまま `flush()` 呼びでよい（no-op 化で解決）。
- 受け入れ: テスト「開く→goPreview→hasDraft=false」PASS。

### C4: 無編集 dirty ③: 編集開始 pushUndo で future 消滅（medium）
**Files:** `useTemplateEditor.ts:377-393`、`web/src/features/editor/useGeomHandles.ts:50`、`useSnapshotHistory.ts`
- `pushUndo` 相当を「変更が実際に起きた時点」へ遅延（開始時は capture のみ保持し、初回変更で past へ積む）。`discardLast` 頼みの現構造を置き換え、無変更終了では past / future とも不変。
- 受け入れ: テスト「undo 1 回 → テキスト編集開始 → 無変更で終了 → redo 可能なまま」PASS。

### C5: draft 破棄と autosave の競合（medium）
**Files:** `useTemplateEditor.ts:439-460`、`useAutosave.ts`
- `useAutosave` に `cancel()`（debounce 破棄）と in-flight Promise の公開を追加。破棄確定時は `cancel()` → in-flight 完了待ち → `discardDraft`。`flush` は in-flight 中は同一 Promise を返す（並行二重保存防止）。
- 受け入れ: テスト「debounce 発火予約中に破棄 → saveDraft は飛ばず draft 無し」「flush 並行呼びで saveDraft 1 回」PASS。

### C6: Undo ミラーのユーザー非分離（medium・優先度高）
**Files:** `web/src/lib/storageKeys.ts:30`、`web/src/stores/editorSession.ts:41-57`、`web/src/stores/auth.ts:59-66`
- Undo ミラーのキーへユーザー識別（rest = ログイン ID、local = 固定）を含める。logout で `editor:session:undo` 系キーを**全ユーザー分ではなく現行キーを**削除 + 念のため旧形式キーも削除。
- 受け入れ: テスト「ユーザー A で hydrate 保存 → logout → ユーザー B でキーが別・A の内容へ到達しない」PASS。

### C7: stale 応答 4 経路の世代ガード（medium）
**Files:** `web/src/lib/`（`useLatest.ts` 新設: 呼び出しごとに世代を採番し、応答時に最新世代のみ反映するヘルパ）、`features/templates/EditTabView.vue:25-39`、`CreateTabView.vue:61-71`（resolveFund + err 時 toast）、`lib/useCascadingSelect.ts:36-64`、`features/reviews/ReviewQueueView.vue:129-141`
- 受け入れ: `useLatest` の単体（後着の旧世代が捨てられる）+ 各画面の適用をコードレビューで確認。

### C8: 二重送信ガード（medium）
**Files:** `CreateTabView.vue:126-137`（createFromSeries に creating ガード）、`components/TemplateTable.vue:295`（作成 Button disabled）、`features/admin/AdminView.vue:68-82`（addUser に in-flight ガード）
- 受け入れ: テスト or コンポーネント単体（連打で repo 呼び出し 1 回）。

### C9: 認証導線（medium）
**Files:** `router/index.ts:130-140`、`features/auth/LoginView.vue`、`api/rest/http.ts:30,64-65`、`stores/auth.ts`
- 認証済みで `/login` に来たら editor へリダイレクト。`http.ts` の 401 検知でグローバルに auth リセット + 現在ルートを redirect クエリに載せて login へ（多重発火は 1 回に抑制）。`redirect` クエリは `firstString` 正規化。
- 受け入れ: routerGuard.test に「認証済み → /login → リダイレクト」「redirect 配列で例外なし」追加、PASS。401 経路はモック単体。

### C10: 小物まとめ（low）
**Files:** `api/local/reviewRepo.ts:104-120`（confirmSaveLocal の reviews 書込を tx 内へ）、`features/preview/PreviewView.vue:125`（loadFailed 時 PDF ボタン disabled）、`lib/useIframeAutoFit.ts:88-98`（detach 済み iframe の除去）
- 受け入れ: 既存テスト全 PASS + 各修正の単体は可能な範囲で。

**Wave C 完了時:** `pnpm run typecheck:editor` + `pnpm run test:editor` 全通過 + biome 先行実行済みを確認して報告。

---

## Wave D: editor server（7 Task）

### D1: DATA_ROOT を *_DIR の基準へ（high）
**Files:** `server/src/config.ts:271-330`、`server/test/`（config の dataRoot 連動テスト新設）
- `templatesDir` / `cssDir` / `assetsDir` / `draftsDir` / `pendingDir` / `reviewsDir` / `syncDir` / `gitRepoDir` の既定を「解決済み dataRoot 起点の派生」に変更。個別 env / appconfig 指定は従来どおり最優先。`gitRepoDir` の env は `GIT_REPO_DIR` のまま、既定のみ dataRoot。
- 受け入れ: 新テスト「`DATA_ROOT=X` のみ設定 → 全 *_DIR が X 配下」「個別 env 指定は dataRoot より勝つ」PASS。既存 server/test 全 PASS（各テストは個別 *_DIR 指定なので影響なしのはず — 崩れたら報告）。

### D2: 新規ファイル書込失敗時の残留（medium）
**Files:** `server/src/repositories/confirmedWrite.ts:93-100, 211-220`、`server/test/confirmedWrite.*.test.ts`
- `snapshotCurrent` は「存在しなかった」を区別して保持し、restore は不存在だったファイルを**削除**する。
- 受け入れ: 新テスト「新規 HTML 書込成功 → CSS 書込失敗 → templatesDir に HTML が残らない」PASS。

### D3: 履歴 snapshot の first-match 誤帰属（medium）
**Files:** `server/src/repositories/historyRepo.ts:54-96`
- `getSnapshot` / `getEditHistory` の対象ファイル決定に templateId を使う（コミット内ファイル一覧から該当 `templates/<id>.html` を選ぶ。無ければ従来 first-match でなく明示エラー）。
- 受け入れ: 新テスト「2 テンプレを 1 コミットに含め、それぞれの listVersions から snapshot を開くと各自の内容」PASS。

### D4: partSync 同一 partId 複数出現の二重転写（medium）
**Files:** `server/src/sync/partSync.ts`、`server/test/partSync.test.ts`
- 方針: **source または target 内で同一 partId が複数出現するパーツは同期対象外**（`skipped` に「重複 id」理由で報告）。#n 付番による位置対応は削除・挿入で崩れることが実測済みのため、安全側へ倒す。
- 受け入れ: 新テスト「target=A,A / source=A（先頭削除）→ 転写なし・skipped 報告」PASS。既存テスト全 PASS。

### D5: pairSync 先行変更スキップの永久固定（medium）
**Files:** `server/src/sync/pairSyncService.ts:87 付近`、`server/test/`
- 方針: 「ペア側が先行変更」でスキップした場合、**state の lastSynced を進めない**（現状進めているなら止める）+ 競合として `conflicts` に記録して人手へ返す。既に記録していれば、target 側承認時に競合が解消される経路（target の承認 → 逆方向同期の評価）が働くことをテストで固定。
- 実装者は現実装の state 更新タイミングを precisely 読み、設計正典「両側変更（競合）はスキップして人間に返す」に整合する最小修正を提案してから書くこと（指揮者レビューを挟む）。
- 受け入れ: 新テスト「source 承認（target に未承認変更あり）→ スキップ + 競合記録 + lastSynced 不変」PASS。

### D6: 申請入口の fundCode 帰属検査（low）
**Files:** `server/src/repositories/reviewRepo.ts:80-118`
- `submitReview` で templateId の示すファンドと fundCode の一致を検査し、不一致は validation エラー（承認時検査と同条件）。
- 受け入れ: 新テスト「不一致申請が submit で 400 相当」PASS。

### D7: I/O 例外方針の統一 小物（low）
**Files:** `server/src/git/gitRepo.ts:422-429`（showFile: 「該当パス無し」だけ '' とし他は throw）、`server/src/files/templateFiles.ts:78-82`（readTemplateHtml を readFundCss と同方針へ）、`server/src/files/historyFiles.ts:258-277`（readTail の bytesRead 反映）、`reviewRepo.ts:206-226`（finalizeApprovedMeta 失敗時のエラーメッセージへ pairSync/noteMaster 未実行の旨を追記）
- 受け入れ: 既存テスト全 PASS + throw 化で挙動が変わる呼び出し元の影響を実装者が列挙して報告。

**Wave D 完了時:** `tsc -b editor/server` → `pnpm run typecheck:editor` → `pnpm run test:editor` 全通過を確認して報告。

---

## Wave E: pie-chart（5 Task）

### E1: topBand 積み上げの baseline 規約整合（high）
v1 プラン Task 7 の全文どおり（byte 差分の (a)/(b)/(c) 分岐込み）。

### E2: test_batch / batch_diff の検証装置強化（high）
**Files:** `src/test_batch.ts`、`scripts/batch_diff.mjs`、`pie-chart/README.md`（検証節）
- test_batch: 実行冒頭で `out/svg_js` を空にし、エラー件数 > 0 なら exit 1。
- batch_diff: baseline に無い svg_js（新規）と svg_js に無い baseline（消失）を両方向でエラー報告。
- 受け入れ: 意図的に 1 サンプルを失敗させた手元確認の報告（コミットには含めない）+ README 記述更新。

### E3: JSON 経路の NaN 明示エラー（medium）
**Files:** `src/input/load.ts:228-237`（normalizeInputItems）、`test/`
- `Number(value)` が NaN / 非有限になる item は xlsx と同様に明示エラー（項目名を含む）。
- 受け入れ: 新テスト「value:"abc" でエラー、メッセージに項目名」PASS。既存サンプル 83 件の batch が全 OK（数値化仕様が変わらないこと）。

### E4: DB 行数の事前上限（medium）
**Files:** `src/input/db.ts:214-309`、`test/input_db.test.ts`
- フェッチ行数に上限（`MAX_DB_ROWS`、xlsx の `MAX_RANGE_ROWS` と同水準）を設け、超過で明示エラー。
- 受け入れ: 新テスト（モック行で超過エラー）PASS。

### E5: 小物まとめ（low）
**Files:** `src/layout/geometry.ts:87`（LINE_EM_CACHE に上限 or LRU）、`src/input/load.ts:104-110`（cellAsNumber のカンマは桁区切り位置のみ許容）、`load.ts:254-259`（dataJson 上限を Buffer.byteLength で）、`src/cli.ts:33-48`（未知フラグ警告）、`src/svg_export/pipeline.ts` の data-percent コメントへ「表示文字列とは意味が異なる（総和比・絶対値）」を明文化
- 受け入れ: 既存テスト + batch byte 不変（コメント・検証系のみ。cellAsNumber は仕様変更なので新テスト + batch 全 OK 確認）。

**Wave E 完了時:** `pnpm run test:pie-chart` + `npm run batch && npm run batch:diff`（意図的差分は E1 のみ、他 Task では byte 不変）を確認して報告。

---

## Wave F: 基盤（4 Task）

### F1: md2html front-matter（high）— v1 Task 8 全文どおり
### F2: content-key.ps1 fallback（medium）— v1 Task 5 全文どおり
### F3: auto-push.cjs（medium）— v1 Task 6 全文どおり（コミット対象外・ローカルのみ）
### F4: comment-convention-reminder の対象拡張（medium）
**Files:** `.claude/hooks/comment-convention-reminder.cjs:20-26`（ローカルのみ）
- 判定対象へ `.bat` / `.md` を追加（check:comments の検査対象と揃える）。
- 受け入れ: `pnpm run check:claude-hooks` OK + 手元で該当拡張子の Edit イベント JSON を流しリマインド出力を確認。

**Wave F 完了時:** `python -m pytest docs/_build` + `pnpm run ci:offline` + `pnpm run check:claude-hooks` を確認して報告。

---

## Wave G: テスト・CI 網（5 Task）

### G1: CI 配線（high）
**Files:** `scripts/ci-affected.mjs`、`package.json`、`scripts/ci-affected.test.mjs`（v1 Task 4 を包含）
- runFullCi へ `ci:offline` 追加（v1 Task 4 どおり、check:claude-hooks 重複削除も）。
- `pdf-to-svg` 領域 stages へ vitest（`pnpm --filter pdf-to-svg run test` 相当のスクリプトを package.json へ新設）と e2e を追加。`graph-editor` 領域はすでに vitest/pytest あり、e2e を追加。
- `BENIGN_PREFIXES` から `docs/` を外し、`docs/_build/` を「docs 領域」（stages: docs pytest）として新設。`docs/<proj>/` 原稿のみの変更は従来どおり無害扱い（match を `docs/_build/` に限定し、他の docs/ は BENIGN のまま、という分割でよい）。
- `pie-chart` 領域 stages へ `batch` + `batch:diff` を追加（E2 完了が前提）。
- 受け入れ: `--all --dry-run` / 各領域単独変更の `--dry-run` 出力に期待の段が並ぶことを ci-affected.test.mjs で固定。
- **順序制約: Wave A〜E 完了後に実施**（既知バグで e2e が赤いまま配線しない）。

### G2: カバレッジ include の整備（high）
**Files:** `vitest.config.ts:144-170`
- 亡霊パス（svg_geom / glyph_advance.ts / data.ts）除去。後継 `pie-chart/src/layout/geometry.ts`・`input/load.ts` と、テスト済みの `editor/server/src/files/draftFiles.ts`・`templateFiles.ts`・`server/src/config.ts` を include へ追加。
- 受け入れ: `pnpm run test:coverage` が 85% 閾値で green（届かないファイルがあれば報告し、テスト追加 or 段階投入を指揮者判断）。

### G3: offline 署名検証チェーンの Pester（high）
**Files:** `offline/lib/verify.Tests.ps1`
- `Assert-FileSha256`（一致 / 不一致）、`Test-PinnedCommitId` / `Get-OfflinePin`（正常 / 改ざん pin）、`Test-DetachedSignature` / `Assert-BundleSignature`（テスト用自己署名証明書での正 / 否。証明書生成が環境依存で重ければ、検証ロジックの引数境界と fail-closed 分岐に絞る — 判断は実装して報告）。
- 受け入れ: `pnpm run ci:offline` green + 新 Describe 3 本以上。

### G4: ガードテストの射程修正（high）
**Files:** `editor/web/test/iframeSandbox.guard.test.ts`（`.ts` も走査対象へ、既存 `.ts` の iframe 生成箇所を許可リスト管理）、`graph-editor/test/test_parallel_impl_drift.py`（end_headers 付与方式検査の複製 + トークン生成 `token_urlsafe(32)`・`compare_digest` の字面 assert + ImportError skip を明示 fail or 理由付き skip 表示へ）、`pdf-to-svg/test/test_parallel_impl_drift.py`（同 assert 追加）、`pdf-to-svg/test/test_export_escaping.py:124`（`glob("**/*.py")`）、`editor/web/test/noPostSanitizeSurgery.guard.test.ts` / `fillJinja.test.ts`（固定列挙 → ディレクトリ走査 + 除外リスト方式へ）
- 受け入れ: 各テスト green + 「新規ファイルを足すと自動で網に入る」ことを一時ファイルで確認して報告（コミットには含めない）。

### G5: editor 検証残（medium）
**Files:** `editor/server/test/hostGuard.test.ts`（実 app.ts の onRequest 配線を検証する統合形へ寄せられるか実装者が評価 → 可能なら追加、不可なら「再構築形の限界」をテストコメントへ明記）、`package.json:39`（test:scripts へ ci-affected.test.mjs — G1 で追加済みなら確認のみ）
- 受け入れ: 実装者の評価報告 + 追加分 green。

**Wave G 完了時:** `--all --dry-run` の全景と `pnpm run test:coverage` 結果を添えて報告。最後にユーザーへフル CI（`!pnpm run ci`）を依頼。

---

## Wave H: Phase 3 残件（5 Task。2026-08-20 追記）

### H1: pie-chart `input/load.ts` のテスト追加（被覆 58% → 85%）
**Files:** `pie-chart/test/`（load.ts 対象の新テスト）
- 未被覆の分岐（xlsx のヘッダ探索・範囲解決・セル型分岐・エラー経路）を `pnpm run test:coverage` のレポートで特定してテストを足す。実装は変えない（挙動固定が目的）。xlsx fixture が要る分岐は exceljs でメモリ上に組み立てる（リポジトリへ .xlsx バイナリを増やさない）。
- 受け入れ: load.ts の全指標 85% 以上・全体 coverage green・batch byte 不変。

### H2: pie-chart JSON 経路の `null` / `''` を明示エラーへ
**Files:** `pie-chart/src/input/load.ts`（`checkValue` 周辺）、`test/`
- E3 の NaN エラー化と一貫させ、`value` が `null` / `''` / 空白のみの item も項目名付き明示エラーにする（`0` の明示値は従来どおり受理）。db.ts 側の `toNumber` も同じ扱いか確認し、並行実装の doc 記述と食い違うなら揃える。
- 受け入れ: 新テスト（null / '' / 空白 / 明示 0 の 4 ケース）PASS・batch byte 不変（83 サンプルに null 値は無い）。

### H3: offline `Test-PinnedCommitId` を大文字 16 進拒否へ
**Files:** `offline/lib/verify.ps1`、`offline/lib/verify.Tests.ps1`
- `-match` → `-cmatch`（pin の正典は `Get-OfflinePin` が書く小文字。大文字を受理する入口を閉じ、G3 で「受理する」と明示したテストを「拒否する」へ反転）。
- 受け入れ: `pnpm run ci:offline` green。

### H4: editor `app.ts` の `buildApp()` 工場化 + hostGuard 統合テスト
**Files:** `editor/server/src/app.ts`、`editor/server/src/index.ts`（新設 or 相当）、`server/test/hostGuard.test.ts`
- `app.ts` から「Fastify インスタンスを組み立てて返す `buildApp()`」を分離し、`listen()`・シグナルハンドラ・worker pool 起動・`process.exit` はエントリポイント側に残す。既存の起動経路（start.bat / 各テスト）の挙動は不変。
- hostGuard の「実配線」describe を `buildApp()` + `app.inject()` の真の統合テストへ置き換え（G5 で追加したソース走査形は「工場化までの代替」だったので撤去してよい。ソース走査の 2 点固定は統合テストで代替されることを確認して判断）。
- 受け入れ: `pnpm run test:editor` 全 green・`pnpm run typecheck:editor` OK。**変更が広いので実装前に分離方針を 3-4 行で報告**。

### H5: editor `getEditHistory` の行 id 一意化
**Files:** `editor/shared/src/schemas.ts`、`server/src/repositories/historyRepo.ts`、`web/src/features/`（HistoryTable の :key 周辺）、`server/openapi/openapi.json`（再生成）
- `EditHistoryEntry` に `historyId`（コミット hash）を明示フィールドとして持たせ、`id` は `${hash}:${templateId}` の一意値へ（D3 の確認事項 2 の解消）。web 側で `id` をコミット参照に使っている箇所は `historyId` へ置換。
- 受け入れ: 新テスト「複数テンプレ 1 コミットで行 id が一意・historyId は共通」PASS・既存テスト green・rest/local 両実装が同じ形を返すことをテストで固定。

## 実行プロトコル（指揮者 = 本セッション Fable 5）

1. Wave 順は A → B → C → D → E → F → G。**Wave 内は 1 実装者エージェント（model: opus）に Task 列を渡し逐次実行**（同一ファイル群のため並列不可）。Wave A と B は別プロジェクトなので並列可（セッション上限の残量を見て判断）。
2. 実装者への指示に必ず含める: 対象 Task の本文全文 + Global Constraints + 「コミット直後に git log -1 / status を報告」。
3. Task ごとに指揮者が確認: ①reflog でコミット実在 ②diff 精読（設計正典・コメント規約・退行禁止事項への抵触）③テストコマンド再実行。NG は同一エージェントへ SendMessage で差し戻し。
4. Wave 完了ごとにユーザーへ報告（変更点・テスト結果・byte 差分の有無・push 状況）。
5. セッション上限に近づいたら Wave 境界で停止し、再開手順（本プランのチェックボックス）を報告。
