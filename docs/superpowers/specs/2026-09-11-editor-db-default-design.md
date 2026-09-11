# editor: DB モードを既定にし、編集タブを値入り HTML（`filled/`）へ向ける — 設計

日付: 2026-09-11
対象: `editor/`（web / server / shared / e2e / start.bat）、`offline/setup-offline.ps1`、`docs/editor`

## 1. 背景と目的

editor は起動時のデータモードを `VITE_API_MODE` で切り替える。`local`（fixtures + localStorage、
認証なし・DB なし）が既定で、`rest`（SQL Server + 認証）は明示指定が要る。本番は `rest` だけを
使うため、既定を `rest` に倒す。

あわせて、2 系統原則の「編集タブ = per-fund 実値の値入り HTML」が現状 `local` でしか成立して
いない問題を解く。`rest` のサーバはテンプレ取得で `filled: ''` を固定で返し、編集タブは共通
サンプルにファンド名を被せた値で開いている。DB モードでも編集タブが値入り HTML を読み書き
できるよう、dataRoot に値入り HTML の置き場を新設する。

`local` モードの資源（`web/src/api/local/`・fixtures・`genFilled.ts`・local 系テスト）は削除
しない。開発用の opt-in として残し、既定だけを変える。

## 2. dig で確定した決定

| 論点 | 決定 |
|---|---|
| local 資源 | 削除しない。既定を `rest` に倒すのみ |
| 編集タブの値の出どころ | アプリは値を持たない。編集タブは既に存在する値入り HTML を読むだけ |
| 値入り HTML を作る者 | editor 外の別ツールが作り、dataRoot へ直接置く。承認時にサーバが上書きする |
| 置き場 | 作成タブのテンプレ（Jinja）と値入り HTML は別フォルダ。未配置のテンプレは一覧に出ない |
| 承認で書くもの | HTML と CSS。編集タブは値入り HTML をそのまま上書きする |
| プレビュー・比較・結合 PDF | 値入り HTML の完成描画を使う。値入り HTML に Jinja は残らないので nunjucks を通さない |
| ファンド名 | ブラウザ側で sessionStorage にセッション中だけキャッシュ |
| DB 無し環境 | SQL Server 必須。`AUTH_REQUIRED` 既定 true・`start.bat` 既定 rest・setup の msnodesqlv8 失敗は setup 失敗 |
| e2e | chromium project を rest フェイク方式へ全面移植 |

## 3. 用語

- **filled（値入り HTML）**: Jinja の変数を実値に置き換えた HTML。編集タブがキャンバスに載せる本文。
  DB モードでは別ツールの出力（純 HTML、Jinja なし）。local モードでは `fixtures/filled/*.html`。
- **dataRoot**: テンプレ本体を置くリポジトリ外のフォルダ（既定 `../../editor-data`）。
- **作成タブ / 編集タブ**: 2 系統原則の 2 経路。判定は `route.query.created === '1'`、申請では
  `ReviewRequest.source`（`'create' | 'edit'`）。

## 4. dataRoot の構成

```
editor-data/
  templates/   作成タブ経由で承認された Jinja スケルトン（現行どおり）
  filled/      値入り HTML。別ツールが <テンプレID>.html を置く。git 管理内（新設）
  css/         per-fund CSS（現行どおり。両経路で共有）
  drafts/ pending/ reviews/ notes/ sync/   現行どおり
```

- `config.ts` に `filledDir` を追加する（env `FILLED_DIR` < `appconfig.json` の `paths.filledDir`
  < 既定 `filled`）。
- `scripts/init-data-repo.ps1` は `filled/` も作成する。
- `filled/` は承認コミットの追跡対象に含める（`.gitignore` に入れない）。巻き戻しでテンプレと
  値入り HTML が食い違う事故を避けるため。
- ファイル名規則は `templates/` と同じ（`会社_ファンド_基準日_版種.html`。`assertTemplateFileName`
  を共用）。別フォルダにするので一覧走査への混入は起きない。

## 5. server

### 5.1 ファイル層（`files/templateFiles.ts`）

`templatePath` / `readTemplateHtml` / `listTemplateFiles` / `templateExists` / `templateMtime` の
`filled/` 版を追加する（`filledPath` / `readFilledHtml` / `listFilledFiles` / `filledExists` /
`filledMtime`）。既存関数の挙動は変えない。パス検証（`assertTemplateFileName`）は同じ関数を通す。

### 5.2 テンプレ取得と一覧（`repositories/templateRepo.ts`）

- `listTemplates` / `getDropdownOptions` / `listSeriesFunds`: `filled/` だけを走査する。
  `templates/` にしか無い id は一覧に出ない。
- `getTemplate(id)`: `filled/` → `templates/` → `pending/` の順に探し、最初に見つかったものを返す。
  `filled/` で見つかった場合は `html` と `filled` の両方にファイル内容を入れる。`templates/` と
  `pending/` で見つかった場合は現行どおり `filled: ''`。
  - `templates/` へのフォールバックは、作成タブ経由の承認直後に精査画面が確定版を読む経路を
    残すため。一覧には出ないので編集タブからは開けない。
- `getSampleData`: 変更なし（作成タブの `toFilled` とプレビューだけが使う）。

### 5.3 申請と承認（`repositories/reviewRepo.ts`・`repositories/confirmedWrite.ts`）

- `submitReview`: JS 不変検査の基準（`baselineTemplateHtml`）は `source` で分ける。
  `'edit'` → `filled/` → `templates/` → `pending/` の順、`'create'` → `templates/` → `pending/`
  の順（現行）。確定を先に見る順序は変えない。
- `applyConfirmedWrite` の `review-approve` に `target: 'filled' | 'template'` を足す。
  `approveReview` が申請の `source` から決める（`'edit'` → `'filled'`、`'create'` → `'template'`）。
  書込先は `target` に従い `filledPath` / `templatePath`。CSS は両方とも `cssPath`。
  `atomicWrite` と両パス解決子を同時に import するファイルが `confirmedWrite.ts` 1 つである
  不変則は維持する。
- 監査ログの capability に `target` を載せる。

### 5.4 版履歴・ペア同期・注記マスタ

- `historyRepo`: 版履歴の pathspec を `filled/` にする。編集タブ・比較画面が見る履歴は値入り
  HTML の履歴になる。`templates/` の履歴は画面から参照しない。
- `pairSyncService` / `noteMasterService`: 承認の `target` を受け取り、同じフォルダを読み書きする
  （`'filled'` なら `filled/`、`'template'` なら `templates/`）。転写先も同じフォルダ。

### 5.5 プレビュー・PDF（`vivliostyle/`）

サーバ側の build / preview API は入力の HTML をそのまま組版する現行のまま。変更なし。

### 5.6 既定値（`config.ts`）

- `requireAuth` の既定を `true` にする。`start.bat local` は `AUTH_REQUIRED=false` を明示して
  起動する。
- Host ヘッダ検査の説明コメントの「既定の local モード」前提を「認証を課さない配備
  （`AUTH_REQUIRED=false` を明示した local モード）」へ書き換える。判定ロジックは変えない。
- server のテストで `requireAuth` の既定 false に依存しているものは、`AUTH_REQUIRED=false` を
  明示する。

### 5.7 e2e 用サーバ（`scripts/e2e-rest-server.ts`）

- seed に `fixtures/filled/*.html` → `dataRoot/filled/` のコピーを足す。
- ポートを引数または env で受け取れるようにし、既定を 24680 / 24681（rest project 用の
  24690 / 24691 は廃止）にする。

## 6. web

### 6.1 既定モード

- `main.ts`: `const useLocal = import.meta.env.VITE_API_MODE === 'local'`。未設定は rest。
  `migrateStore` / `seedCompareFixtures` は local のときだけ、401 ハンドラは rest のときだけ
  （現行の条件を反転）。
- `lib/storageKeys.ts` の Undo スコープ判定も同じ条件に揃える。
- `vite-env.d.ts` のコメントを「未設定は rest」に直す。

### 6.2 編集タブの申請本文（`features/preview/services/templatePreviewService.ts`）

- `source === 'edit'` のとき `toTemplate` を通さない。下書きの本文をそのまま `tpl.html` の
  body に差し替えて `html` にする。CSS は現行どおり整形する。
- 描画は `renderJinjaIsolated` を通さず `assemblePreviewDocument(html, css)` だけで組む。
  `getSampleData` も呼ばない。
- `source === 'create'` は現行どおり（`toTemplate` → `renderJinjaIsolated(共通sample)`）。
- 申請の `filledHtml` は編集経路では `html` と同じ完成描画になる。

### 6.3 比較・結合 PDF（`features/compare` / `features/merge`）

- 対象一覧は `listTemplates`（`filled/` 走査）のまま。
- 描画は `getTemplate` の `filled` を本文として、nunjucks を通さず組版する。
  `getSampleData` の呼び出しを外す。

### 6.4 ファンド名のキャッシュ（`api/rest/templateRepo.ts`）

- `getSampleData(fundCode)` の結果を `sessionStorage` に `editor:sample:<fundCode>` で保持し、
  同じタブの間は再利用する。失敗時は保存しない。
- `stores/auth.ts` の logout で `editor:sample:` 接頭辞のキーを消す。

### 6.5 local 実装の追随（`api/local/templateRepo.ts`）

- `source === 'edit'` の承認は `filledOverride[id]` を更新し、`html` は据え置く。
  `getTemplate` は `filledOverride[id] ?? fixtureFilled[fileName]` を `filled` に返す。
- `source === 'create'` の承認は現行どおり `htmlOverride` を更新する。

### 6.6 起動と設定

- `start.bat`: 既定 `APIMODE=rest`。`local` は明示 opt-in として残す。`local` 指定時は
  `AUTH_REQUIRED=false` を設定する。`local lan` の拒否は現行どおり。ヘッダのコメントと
  用例を「既定 = rest」に直す。
- `offline/setup-offline.ps1`: msnodesqlv8 配置の 3 段判定（prebuild と install 先の有無 /
  版一致 / 展開 + `require` 疎通）のいずれかで `Write-Error` + `exit 1`。

## 7. e2e

- `playwright.config.ts`: `chromium` / `docs` project の webServer を `e2e-rest-server.ts`
  （sproc フェイク + 一時 dataRoot、24680 / 24681）に替える。Vite は `VITE_API_MODE=rest` で
  起動する。`rest` project と `E2E_REST` は廃止し、`*.rest.spec.ts` は `*.spec.ts` へ改名して
  chromium に統合する。
- `workers: 1` を維持する（ログイン試行のレート制限を踏まないため）。
- 各 spec のログインは現行の `login()` ヘルパ（フォームから実 `/api/auth/login`）で通る。
  localStorage を直接触ってユーザーを切り替えている箇所（`capture_docs.spec.ts` の
  admin → approver、`review_tab.spec.ts` の 1 テスト内切替）は `test()` を分けて `login()` で
  切り替える。
- ログイン ID は sproc フェイクの利用者（`admin` / `approver` / `editor`）に揃える。表示名が
  local と違う（`精査花子` → `承認 花子` など）ので、`capture_docs` の再撮影で
  `docs/editor/images/*.png` が変わる。再撮影としてコミットし、`build_all.py --project editor`
  で HTML を作り直す。
- root `package.json`: `test:e2e` / `e2e:editor` は現行の project 名のまま。`e2e:rest` と
  `check-ports 24690 24691` は削除する。
- GH Actions（`ubuntu-latest`）は sproc フェイクで動くので SQL Server は不要。

## 8. ガード（機械検証）

- `web/test/twoSystems.guard.test.ts`: 現行の検査を残し、rest 経路の検査を足す。
  「`api/rest/templateRepo.ts` の `getTemplate` はサーバ応答の `filled` をそのまま `tpl.filled`
  に写す」「編集経路の申請は `toTemplate` を通らない」をソース走査で固定する。
- `server/test`: `getTemplate` が `filled/` の実体を `html` と `filled` の両方に返すこと、
  `filled/` に無い id は一覧に出ないこと、`source='edit'` の承認が `filled/` に書き `templates/`
  を触らないこと、`source='create'` の承認が `templates/` に書き `filled/` を触らないこと。
- `server/test/config.security.test.ts`: `AUTH_REQUIRED` 未設定で `requireAuth === true`。
- `web/test/restBundle.guard.test.ts`: 変更なし（local 資源を残すため）。

## 9. ドキュメント

- `editor/README.md` / `CONTRIBUTING.md`: 「既定 = rest、`local` は開発用 opt-in」に書き換え。
  `start.bat` の用例と env 表を更新する。
- `docs/editor/src/設計書.md` 4.2 / 4.3 節: local/rest 対比を「既定 rest」に直し、4.3 の
  「REST は per-fund 実サンプルで filled を生成する」（実装と不一致）を「REST は `filled/` の
  値入り HTML を返す」に正す。
- `docs/editor/src/設計正典.md`: 中核原則の 2 系統に「rest の `tpl.filled` は dataRoot `filled/`
  の実体。承認は `source` で `filled/` と `templates/` を書き分ける」を追記する。
- `docs/editor/src/操作手順書.md`: ログイン ID の記述とスクショを更新する。
- ルート `README.md` の「フル `ci` の前提」: SQL Server 不要（sproc フェイク）である旨を明記する。

## 10. 変更しないもの

- `web/src/api/local/**`・`web/src/api/fixtures/**`・`web/scripts/genFilled.ts`・local 系の
  単体テスト・`appEpoch` 一式。
- 作成タブの経路（`toFilled(tpl.html, 共通sample)` + ハイライト + `toTemplate` での復元 + 承認で
  `templates/` へ書く）。
- 2 系統原則そのもの（編集タブ = `tpl.filled` + ハイライト無し / 作成タブ = `toFilled(共通sample)`
  + ハイライト有り）。変わるのは rest における `tpl.filled` の出どころだけ。
- sproc フェイク（`server/test/fakes/sprocFake.ts`）の契約。
- サーバの vivliostyle build / preview API。

## 11. 却下した案

- **local 資源の削除**: 開発用に残す（ユーザー決定）。
- **`templates/<id>.filled.html` の隣置き**: 一覧走査と名前規則の検査に除外分岐が要り、除外漏れが
  偽テンプレとして一覧に出る。
- **rest でファンドごとの値を DB や生成器から取る**: アプリが値の出どころを持たない方針
  （別ツールが値入り HTML を作る）と矛盾する。
- **編集タブ文書を nunjucks で再描画する**: 値入り HTML に Jinja は残らないので不要。
- **ファンド名 JSON をサーバ起動時に生成**: 更新に再起動が要る。sessionStorage でよい。

## 12. 実装計画での補正

計画（`docs/superpowers/plans/2026-09-11-editor-db-default.md`）を書く際に実装を読んで次を補正した。

- `listTemplates` は `filled/` に加えて `pending/`（生成直後の未確定実体、`status:'draft'`）も
  返す。作成タブは生成後に `/edit/:id` へ 1 回遷移するだけで、一覧から外すと生成直後に
  ブラウザを閉じた時点でその id へ到達する手段が消える（現行の設計判断を維持）。
  `templates/` にしか無い id は一覧に出さない。
- `getDropdownOptions` / `listSeriesFunds` は台帳（sproc）由来のままにする。5.2 節の
  「`filled/` だけを走査」はファイル一覧 `listTemplates` にだけ当たる。
- `Template.filled` の判定は `Boolean(tpl.filled)`（空文字と未定義をまとめて「無し」）。
- e2e のユーザー切替は `test()` の分割でなく、`login()` ヘルパが cookie を捨ててから
  ログイン画面へ行く形にする。既存 spec の 1 テスト内切替がそのまま動き、書き換え量が減る。
- `ConfirmSaveRequest`（local 実装の確定保存の入力）に `origin` を足し、local も承認の
  `origin` で `filled` / `html` を書き分ける。

## 13. 実装順（計画で分割する単位）

1. server: `filledDir` とファイル層 → `templateRepo` の一覧・取得 → 申請・承認の `target` →
   履歴・ペア同期・注記マスタ → `requireAuth` 既定 → e2e サーバの seed とポート。
2. web: 既定モード反転 → 編集経路の申請本文と描画 → 比較・結合 PDF → sessionStorage キャッシュ
   → local 実装の追随 → ガード追加。
3. 起動・配布: `start.bat` → `setup-offline.ps1`。
4. e2e: playwright.config → spec の統合と分割 → docs 再撮影 → HTML 再生成。
5. ドキュメント。

各段で `pnpm typecheck` と該当 project の `vitest` を通し、最後に `pnpm ci` を通す。
