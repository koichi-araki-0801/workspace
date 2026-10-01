# editor: ファンド別画像の表示 — 設計

- 日付: 2026-10-01
- 対象: `editor/`（server / web / shared）、`editor/scripts/init-data-repo.ps1`
- 位置付け: 「フォント置き場の css/fonts 移設」（`2026-10-01-editor-fonts-to-css-design.md`、PR #70 で main 取り込み済み）に続く②。①で入った `rebaseCssUrls`（リクエスト CSS を `css/` 基準へ付け替え）と、配信グループの最長一致の上に作る。

## 1. 目的と成功条件

### 目的

テンプレ（Jinja / 値入り HTML）とファンド CSS から、ファンドごとの画像（SVG を既定、png / jpg も可）を相対パスで参照し、PDF・画面内プレビュー・編集画面で表示できるようにする。

### 成功条件

1. `dataRoot\images\510037_logo.svg` を置き、テンプレに `<img src="images/{{ fund.code }}_logo.svg">`（作成タブ）または `<img src="images/510037_logo.svg">`（値入り HTML。外部ツールが確定したパスを書く）と書けば、PDF・画面内プレビュー・編集画面のどれでも表示される。値入り HTML に `{{ fund.code }}` が残っていれば、どの経路でも表示されず、編集画面に警告が出る。
2. ファンド CSS の `url(../images/510037_logo.svg)` が、PDF と画面内プレビューで表示される。
3. 危険な SVG（スクリプト・イベント属性・外部参照など）は、どの経路でも配信・表示されない。
4. 編集画面の表示は CSS だけで行い、文字編集・ペーストを含むどの操作の後も、保存される HTML（下書き・申請・確定）は原文のまま変わらない。

### 前提（ユーザー確定）

- 画像はエディタの外（値入り HTML を置く別ツールなど）が `dataRoot\images\` に置く。エディタは読み取って表示するだけで、アップロード・差し替え・削除の機能は持たない。差し込まれた画像をエディタ側で変えることはない。
- 置き場はフラットで、ファイル名は `<fund>_<画像名>.<拡張子>`（例 `510037_logo.svg`）。サブフォルダは作らない。
- 画像は git の記録対象外（`css/fonts` と同じ扱い）。過去版の表示には現在の画像を使う。

## 2. 現状

- 配信の許可リストは `server/src/vivliostyle/docAssets.ts` の `ASSET_GROUPS`（`css/fonts`・`css`・`js`）。配信パスの最長一致でグループを引き、文書が参照したものだけを配信ルートへ配置する（`collectDocumentAssetRefs` → `stageDocAssets`）。配置する資産の中身は検査していない。
- 画面内プレビューは opaque オリジンの iframe で資産を取りに行けないため、親が `web/src/lib/previewSelfContain.ts` で `<style>` 内の `url(css/fonts/…)` を data URI に置き換えている。`<img src>` は扱っていない。
- 共有の data URI 許可リスト（`shared/src/security/cssExternalRefs.ts` の `ALLOWED_DATA_PREFIXES`）は png / jpeg / gif / webp / font を許し、`data:image/svg+xml` は許さない。
- 編集画面（GrapesJS の canvas）はアプリと同一オリジンで、相対 URL はアプリの URL（`/edit/:id`）を基準に解決されるため、`images/…` は必ず 404 になる。`toFilled` は属性内の Jinja を展開しない（属性は原文のまま往復させる）。`<base href>` は却下済み。
- テンプレ ID は `<会社>_<ファンド>_<基準日>_<版>`（`shared/src/domain/template.ts` の `parseTemplateFileName`）で、ファンドコードを取り出せる。

## 3. 設計

### 3.1 置き場と設定

- 置き場は `config.imagesDir`（環境変数 `IMAGES_DIR`、appconfig `paths.imagesDir`、既定 `dataRoot/images`）。
- `imagesDir` が確定領域（`COMMITTED_PATHSPECS` の `templates` `filled` `css` `sync`）の内側を指していたら、起動を中止する（`git add -A -- css` などで画像が承認コミットへ巻き込まれるため）。
- `.gitignore` の必須行に `/images/` を加える（`gitRepo.ts` の `ensureGitignore` と `init-data-repo.ps1`）。承認コミットの対象（`COMMITTED_PATHSPECS`）には入れない。
- `init-data-repo.ps1` が `images` フォルダを作る。
- 外部ツールへの約束（運用手順書に書く）: ファイル名は `<fund>_<画像名>.<拡張子>`。書き込みは一時名で書いてから改名する（書きかけを読まないため）。値入り HTML の参照は確定したパス（`images/510037_logo.svg`）で書き、`{{ fund.code }}` を残さない。SVG には `width` / `height` を書く（無いと `<img>` で 300×150 になる）。

### 3.2 配信の許可リスト

- `ASSET_GROUPS` に、配信パス `images`・元フォルダ `imagesDir`・拡張子 `.svg .png .jpg .jpeg` のグループを足す。
- グループごとに深さの上限を持たせ（`AssetGroup.maxDepth`。既存グループは従来の `MAX_ASSET_DEPTH`）、`images` は 0（直下のファイルだけ）にする。`collectGroup` と `resolveServedAssetSource` の両方でこの値を使う。
- ファイル名に規則の検査は設けない。ファンドの区別は命名の約束で、守りは拡張子の許可リスト・直下限定・symlink 拒否（既存の lstat 判定）による。参照された画像だけが配置されるので、他ファンドの画像が配信ルートへ載ることはない。
- `docAssets.ts` 冒頭の置き場の一覧コメントを更新する。

### 3.3 SVG の検査

#### 判定関数

- `@editor/shared` に許可リスト型の判定関数を 1 つ置く: `inspectSvg(text: string): string[]`（違反の説明の一覧。空なら合格）。DOM パーサに依存しない字句走査で、サーバとブラウザで同じ結果を出す。解釈できない入力は違反（fail closed）。
- 前処理: UTF-8 以外の encoding 宣言・UTF-16 の BOM・NUL を含むものは違反。属性値は数値文字参照と定義済み 5 種の実体参照を解いてから判定する。
- 許可するもの（Illustrator「SVG 1.1」書き出し・Inkscape「プレーン SVG」の通常出力が通ること）:
  - 先頭の `<?xml version=… encoding="UTF-8"?>` 宣言（それ以外の処理命令は違反）。
  - 外部 ID だけの `<!DOCTYPE svg PUBLIC "…" "…">`（内部サブセット `[`…`]` を持つもの、`<!ENTITY` は違反）。
  - コメント、`<![CDATA[ … ]]>`（`<style>` の中身として CSS 検査する）。
  - SVG 1.1 の構造・描画・グラデーション・クリップ・マスク・パターン・テキスト・`filter` と `fe*` 要素、`<metadata>` とその中の RDF、Inkscape の `sodipodi:*` / `inkscape:*` 要素・属性、`data-*` 属性、プレゼンテーション属性。許可集合は SVG 1.1 の要素・属性一覧から起こす。
  - `href` / `xlink:href` は `#id`。`<image>` の `href` に限り、共有の `ALLOWED_DATA_PREFIXES`（png / jpeg / gif / webp。SVG は含まない）の data URI。
  - `<style>` の中身・`style` 属性・プレゼンテーション属性（`fill` `stroke` `filter` `clip-path` `mask` `marker-*` など）の `url()` は `#id` だけ。外部参照の判定は既存の `findExternalRefsInCss` を使う。
  - `xmlns` は SVG の名前空間、`xmlns:xlink` は xlink、`xmlns:sodipodi` / `xmlns:inkscape` / `xmlns:rdf` / `xmlns:dc` / `xmlns:cc` は既知の URI との完全一致だけ。
- 違反にするもの: `<script>`、`<foreignObject>`、`<iframe>` `<object>` `<embed>` `<audio>` `<video>` `<a>`、SMIL のアニメーション要素すべて（`animate` `set` `animateMotion` `animateTransform` `animateColor`）、`on` で始まる属性、`xml:base`、上記以外の名前空間・接頭辞（`<svg:script>`、`xmlns:q="…/xlink"` と `q:href` の別名、既定名前空間の HTML への差し替え）、許可集合に無い要素・属性。
- Illustrator の「Illustrator の編集機能を保持」で保存した SVG（内部サブセットや `<i:pgf>` を持つ）は落ちる。運用手順書に「書き出し（SVG 1.1）で保存する」と書く。

#### 呼ぶ場所（関所は 2 つ）

1. **配置時**（`stageDocAssets`）: `expandReferenced` で配置対象が決まった後、参照された SVG だけを検査する（カタログ作成の段では読まない。全画像を毎回読まないため）。違反した SVG は配置しない。ビルドは失敗させず、サーバログに警告（ファイル名と違反）を出す。参照は従来どおり落ちる。
2. **単体配信時**（`/api/fund-assets/images/:file`、3.6）: 違反なら 404。

画面内プレビューの埋め込み（3.5）は 2 の配信ルートから取得するので、同じ関所を通る。プレビューホスト（`/api/preview-host/…`）は `images/` を配らない（3.5）。

### 3.4 PDF

- 作成タブの本文の `{{ fund.code }}` は描画（`renderJinjaIsolated`）の段階で展開されるので、サーバに届くのは確定したパスだけ。編集タブは値入り HTML をそのまま送るので、確定したパスで書かれている前提（3.1 の外部ツールへの約束、3.6 の警告）。
- ファンド CSS の `url(../images/510037_logo.svg)` は、①の付け替えで `images/510037_logo.svg` になり、同じ配置経路に乗る。`url(images/…)` と書くと `css/images/…` になって配信されない（運用手順書に書く）。
- 参照の洗い出しは既存の `collectDocumentAssetRefs` が属性・CSS とも拾い、`inlineCss` は `<img>` を落とさない。追加の変更は 3.2 と 3.3 だけ。

### 3.5 画面内プレビュー

- `previewSelfContain.ts` に、`<img src>` と `<style>` 内の `url()` で `images/` を指すものを data URI に置き換える処理を足す。置き換えは DOM の上で行い、既存のフォント埋め込みと同じ段（サニタイズの後・直列化の前）に置く。
- 取得先は `/api/fund-assets/images/:file`（3.6。SVG 検査と認証を通る）。親は同一オリジンなので cookie が付く。
- `data:image/svg+xml` は、この埋め込み処理が作るときだけ使う。共有の `ALLOWED_DATA_PREFIXES` には足さない（テンプレの著者が未検査の SVG を data URI で直接書く経路を開かないため）。プレビューホストの CSP は `img-src 'self' data: blob:` なので、変更は要らない。
- png / jpeg も data URI にする（子は資産を取りに行けないため）。
- 埋め込みの上限（1 ファイルあたりのバイト数）は既存のフォントの上限と同じ考え方で設け、超えたものは埋め込まない。
- キャッシュはページの寿命（フォントと同じ）。外部ツールが画像を差し替えた場合、プレビューへの反映はブラウザの再読み込みが必要（運用手順書に書く）。
- プレビューホストのワイルドカード配信（`previewHost.ts` の資産ルート）は `images/` を 404 にする。画像の配信経路を `/api/fund-assets/images/` の 1 本に集める（検査を通らない経路を作らないため。却下済み「同じ実体を複数の配信パスで配る」と同型）。

### 3.6 編集画面

#### 配信ルート

- 認証付きの読み取り専用ルート `GET /api/fund-assets/images/:file` を足す。
  - 経路の検査は 2 段にする: `resolveServedAssetPath('images/' + file)`（`\`・`..`・絶対参照を拒否。プレビューホストと同じ前段）→ `resolveServedAssetSource`（許可リスト・直下限定・symlink 拒否を共有する。別の解決器を作らない）。Windows の予約名（`CON` `PRN` `AUX` `NUL` `COM1`〜`COM9` `LPT1`〜`LPT9`。拡張子付きを含む）は名前で拒否する。
  - SVG は `inspectSvg` を通し、違反なら 404。
  - レスポンスヘッダ: 拡張子に応じた `Content-Type`、`X-Content-Type-Options: nosniff`、`Cache-Control: no-store`（画像は外から差し替わるため）。SVG には `Content-Security-Policy: sandbox`（直接開かれても opaque オリジンでスクリプトを動かさない）。全体共通の CSP を上書きするため、`previewHost.ts` と同じく独自コンテキストの `onSend` で付ける。
  - 閲覧権限は CSS と同じ（ログインしていれば全ファンドの画像を見られる）。
  - 登録: shared の `apiPaths` → `ROUTE_POLICY`（`'auth'`）→ OpenAPI の document と `openapi.json` の再生成 → `guardCoverage.guard.test` の列挙に「`resolveServedAssetSource` の呼び出し元は SVG 検査を通る」を加える。web 側の URL も `apiPaths` から作る。

#### 表示（CSS で画像を差す）

- 画像要素の属性は一切書き換えない。編集画面（canvas）専用の `<style>` に、表示したい `<img>` ごとに次の規則を書く。

  ```css
  img[src="images/510037_logo.svg"] { content: url("/api/fund-assets/images/510037_logo.svg"); }
  ```

  DOM の属性もモデルも変わらないので、文字編集（RTE）の取り込み直し・ペースト・ドロップ・Undo・`getHtml` のどれを通っても、保存される HTML に配信ルートの URL が混ざることは原理的に起きない。
- 規則を作る対象は、canvas 内の `<img>` の `src` が `images/` で始まる相対パスのもの。
  - 作成タブ: `images/{{ fund.code }}_logo.svg` の `{{ fund.code }}`（前後の空白違いを含む）を、テンプレ ID のファンドコード（`parseTemplateFileName`。`buildSampleData` が `fund.code` に入れる値と同じ出所）で置き換えたパスを配信ルートに使う。セレクタは原文の `src` の字面で書く（CSS の属性セレクタの値としてエスケープする）。
  - 編集タブ: 確定したパス（`images/510037_logo.svg`）だけを対象にする。`{{` を含む `src` は解決せず（PDF とプレビューでも表示されないため、編集画面だけ表示されるずれを作らない）、警告を出す（下記）。
  - それ以外の Jinja を含む `src`、`images/` 以外の相対パスは対象外（従来どおり表示されない）。
- 規則は canvas の DOM を走査して作り直す（読み込み時と、コンポーネントの追加・削除・属性変更の後）。GrapesJS の image コンポーネントにならない `<img>`（Jinja のブロックにまとめられた範囲の中など）も、DOM の走査なので同じ規則で表示される。
- GrapesJS の画像の読み込み失敗時の代替画像（`onError` で `src` を差し替える処理）が、対象の `<img>` で動かないようにする（`src` が差し替わるとセレクタが外れるため）。image の view を拡張して、対象の `src` では代替処理を止める。
- `content: url()` の画像は `load` イベントを出さないので、ページ境界・幾何の再計測は、規則を作り直したあとの画像の読み込み完了（`Image` オブジェクトで同じ URL を先読みして `decode()` を待つ）を契機に行う。
- CSS の背景画像は編集画面では表示しない（フォントと同じ。canvas の CSS の相対 URL はアプリの URL 基準で解決されるため）。
- 実装の置き場は編集画面の描画層（`features/editor/` 配下の新しいモジュール）とし、`toFilled` / `jinjaMask` / canvas 入口の刈り取りには手を入れない。
- 範囲外: `srcset` / `<picture>`、赤入れ表示の中の画像、パーツカタログのプレビュー。

#### 編集タブの警告

- 編集タブで開いた値入り HTML に、`src` が `images/` で始まり `{{` を含む `<img>` があれば、編集画面に警告を出す（「値入り HTML の画像参照に `{{ fund.code }}` が残っています。外部ツールで確定したパスを書いてください。PDF には表示されません」）。表示位置は既存の編集画面の警告と同じ枠を使う。

### 3.7 テスト

- `inspectSvg`: 許可の代表（Illustrator の SVG 1.1 書き出し、Inkscape のプレーン SVG、`<?xml ?>`、外部 ID だけの DOCTYPE、CDATA、コメント、`<use href="#a">`、`fill="url(#grad)"`、`<image href="data:image/png;base64,…">`、`filter`）と、拒否の各パターン（3.3 の違反の列挙すべて、内部サブセット、`<!ENTITY`、文字参照で隠した `javascript:`、`xlink` の別名接頭辞、既定名前空間の差し替え、プレゼンテーション属性の外部 `url()`、`<image href="data:image/svg+xml,…">`、非 UTF-8、閉じていないタグ、引用符の無い属性値）。実ファイルの見本（小さな Illustrator / Inkscape の出力）を fixture に置く。
- 配置: `images` 直下だけ・拡張子・サブフォルダは対象外・参照された SVG だけを読むこと・違反 SVG は配置せず警告・既存グループ（`css/fonts`・`css`・`js`）の挙動が変わらないこと。
- 設定: `imagesDir` の既定・上書き・確定領域の内側なら起動中止。
- 配信ルート: 認証なしは 401、`..`・`%5C`・`%2F`・サブフォルダ・予約名は 404、違反 SVG は 404、ヘッダ（`Content-Type`・`nosniff`・`no-store`・SVG の `sandbox`）。プレビューホストの `images/` は 404。
- プレビュー: `<img src="images/…">` と `url(images/…)` の埋め込み、違反 SVG を埋め込まないこと、`ALLOWED_DATA_PREFIXES` を変えていないこと。
- 編集画面: 規則が対象の `<img>` に対して作られること、作成タブの `{{ fund.code }}` の置き換え、編集タブの `{{` 入りは対象外で警告が出ること、対象外の `src` に規則を作らないこと、文字編集の取り込み直し・ペーストの後も保存出力（`getHtml` → `toTemplate`）が原文のままであること、代替画像処理が対象で止まること。
- ファンドコードの出所の一致（キャンバスの解決と `buildSampleData` の `fund.code`）。
- 新規ファイルはルート `vitest.config.ts` の coverage include に加え、単体で 85% を満たす。

### 3.8 文書

- 運用手順書: 設定表に `paths.imagesDir` / `IMAGES_DIR`、3.1 節のフォルダ構成図に `images\`（git 管理外・別ツールが置く・命名 `<fund>_<名前>`）、3.1 の外部ツールへの約束、画像の書き方（テンプレ・値入り HTML・ファンド CSS それぞれ）、SVG は「書き出し（SVG 1.1）」で保存すること、差し替え後のプレビュー反映は再読み込み。
- 設計正典: 相対参照の節に `images/` の置き場・配信経路の 1 本化・SVG 検査の 2 つの関所・編集画面は CSS で表示する不変則。却下済み設計に「編集画面で画像の `src` を書き換えて表示する（保存内容へ混入する経路が残る）」「`data:image/svg+xml` を共有の許可リストへ足す」「画像をプレビューホストのワイルドカードでも配る」を追記し、要約と `check:canon-summary` を更新する。
- OpenAPI に新しいルートを足し、`openapi.json` を再生成する。

### 3.9 既存環境向けパッチ

既存の dataRoot（①の移行済み）を、画像を置ける状態にする。①と同じ形のパッチを別フォルダに置く。

置き場: `editor/patches/2026-10-fund-images/`

- `apply.ps1`（UTF-8 BOM）と `apply.bat`（CRLF、`chcp 65001 >nul`、4 行雛形）
- `rollback.ps1` / `rollback.bat`
- `README.md`（目的・前提・手順・画像の置き方と命名・外部ツールへの約束・元に戻し方）
- `apply.Tests.ps1`（Pester 3/4 書式）
- ルート `README.md` の入口スクリプト一覧に 2 行

#### 置き場の解決

- ①の `migrate.ps1` と同じ規則・同じ表示にする: dataRoot は `-DataRoot` → `DATA_ROOT`（プロセス → ユーザー環境変数）→ appconfig `paths.dataRoot` → 既定。images は `IMAGES_DIR` → appconfig `paths.imagesDir` → `<dataRoot>\images`。解決結果と出典を表示する。
- 解決関数は①のパッチと重複して持つ（①の判断と同じく、共通 lib は作らない）。

#### 実行条件と既定動作

- 既定は確認モード（何も変えない）。`-Apply` を付けたときだけ実行する。
- 次の場合は中止する: editor サーバが動いている（ポート確認）、dataRoot が git リポジトリでない、確定領域（`.gitignore .gitattributes templates filled css sync`、`css/fonts` は除外）に未コミット変更がある、`imagesDir` が確定領域の内側にある。
- ただし、未コミット変更が「`.gitignore` に `/images/` の 1 行が追記されただけ」のときは中止しない（新版のサーバが承認時に先に追記した場合。この差分を取り込んで処理を進める）。
- ①の移行が済んでいない環境（`<dataRoot>\assets` が残っている）は、先に①のパッチを流すよう案内して中止する。①を rollback して `assets` が戻った環境も同じく中止する（正しい挙動として README に書く）。
- 推奨手順は「サーバ停止 → 新版を配置 → パッチ → 起動」（①と同じ）。

#### 処理（`-Apply` 時、この順）

1. `.gitignore` に `/images/` が無ければ追記する（BOM 無し、LF）。画像を置く前に追跡外にしておく。
2. `<imagesDir>` が無ければ作る。
3. `.gitignore` の変更を `system` 名義で 1 コミットする。件名は「移行: 画像の置き場を追加 [fund-images]」（末尾は rollback が探す ASCII の目印）。

#### 報告のみ（書き換えない）

- 既に置かれている画像の点検結果を表示する。
  - `images` 直下以外（サブフォルダ）に置かれたファイル（配信されない）。
  - 許可外の拡張子（配信されない）。
  - 命名 `<fund>_<名前>` に合わないファイル（配信はされるが約束から外れる）。ファンドコードの形の判定は、shared の `isValidTemplateToken` と同じ規則を写す。
- SVG の中身の検査（3.3）はサーバ側の TypeScript 実装が正なので、パッチでは行わない。違反はサーバログの警告で確認する、と README に書く。

#### 冪等性

- `.gitignore` に既に `/images/` があり（コミット済み）、`<imagesDir>` も存在すれば、何も変えずに終わる（コミットも作らない）。

#### 元に戻す（rollback）

- 既定は確認モード。`-Apply` で、目印 `[fund-images]` を持つ移行コミット（`Revert` で始まる件名は除外、既に revert 済みなら飛ばす）を `git revert` する。失敗したら `git revert --abort` してから中止し、git の出力を表示する。
- `<imagesDir>` と中の画像は消さない（別ツールが置いたもので、git 管理外のため戻せない）。README に、不要なら手で消すと書く。
- 新版のサーバは承認時に `/images/` を再び追記するので、rollback が意味を持つのはサーバも旧版へ戻す場合に限る、と README に書く。

#### テスト（Pester）

- 確認モードで何も変えない。
- `-Apply` で `.gitignore` に `/images/` が入り、`images` が作られ、`system` 名義・`[fund-images]` 付きの 1 コミットができる。
- 再実行で何も変わらない（HEAD 不変）。
- `.gitignore` に `/images/` だけが未コミットで追記済みの状態から `-Apply` が進み、その差分がコミットに入る。
- `assets` が残っていれば中止する。
- それ以外の未コミット変更があれば中止する。
- `imagesDir` が確定領域の内側なら中止する。
- 点検の報告（サブフォルダ・拡張子・命名）が出る。
- rollback を 2 回実行しても revert の revert にならない。`images` の中身が残る。

## 4. 範囲外・残るリスク

- エディタからのアップロード・差し替え・削除（画像は外から置く）。
- 編集画面での CSS 背景画像の表示。
- 過去版の画像（現在の画像で表示する）。
- 命名の約束（`<fund>_`）は機械検査しないので、他ファンドの画像を名前で参照すれば表示できる。閲覧権限は CSS と同等であり、情報の分離としては扱わない。
- SVG の許可リストが厳しすぎて正当な画像が落ちる可能性。落ちた場合はサーバログの警告で分かるので、要素・属性を許可リストへ足す。

## 5. 却下した案

- ファンドごとのサブフォルダ（`images/<fund>/x.svg`）: ユーザーがフラット＋命名規則を選んだ。
- 資産申請（アップロード・承認・差分画面・参照切れ警告・git 記録）: 画像はエディタ側で変えないため不要になった。
- 編集画面で画像の `src` を書き換えて表示し、取り込み口で原文へ戻す: 文字編集・ペースト・ドロップの取り込み口が複数あり、戻し忘れの経路が残ると保存内容が壊れる。CSS の `content: url()` なら属性を一切変えずに済む。
- 値入り HTML の `{{ fund.code }}` を PDF・プレビューでも解決する: ユーザーが「外部ツールが確定したパスを書く」を選んだ。
- SVG 検査を警告だけにする: ユーザーが fail closed（違反は配信しない）を選んだ。
- 編集画面で、相対パスがそのまま届くようにアプリ側へルートを足す（`/edit/images/*`）: 画面の URL 構造に依存し、`{{ fund.code }}` を表示できない。
- 編集画面への `<base href>` の挿入: 却下済み（取り込みで落とされる）。
- `data:image/svg+xml` を共有の許可リストへ足す: テンプレの著者が未検査の SVG を直接書けるようになる。
