# editor: ファンド別画像の表示 — 設計

- 日付: 2026-10-01
- 対象: `editor/`（server / web / shared）、`editor/scripts/init-data-repo.ps1`
- 位置付け: 「フォント置き場の css/fonts 移設」（`2026-10-01-editor-fonts-to-css-design.md`、PR #70 で main 取り込み済み）に続く②。①で入った `rebaseCssUrls`（リクエスト CSS を `css/` 基準へ付け替え）と、配信グループの最長一致の上に作る。

## 1. 目的と成功条件

### 目的

テンプレ（Jinja / 値入り HTML）とファンド CSS から、ファンドごとの画像（SVG を既定、png / jpg も可）を相対パスで参照し、PDF・画面内プレビュー・編集画面で表示できるようにする。

### 成功条件

1. `dataRoot\images\510037_logo.svg` を置き、テンプレに `<img src="images/{{ fund.code }}_logo.svg">`（作成タブ）または `<img src="images/510037_logo.svg">`（値入り HTML）と書けば、PDF・画面内プレビュー・編集画面のどれでも表示される。
2. ファンド CSS の `url(../images/510037_logo.svg)` が、PDF と画面内プレビューで表示される。
3. 危険な SVG（スクリプト・イベント属性・外部参照など）は、どの経路でも配信・表示されない。
4. 編集画面の差し替えは表示だけで、保存される HTML（下書き・申請・確定）は原文のまま変わらない。

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
- `.gitignore` の必須行に `/images/` を加える（`gitRepo.ts` の `ensureGitignore` と `init-data-repo.ps1`）。承認コミットの対象（`COMMITTED_PATHSPECS`）には入れない。
- `init-data-repo.ps1` が `images` フォルダを作る。

### 3.2 配信の許可リスト

- `ASSET_GROUPS` に、配信パス `images`・元フォルダ `imagesDir`・拡張子 `.svg .png .jpg .jpeg` のグループを足す。
- `images` グループは直下のファイルだけを対象にする（サブフォルダを降りない。配信パスは `images/<ファイル名>` の 2 セグメントだけを解決する）。
- ファイル名に規則の検査は設けない。ファンドの区別は命名の約束で、守りは拡張子の許可リスト・直下限定・symlink 拒否（既存の lstat 判定）による。参照された画像だけが配置されるので、他ファンドの画像が配信ルートへ載ることはない。

### 3.3 SVG の検査

- `@editor/shared` に許可リスト型の判定関数を 1 つ置く: `inspectSvg(text: string): string[]`（違反の説明の一覧。空なら合格）。
- 許可する要素と属性を列挙し、それ以外を違反とする（拒否リストではなく許可リスト）。少なくとも次を違反にする。
  - `<script>`、`<foreignObject>`、`<iframe>` / `<object>` / `<embed>` / `<audio>` / `<video>`、`<animate>` 系で `href` / `xlink:href` を書き換えるもの、`<set>`。
  - `on` で始まる属性。
  - `href` / `xlink:href` / `src` の値が `#id` 以外（外部 URL・別ファイル・`data:`・`javascript:`）。
  - `<style>` の中身と `style` 属性で、外部参照を持つもの（判定は既存の `findExternalRefsInCss` を使う）と `url()` が `#id` 以外を指すもの。
  - XML の処理命令（`<?xml-stylesheet`）、`<!DOCTYPE` / `<!ENTITY`。
- 許可するもの: 描画要素（`svg` `g` `path` `rect` `circle` `ellipse` `line` `polyline` `polygon` `text` `tspan` `defs` `linearGradient` `radialGradient` `stop` `clipPath` `mask` `pattern` `symbol` `use` `title` `desc` `style` など）、`#id` を参照する `use` / `url(#id)`、内部の `<style>`。Illustrator 等の出力で使われる要素・属性は、実ファイルで落ちたものを許可リストへ足す運用とする。
- 解析は文字列の字句走査で行い、DOM パーサに依存しない（サーバとブラウザの両方で同じ結果を出すため）。解釈できない入力（閉じていないタグなど）は違反とする（fail closed）。
- 呼び出す場所は 3 か所で、同じ関数を使う。
  1. PDF の配置時（`stageDocAssets`）: 違反した SVG は配置しない。ビルドは失敗させず、サーバログに警告（ファイル名と違反）を出す。参照は従来どおり落ちる。
  2. 編集画面用の配信ルート（3.6）: 違反なら 404。
  3. 画面内プレビューの埋め込み（3.5）: 違反なら埋め込まない。

### 3.4 PDF

- 本文の `{{ fund.code }}` は描画（`renderJinjaIsolated`）の段階で展開されるので、サーバに届くのは確定したパス（`images/510037_logo.svg`）だけ。
- ファンド CSS の `url(../images/510037_logo.svg)` は、①の付け替えで `images/510037_logo.svg` になり、同じ配置経路に乗る。
- 追加の変更は 3.2 と 3.3 だけ（参照の洗い出しは既存の `collectDocumentAssetRefs` が属性・CSS とも拾う）。

### 3.5 画面内プレビュー

- `previewSelfContain.ts` に、`<img src>` と `<style>` 内の `url()` で `images/` を指すものを data URI に置き換える処理を足す。取得先は `/api/preview-host/images/…`（プレビューホストは同じ許可リストで配る）。
- SVG は埋め込む前に親の側でも `inspectSvg` を通し、違反なら埋め込まない（原文のまま残す = 表示されない）。
- `data:image/svg+xml` は、この埋め込み処理が作るときだけ使う。共有の `ALLOWED_DATA_PREFIXES` には足さない（テンプレの著者が未検査の SVG を data URI で直接書く経路を開かないため）。埋め込み後の文書が後段の検査・サニタイズで落とされないことをテストで確かめる。落とされる場合は、埋め込みを表示境界（サニタイズの後の DOM 操作。既存のフォント埋め込みと同じ段）で行う。
- png / jpeg は既存の許可リストに入っているので、そのまま data URI にできる。
- 埋め込みの上限（1 ファイルあたりのバイト数）は既存のフォントの上限（`MAX_INLINE_FONT_BYTES`）と同じ考え方で設け、超えたものは埋め込まない。

### 3.6 編集画面

#### 配信ルート

- 認証付きの読み取り専用ルート `GET /api/fund-assets/images/:file` を足す。
  - 解決は `docAssets.ts` の `resolveServedAssetSource('images/<file>')` を使う（許可リスト・直下限定・symlink 拒否を共有する。別の解決器を作らない）。
  - SVG は `inspectSvg` を通し、違反なら 404。
  - レスポンスヘッダ: 拡張子に応じた `Content-Type`、`X-Content-Type-Options: nosniff`、SVG には `Content-Security-Policy: sandbox`（直接開かれても文書としてスクリプトを動かさない）、`Cache-Control: no-store`（画像は外から差し替わるため）。
  - 閲覧権限は CSS と同じ（ログインしていれば全ファンドの画像を見られる）。

#### 表示の差し替え

- GrapesJS の画像（`<img>`）の描画時に、画面上の要素の `src` だけを配信ルートの URL へ書き換える。モデル（保存される HTML）の属性は変えない。下書き・Undo・保存に書き換え後の URL が混ざらないこと、`toTemplate` の往復が原文を保つことを構造で保証する（モデルに触らないので、保存時に戻す処理が無い）。
- 書き換えの対象は、`src` が `images/` で始まる相対パスで、ファイル名部分に Jinja が無いか、`{{ fund.code }}`（前後の空白違いを含む）だけを含むもの。`{{ fund.code }}` はテンプレ ID のファンドコード（`parseTemplateFileName`）に置き換える。作成タブ（共通サンプルで表示）でも同じく、テンプレのファンドコードを使う（画像は差し込み値ではなく、CSS と同じ「ファンドの資産」として扱う）。
- それ以外の Jinja を含む `src`、`images/` 以外の相対パスは書き換えない（従来どおり表示されない）。
- CSS の背景画像は編集画面では表示しない（フォントと同じ。canvas の CSS の相対 URL はアプリの URL 基準で解決されるため）。
- 実装の置き場は編集画面の描画層（`features/editor/` 配下の新しいモジュール）とし、`toFilled` / `jinjaMask` には手を入れない（属性内の Jinja を展開しない原則を崩さない）。

### 3.7 テスト

- `inspectSvg`: 許可の代表（Illustrator 風の出力、`<use href="#a">`、`url(#grad)`、内部 `<style>`）と、拒否の各パターン（3.3 の列挙すべて、エスケープ・大文字・名前空間接頭辞 `xlink:` 違い・閉じていないタグ）。
- 配置: `images` 直下だけ・拡張子・サブフォルダは対象外・違反 SVG は配置せず警告・`css/fonts` など既存グループの挙動が変わらないこと。
- 配信ルート: 認証なしは 401、`..` やサブフォルダは 404、違反 SVG は 404、ヘッダ（`Content-Type`・`nosniff`・SVG の `sandbox`・`no-store`）。
- プレビュー: `<img src="images/…">` と `url(images/…)` の埋め込み、違反 SVG を埋め込まないこと、`ALLOWED_DATA_PREFIXES` を変えていないこと、埋め込み後の文書が表示されること。
- 編集画面: 表示の `src` が配信ルートを指すこと、`{{ fund.code }}` の置き換え、対象外の `src` を書き換えないこと、保存出力（`getHtml` → `toTemplate`）が原文のままであること。
- 新規ファイルはルート `vitest.config.ts` の coverage include に加え、単体で 85% を満たす。

### 3.8 文書

- 運用手順書: 設定表に `paths.imagesDir` / `IMAGES_DIR`、3.1 節のフォルダ構成図に `images\`（git 管理外・別ツールが置く・命名 `<fund>_<名前>`）、画像の書き方（テンプレ・値入り HTML・ファンド CSS それぞれ）。
- 設計正典: 相対参照の節に `images/` の置き場・配信・SVG 検査の 3 か所・編集画面は表示だけ差し替える不変則。却下済み設計に「編集画面で画像の `src` をモデルごと書き換えて保存時に戻す」「`data:image/svg+xml` を共有の許可リストへ足す」を追記し、要約と `check:canon-summary` を更新する。
- OpenAPI に新しいルートを足し、`openapi.json` を再生成する。

### 3.9 既存環境向けパッチ

既存の dataRoot（①の移行済み）を、画像を置ける状態にする。①と同じ形のパッチを別フォルダに置く。

置き場: `editor/patches/2026-10-fund-images/`

- `apply.ps1`（UTF-8 BOM）と `apply.bat`（CRLF、`chcp 65001 >nul`、4 行雛形）
- `rollback.ps1` / `rollback.bat`
- `README.md`（目的・前提・手順・画像の置き方と命名・元に戻し方）
- `apply.Tests.ps1`（Pester 3/4 書式）
- ルート `README.md` の入口スクリプト一覧に 2 行

#### 置き場の解決

- ①の `migrate.ps1` と同じ規則・同じ表示にする: dataRoot は `-DataRoot` → `DATA_ROOT`（プロセス → ユーザー環境変数）→ appconfig `paths.dataRoot` → 既定。images は `IMAGES_DIR` → appconfig `paths.imagesDir` → `<dataRoot>\images`。解決結果と出典を表示する。
- 解決関数は①のパッチと重複して持つ（①の判断と同じく、共通 lib は作らない）。

#### 実行条件と既定動作

- 既定は確認モード（何も変えない）。`-Apply` を付けたときだけ実行する。
- 次の場合は中止する: editor サーバが動いている（ポート確認）、dataRoot が git リポジトリでない、確定領域（`.gitignore .gitattributes templates filled css sync`）に未コミット変更がある（`css/fonts` は除外）。
- ①の移行が済んでいない環境（`<dataRoot>\assets` が残っている）は、先に①のパッチを流すよう案内して中止する。

#### 処理（`-Apply` 時、この順）

1. `.gitignore` に `/images/` が無ければ追記する（BOM 無し、LF）。画像を置く前に追跡外にしておく。
2. `<imagesDir>` が無ければ作る。
3. `.gitignore` の変更を `system` 名義で 1 コミットする。件名は「移行: 画像の置き場を追加 [fund-images]」（末尾は rollback が探す ASCII の目印）。

#### 報告のみ（書き換えない）

- 既に置かれている画像の点検結果を表示する。
  - `images` 直下以外（サブフォルダ）に置かれたファイル（配信されない）。
  - 許可外の拡張子（配信されない）。
  - 命名 `<fund>_<名前>` に合わないファイル（配信はされるが約束から外れる）。
- SVG の中身の検査（3.3）はサーバ側の TypeScript 実装が正なので、パッチでは行わない。違反はサーバログの警告で確認する、と README に書く。

#### 冪等性

- `.gitignore` に既に `/images/` があり、`<imagesDir>` も存在すれば、何も変えずに終わる（コミットも作らない）。

#### 元に戻す（rollback）

- 既定は確認モード。`-Apply` で、目印 `[fund-images]` を持つ移行コミット（`Revert` で始まる件名は除外、既に revert 済みなら飛ばす）を `git revert` する。失敗したら `git revert --abort` してから中止し、git の出力を表示する。
- `<imagesDir>` と中の画像は消さない（別ツールが置いたもので、git 管理外のため戻せない）。README に、不要なら手で消すと書く。

#### テスト（Pester）

- 確認モードで何も変えない。
- `-Apply` で `.gitignore` に `/images/` が入り、`images` が作られ、`system` 名義・`[fund-images]` 付きの 1 コミットができる。
- 再実行で何も変わらない（HEAD 不変）。
- `assets` が残っていれば中止する。
- 未コミット変更があれば中止する。
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
- 編集画面で、相対パスがそのまま届くようにアプリ側へルートを足す（`/edit/images/*`）: 画面の URL 構造に依存し、`{{ fund.code }}` を表示できない。
- 編集画面への `<base href>` の挿入: 却下済み（取り込みで落とされる）。
- `data:image/svg+xml` を共有の許可リストへ足す: テンプレの著者が未検査の SVG を直接書けるようになる。
