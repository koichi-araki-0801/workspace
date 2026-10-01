# editor: フォント置き場の css/fonts への移設と js の外出し — 設計

- 日付: 2026-10-01
- 対象: `editor/`（server / web / shared）、`editor/scripts/init-data-repo.ps1`、新設 `editor/patches/2026-10-fonts-to-css/`
- 位置付け: 「ファンド別画像」と合わせて検討した 2 サブプロジェクトのうち①。画像（②）は別 spec とし、本 spec で作る「CSS の URL 付け替え」と「配信グループの最長一致」を前提に使う。

## 1. 目的と成功条件

### 目的

- フォントの置き場を `dataRoot/assets/fonts` から `cssDir/fonts`（= 既定 `dataRoot/css/fonts`）へ移し、一本化する。全ファンド共通の 1 組とする。
- ファンド CSS から、CSS 自身から見た相対パス `url(fonts/x.woff2)` で `@font-face` を書けるようにする。
- `assets` が js 専用になるので、js を `dataRoot/js` へ外出しし、`assets` という階層を廃止する。
- 既存環境を新しい構成へ移す移行パッチ（ps1 + bat）を `editor/patches/` に置く。

### 成功条件

1. PDF（`/api/build`・`/build/merge`）、外部向けプレビュー（`/api/preview` inline）、画面内プレビュー、精査画面の左右比較のどれでも、`css/fonts` のフォントが効く。
2. どの経路でも URL の付け替えはちょうど 1 回だけ掛かる（`css/css/` が生じない）。
3. 移行パッチを 1 回実行すれば既存環境が新構成になり、再実行しても結果が変わらない。
4. 旧設定（`paths.assetsDir` / `ASSETS_DIR`）が残った環境は、黙って js を失うのではなく、起動エラーで移行を案内する。

### 前提（ユーザー確定）

- build API の外部呼び出し元も editor-data と同じ階層構造を持つ。外部向けの互換配信（旧 `fonts/` パス）は作らず、移行パッチで揃える。
- `css/fonts` は git 管理外で、手で置く。
- パッチの言語は ps1 + bat（このリポジトリの `.claude/rules/powershell.md` の規約に従う）。

## 2. 現状（調査で確認した事実）

- リクエストの `css`（ファンド CSS）は、サーバでも web でも文書の `<style>` として埋め込まれる。`<link href="css/…">` は外される（`server/src/vivliostyle/inlineCss.ts` の `stripUnresolvableRefTags`）。したがって CSS 内の相対 URL は、`css/` ではなく配信ルート直下を基準に解決される（`server/src/vivliostyle/docRefs.ts` の `addCssRefs(css, '')`）。
- 配信の許可リストは `server/src/vivliostyle/docAssets.ts` の `ASSET_GROUPS`（css=`cssDir`、fonts=`assetsDir/fonts`、js=`assetsDir/js`）。グループは配信パスの先頭 1 セグメントで引いている。
- 画面内プレビューは opaque オリジンで資産を取りに行けないため、親が `web/src/lib/previewSelfContain.ts` でフォントを data URI として埋め込む。判定は `fonts/` 始まり。
- 手元の editor-data・fixtures のファンド CSS には `@font-face` も `url()` も無い。本番は未確認。
- 旧構成で実際に動いていた CSS は `url(fonts/x.woff2)`（直下基準）と書かれていたはずで、新契約（`css/` 基準）でもこの字面がそのまま `css/fonts/x.woff2` に解決される。壊れるのは `url(../fonts/…)` と `url(css/…)` の形だけである。

## 3. 設計

### 3.1 置き場と配信

- フォントの物理的な置き場は `cssDir/fonts`、配信パスは `css/fonts/…` の 1 つだけとする。配信パス `fonts/` は廃止する。
- `ASSET_GROUPS` から `fonts` グループを外し、配信パス `css/fonts`・元フォルダ `cssDir/fonts`・拡張子 `.ttf .otf .woff .woff2` のグループを新設する。既存の css グループ（拡張子 `.css`）の拡張子にフォントを足す形は採らない（`cssDir` 直下にもフォントを置けてしまうため）。
- `resolveServedAssetSource` と `collectGroup` のグループの引き方を、配信パスの**最長一致の前方一致**に変える（`css/fonts/x` は css/fonts グループ、`css/x.css` は css グループ）。PDF の配置（`stageDocAssets`）とプレビューホスト（`previewHost.ts`）は、引き続きこの 1 つの判定を共有する。
- フォルダ名 `fonts` の照合は大文字・小文字を区別しない（Windows の FS で `css/Fonts/` に置かれても配信できるようにする）。
- 深さの上限（`MAX_ASSET_DEPTH` = 4）は `css/fonts/noto/JP/x.woff2` でも収まるので変えない。

### 3.2 js の外出しと旧設定

- js の置き場を `dataRoot/js` とする。設定は `config.jsDir`、環境変数 `JS_DIR`、appconfig `paths.jsDir`。配信パスは従来どおり `js/`。git には記録しない（`COMMITTED_PATHSPECS` に入れない。従来の assets と同じ扱い）。
- `config.assetsDir` / 環境変数 `ASSETS_DIR` / appconfig `paths.assetsDir` は廃止する。ただし appconfig のスキーマには `paths.assetsDir` を残し、`paths.assetsDir` か `ASSETS_DIR` のどちらかが指定されていたら、起動を中止して次の内容を案内する。
  - 「`assetsDir` は廃止しました。js は `jsDir`（環境変数 `JS_DIR`）へ、フォントは `<cssDir>/fonts` へ移してください。移行パッチ: `editor/patches/2026-10-fonts-to-css/`」
  - 理由: スキーマから単純に消すと、`.strict()` により appconfig 側は「内容が不正」という原因の分かりにくいエラーになり、環境変数側は黙って無視されて js の欠けた PDF が成功扱いで出る。`config.ts` の既存方針「誤記は起動中止で運用者に届ける」に揃える。

### 3.3 CSS の URL 付け替え

#### 関数

- `@editor/shared` に `rebaseCssUrls(css: string, baseDir: string): string` を 1 つ置く。HTML は受け取らない。
- `collectCssUrlSpans`（外部参照検査・配置と同じトークナイザ）で `url()` の範囲を拾い、各値を `resolveServedAssetPath(`${baseDir}/${value}`)`（`docRefs.resolveRefFrom` と同じ物差し）で配信ルート相対へ直す。
- 付け替えの対象は `isSelfContainedUrl(value)` が真で、`data:`・`#`・`/` 始まり・`local()` のいずれでもない値。解決結果が `undefined`（ルートの外へ出る `../../x` など）のときは原文のまま残す。従来どおり配置されず、参照は落ちる。
- 書き戻しは必ず `url("…")` の引用形とし、`"`・`\`・改行を CSS エスケープする（`collectCssUrlSpans` の値はエスケープ解決後なので、引用なしで書き戻すと空白や `)` を含む値で CSS が壊れる）。
- 引用符文字列（`image-set("fonts/x.png" 1x)` など）は付け替えない。`content:"fonts/…"` の本文を壊さないため。契約として「相対参照は `url()` で書く」と明記する。
- この関数は冪等ではない（`fonts/x` → `css/fonts/x` → `css/css/fonts/x`）。著者が `css/` と書いたのかを区別できないため、冪等化はしない。代わりに「1 経路で 1 回だけ」を構造と機械検査で保証する（3.3 の呼ぶ場所と 3.6 のテスト）。

#### 呼ぶ場所（ここ以外では呼ばない）

- サーバ: 「リクエストの css を受けたら最初に 1 回だけ付け替える」共通ヘルパを 1 つ作り、次の 3 入口から呼ぶ。付け替えは外部参照検査・`collectDocumentAssetRefs`・`inlineCss` より前に置き、検査は付け替え後の CSS に対して行う。
  1. `/api/build`（`build.ts` の `buildInlinePdf`）
  2. `/build/merge`（`mergeInput.ts`。文書ごとの css に対し、`stripPageCounterReset` と `MERGE_PAGE_COUNTER_CSS` の連結より前）
  3. `/api/preview` inline（`build.ts` の `prepareInlineDoc`）
- web: CSS 引数に対してだけ付け替える。
  1. `web/src/lib/nunjucksRender.ts` の `assemblePreviewDocument`
  2. `web/src/features/reviews/services/reviewCompareDocs.ts` の `wrapDoc`
- 付け替えないところ: 編集キャンバス（GrapesJS の `setStyle`。付け替えた CSS が `getCss()` 経由で下書き・申請・確定 CSS に保存され、サーバで二重に掛かるため）、`PreviewPanel` 以降の表示境界と `selfContainPreviewDoc`、`htmlBlockDiff.ts`・`partPreviewDoc.ts`（srcdoc/blob では相対 URL がもともと解決できず、現状もフォントは出ない）、zip 経路 `/build/project`（CSS はファイルとして本来の位置にあり、ブラウザ本来の相対解決に任せる）。
- 申請の `filled.html` は付け替え済みの `<style data-preview-css>` を含むが、サーバは HTML 側を付け替えないので二重にはならない。HTML 側を付け替える実装にしないこと（`nunjucksRender.dom.test.ts` の「filledHtml 経由の再入」がこの経路を持つ）。
- トンボの CSS は、PDF ではリクエストの css に連結されて付け替わり、プレビューでは別の `<style>` なので付け替わらない。現在は相対 url を持たないので結果は一致する。トンボの CSS に url を足すと PDF とプレビューで食い違う、とコメントで注記する。

#### プレビューへの埋め込み

- `previewSelfContain.ts` の判定を `fonts/` から `css/fonts/` へ変える。取得先は `/api/preview-host/css/fonts/…`。

#### 外部 API の契約

- OpenAPI（`server/src/openapi/document.ts` → `openapi.json` 再生成）と設計正典に、次を明記する。
  - リクエストの `css` は `css/<fund>.css` の位置に置かれた CSS として解釈する（相対 `url()` は `css/` 基準）。
  - 相対参照は `url()` で書く。引用符文字列の相対参照は解決されない。
- 利用者向け文言（`externalRefs.ts` の `EXTERNAL_REF_MESSAGE`、`pdfDocument.ts`、`templateEditorService.ts`）の `fonts/…` 表記を `css/fonts/…` に直す。

### 3.4 git と初期化

- `/css/fonts/` を `.gitignore` の必須行に加える。3 か所で揃える: `gitRepo.ts` の `ensureGitignore`、`init-data-repo.ps1`、移行パッチ。`.gitignore` に入る前にフォントを `css/fonts` へ置くと、次の承認コミット（`git add -A -- css`）が承認者の名前でフォントを巻き込むため。
- `init-data-repo.ps1` は `css\fonts` と `js` を作り、`assets\*` は作らない。

### 3.5 移行パッチ

置き場: `editor/patches/2026-10-fonts-to-css/`

- `migrate.ps1`（日本語を含むので UTF-8 BOM）と同名の `migrate.bat`（CRLF、`chcp 65001`）
- `rollback.bat`（元に戻す手順を案内・実行する）
- `README.md`（目的・前提・手順・元に戻し方）
- ルート `README.md` の入口スクリプト一覧に `editor/patches/` の節を足す（既存の「入口はプロジェクト直下、裏方は `<project>/scripts/`」に無い新しい置き場のため）。

#### 置き場の解決

- dataRoot: `-DataRoot` → このプロセスの `DATA_ROOT` → ユーザー環境変数 `DATA_ROOT` → 既定（`init-data-repo.ps1` と同じ規則。相対パスは `editor/` 基準）。
- css と旧 assets: `CSS_DIR` / `ASSETS_DIR` 環境変数と、appconfig（`APP_CONFIG` または `editor/appconfig.json`）の `paths.cssDir` / `paths.assetsDir` を読み、指定があればそれを使う。解決結果と、どこから読んだかを表示する。

#### 実行条件と既定動作

- 既定は確認モード（dry-run）。移動元・移動先、書き換え対象のファイルと件数、報告事項を表示するだけで、何も変えない。`-Apply` を付けたときだけ実行する。
- 次の場合は中止する。
  - editor サーバが動いている（設定ポートの待受を確認する）。旧版のサーバが動いたまま移すと、承認コミットにフォントが巻き込まれるため。
  - dataRoot の git に未コミットの変更がある（`git status --porcelain` が空でない）。

#### 処理（`-Apply` 時、この順）

1. `.gitignore` に `/css/fonts/` が無ければ追記する（BOM 無し、LF）。
2. `assets\fonts\*` → `cssDir\fonts\`、`assets\js\*` → `dataRoot\js\` をコピーし、サイズと SHA256 で照合する。全件一致したら旧 `assets\` を `assets.migrated-<yyyyMMdd>` に改名して残す。ネットワークドライブや別ボリュームでの途中失敗に備え、移動ではなくコピーと照合にする。
3. 次の CSS で、`url(` の内側にある `../fonts/` を `fonts/` に書き換える（`../../fonts/` を誤って書き換えないよう、`url(` 直後の値の先頭だけを見る）。
   - `cssDir\*.css`（確定領域）
   - `drafts\*.css`、`pending\*.css`、`reviews\<id>\body.css`（承認前の作業コピー。放置すると、移行前に出した申請を承認した瞬間に、移行済み CSS が旧参照で上書きされる）
4. appconfig に `paths.assetsDir` があれば、`paths.jsDir`（値は旧 `<assetsDir>\js`）に書き換え、`paths.assetsDir` を消す。`ASSETS_DIR` 環境変数が設定されていれば、`JS_DIR` へ移すよう案内を表示する（環境変数は書き換えない）。
5. 確定領域の変更（`css/*.css` と `.gitignore`）を、`init-data-repo` の初回コミットと同じ `system` 名義で 1 コミットする。メッセージは「移行: フォント置き場の移設（assets/fonts → css/fonts）」。

#### 報告のみ（書き換えない）

- templates / filled の HTML 内の `fonts/` 参照（`url()` と `<link href>` などの属性）。移行後は配信されなくなる。承認でしか書かない確定領域なので、パッチでは変えない。
- `url(css/…)` を持つ CSS（新契約では `css/css/` になる）。

#### 冪等性と競合

- 移動元が無く移動先がある項目は、移動済みとして飛ばす。
- 移動元と移動先の両方に中身があり、内容が一致しない項目は、競合として中止する（上書きしない）。
- CSS の書き換えは、2 回目には対象が残っていないので冪等になる。

#### 元に戻す（rollback.bat）

1. サーバを停止する。
2. dataRoot の git で移行コミットを `git revert` する。
3. `assets.migrated-<日付>` を `assets` に改名して戻し、パッチが作った `css\fonts` と `js` を削除する。
4. appconfig を戻す（パッチは書き換え前の appconfig を `appconfig.json.bak-<日付>` に保存しておく）。
5. 旧版の editor を配置して起動する。

### 3.6 テスト

- `rebaseCssUrls` の単体テスト: 相対の付け替え、`../` の正規化、ルート外の原文維持、`data:`・`#`・絶対 URL・`/`・`local()` の非対象、エスケープを含む値と空白・`)` を含む値の引用形での書き戻し、引用符文字列の非対象、検査（`findExternalRefsInCss`）が付け替え後も緩まないこと。
- 経路ごとの「1 回だけ」: サーバ 3 入口と web 2 か所の出力に `css/css/` が含まれないこと。`filledHtml` 経由の再入でも二重にならないこと。
- import の許可リスト検査（`ssti.guard` と同型）: `rebaseCssUrls` を import してよいのはサーバの共通ヘルパと `nunjucksRender.ts`・`reviewCompareDocs.ts` だけ。
- 配信: css/fonts グループの拡張子制限、`cssDir` 直下のフォントは配信しないこと、`Fonts` の大小無視、最長一致、symlink・深さの既存制約が保たれること。
- 設定: `paths.assetsDir` / `ASSETS_DIR` で起動エラー、`JS_DIR` / `paths.jsDir` の解決。
- 更新する既存テスト: `server/test/docAssets.test.ts`、`config.paths.test.ts`、`previewHost.test.ts`、`docRefs.test.ts`（`['css/510037.css','fonts/a.woff2','css/fonts/a.woff2']` を追加）、`inlineCss.test.ts`、`externalRefs.test.ts`、`previewProxy.test.ts`、`renderHost.test.ts`、`web/test/previewSelfContain.dom.test.ts`、`openapiArtifact.guard.test.ts`（再生成）。
- 新規の shared ファイルはルート `vitest.config.ts` の coverage include に加え、単体で 85% を満たす。
- 移行パッチ: 一時フォルダに旧構成を作り、dry-run（何も変わらない）、`-Apply`（移動・照合・改名・書き換え・コミット）、再実行（変化なし）、競合（中止）、サーバ稼働中・未コミット変更あり（中止）を確認する。

### 3.7 文書

- 運用手順書 `docs/editor/src/デプロイ運用手順書.md`: 設定表（`paths.assetsDir` → `paths.jsDir`）、3.1 節のフォルダ構成図、移行手順（停止 → 新版を配置 → パッチ → 起動）。HTML を `docs/_build/build_all.py --project editor` で再生成する。
- 設計正典 `docs/editor/src/設計正典.md`: 相対参照の節（置き場・配信パス・付け替えの契約・「1 経路 1 回」の不変則）。却下項目として「HTML の `<style>` も付け替える」「フォントを複数の配信パスで配る」を追記する。`.claude/rules/design-canon-summary.md` を更新し、`pnpm run check:canon-summary -- --update`。
- コメント: `docAssets.ts`、`docRefs.ts`、`config.ts`、`renderHost.ts`、`previewHost.ts`、`htmlExternalRefs.ts` の `fonts/` / `assets` 表記。

## 4. 範囲外・残るリスク

- 編集キャンバスと差分表示・パーツプレビューでのフォント表示（現状も効いていない。srcdoc/blob/about:blank では相対 URL が解決できない）。
- templates / filled の HTML 内に `fonts/` 参照がある場合、移行後は配信されなくなる（パッチは報告のみ）。承認経路で直す。
- 移行前に出した申請の `reviews/*/filled.html`（旧参照入りの `<style>`）や、履歴比較の旧版 CSS はフォント無しで表示される。
- 本番 editor-data の CSS は未確認。パッチの dry-run で実データの件数を確認してから `-Apply` する。
- トンボの CSS に相対 url を足すと、PDF とプレビューで解決先が食い違う（コメントで注記）。

## 5. 却下した案

- 配信パスを `fonts/` と `css/fonts/` の両方にする（同じ書き方がどの経路でも届くが、同じ実体が 2 つのパスで見える）。ユーザーは `css/fonts/` のみ + 付け替えを選んだ。
- リクエストの css をファイルとして配信ルートに置き `<link>` で読ませる（画面内プレビューは資産を取りに行けず、下書き CSS の後勝ちの前提も崩れる）。
- `rebaseCssUrls` を冪等にする安全弁（`css/` 配下に解決済みなら触らない）。意味論が歪み、著者の意図を判別できない。
- `assetsDir` を黙って無視する、または `assetsDir/js` から `jsDir` を自動導出する（互換コードが残る、または js が黙って欠ける）。
