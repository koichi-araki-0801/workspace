# オフライン（社内LANのみ）運用ガイド

本アプリは将来、インターネット非接続の社内 LAN 環境で**ビルドから運用まで**を行う。
本書はその調達・展開・検証手順をまとめた runbook である。

## 方針（前提）

- **PDF 生成はサーバ側**（運用機 1 台に集約）。
- **PDF 用ブラウザは社内 Windows の Microsoft Edge を使用**（PDF 用に Chromium を同梱しない）。
- **依存は pnpm オフラインストア（`.pnpm-store/`）を tar.gz で持ち込み**、運用機で
  `pnpm install --offline` により復元する。
- **ビルドはオフライン機で実施**（復元した依存で `pnpm build`）。
- フォント・テンプレCSSは system フォントのみで外部依存なし。

> ⚠️ **OS/arch 一致が必須**: ネイティブバイナリ（biome / esbuild / rollup / lightningcss /
> playwright-core）はプラットフォーム別。**調達機（pack）と運用機を Windows x64・Node 24 で一致**させること。

## なぜオフラインで問題が起きるか（背景）

1. **PDF 用ブラウザの遅延ダウンロード**（最大の落とし穴）
   vivliostyle は `build()` 実行時にブラウザを解決し、無ければ**初回 PDF 生成時に
   インターネットから Chromium をダウンロード**する
   （`node_modules/@vivliostyle/cli/dist/output/pdf.js`）。
   → 本アプリは `executableBrowser` に **Edge を明示指定**してこれを回避する
   （`server/src/config.ts` の `resolveDefaultBrowser()` が自動検出。
   `VIVLIOSTYLE_EXECUTABLE_BROWSER` で上書き可）。
2. **依存導入時のネイティブバイナリ取得**
   通常の `pnpm install` は OS 別バイナリをネットから取る。→ オフライン機では
   調達機で構築した `.pnpm-store/` を持ち込み、`pnpm install --offline` で復元する
   （ストアにはネイティブバイナリも content-addressable で含まれる）。

## 事前に運用機へインストールしておくもの

- **Node.js 24.x**（`.nvmrc` = 24、`engines: node>=24`）
- **Python**（`/api/generate` 用。現状の stub は標準ライブラリのみ）
- **Microsoft Edge**（Windows 11 標準。`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`）

## 手順

構築手順はリポジトリ直下の **`offline/`** フォルダに集約している
（`offline/README-offline.txt` と `offline/setup-offline.bat`。pnpm 11 + オフラインストア方式。
旧 npm ベースの pack.ps1/setup.ps1 や 2 段運用の fetch スクリプトは廃止）。

配布は **2 系統**に分離し、いずれも GitHub から HTTPS だけで取得する（`gh` 不要）:

- **コード** … タグ ZIP（codeload）。Release のタグ `offline-bundle-v1` は公開のたびに最新コミットへ
  移動するため、GitHub が自動添付する `Source code (zip/tar.gz)` は最新ソースと一致する。
- **重量物**（`.pnpm-store/`・`pnpm.tgz`・`ms-playwright/`、約 1.2GB） … **GitHub Releases**
  （同タグ、`offline-deps-bundle.tar.gz`）。容量が大きく毎回 git 履歴へ積めないため git 管理外とし、
  内容（`pnpm-lock.yaml`／`packageManager`）変更時のみ更新する。

### 1. 調達（オンライン機・Windows x64・Node 24）

通常はコミット毎フック（`.husky/post-commit`）が `offline/publish-offline-bundle.ps1` を自動実行する。
ローリングタグを最新コミットへ移動して自動 Source code を更新し、重量物は content key
（`pnpm-lock.yaml` + `packageManager`）に差分がある時だけ再生成・再アップロードする（不変ならスキップ）。
手動実行は `pwsh -File offline/publish-offline-bundle.ps1`。無効化は `OFFLINE_PUBLISH_SKIP=1`。
詳細は `offline/README-offline.txt` を参照。

### 2. 取得・展開・ビルド・起動（運用機）

運用機では **`offline/` フォルダ一式だけを配置**し、`offline/setup-offline.bat` を実行する。
取得中だけリポジトリを Public にしておけば、ソース ZIP と重量物を HTTPS で自動取得・検証・展開し、
そのまま pnpm の corepack 登録 → `pnpm install --offline` → `pnpm build` → Playwright ブラウザ配置まで
一括で完走する（`gh`・`git` 不要。取得後の install/build はオフライン）。ダウンロード物は `bk/` へ退避する。
運用機は**単一 Node プロセス**で API と SPA（`web/dist`）を配信する。

手動起動する場合:

```powershell
cd <展開先>
$env:NODE_ENV='production'; corepack pnpm --filter server start
```

### 設定（`appconfig.json`）

運用設定はリポジトリ直下の **`appconfig.json`** に集約する（`appconfig.example.json` を
コピーして編集。実体は `.gitignore` 済み）。相対パスは repoRoot 基準で解決。

| キー | 既定 | 用途 |
|---|---|---|
| `port` | 3001 | API/SPA のポート |
| `paths.templatesDir` / `paths.cssDir` | `data/...` | テンプレ/CSS 配置 |
| `paths.tmpDir` / `paths.logDir` / `paths.webDist` | `.tmp` / `logs` / `web/dist` | 一時/ログ/SPA |
| `python.bin` / `python.script` / `python.timeoutMs` | `python` / `server/scripts/...` / 30000 | Python 生成器 |
| `pdf.executableBrowser` | 空=Edge 自動検出 | PDF 用ブラウザの実行ファイル |
| `logging.level` / `logging.pretty` | `info` / `false` | ログ（監査ログ `logs/audit.log`） |

> 不正な JSON や未知キーは**起動時にエラーで停止**（fail-fast）する。

### 環境変数（appconfig.json を上書き）

優先順位は **既定値 < `appconfig.json` < 環境変数**。env は次の用途に限定して使う:

1. `NODE_ENV`（`production` 実行モード。`pretty` 既定にも影響）
2. シークレット（Phase2 の SQL Server 接続情報など。example が commit されるため appconfig.json に置かない）
3. 一時・緊急の上書き（例 `PORT=3009`、`LOG_LEVEL=debug`、`VIVLIOSTYLE_EXECUTABLE_BROWSER=...`）

対応 env: `PORT` / `TEMPLATES_DIR` / `CSS_DIR` / `WEB_DIR` / `PYTHON_BIN` /
`PY_GENERATE_SCRIPT` / `PY_TIMEOUT_MS` / `TMP_DIR` / `LOG_DIR` / `LOG_LEVEL` /
`LOG_PRETTY` / `VIVLIOSTYLE_EXECUTABLE_BROWSER` / `NODE_ENV`。
設定ファイルの場所自体は `APP_CONFIG` で変更可。

## 注意点（Medium・要検証）

- **MathJax CDN**: 同梱 vivliostyle ビューア（`node_modules/@vivliostyle/viewer/lib/index.html`）が
  cdnjs の MathJax を参照する。数式を含まない帳票なら描画は成立するが、オフラインで失敗
  リクエストが出る。**検証 4** で PDF 生成がストール/失敗しないことを確認。問題が出たら
  同梱 node_modules 内の当該 `<script>` をローカル MathJax に差し替える。
- **GrapesJS の Font Awesome**: 既定値に cdnjs の FA URL があるが、本コードは
  `assetManager: { custom: true }` かつ UI アイコンはバンドル CSS を使用するため実害は低い。
  **検証 6** でエディタ UI を目視し、欠けがあれば FA をローカル同梱。

## Phase 2: Python 依存（pip）

実ジェネレータ導入で pip 依存が生じたら `server/scripts/requirements.txt` に列挙し、wheelhouse 方式で:

```powershell
# オンライン機
pwsh -File scripts/offline/python-wheelhouse.ps1 -Mode download
# オフライン機（wheelhouse を同梱）
pwsh -File scripts/offline/python-wheelhouse.ps1 -Mode install
```

## オフライン検証チェックリスト（飛行機モード / LAN 遮断で実施）

1. **調達**: バンドル tar.gz（`.pnpm-store/`・`pnpm.tgz`・`ms-playwright/` 同梱）が生成される。
2. **遮断**: 運用機をネット遮断し、`offline/setup-offline.bat` の展開〜`pnpm build` がネット無しで完走する
   （biome / esbuild / rollup / lightningcss / vue-tsc の取得が走らない）。
3. **起動**: `GET /api/health` → `{ok:true}`、ブラウザで SPA が表示される。
4. **PDF（最重要）**: `POST /api/build` で PDF 生成成功。ログに
   `Downloading now...`（`downloadBrowser`）が**出ない**こと、MathJax 失敗で生成がストール
   /失敗しないこと。
5. **生成/保存**: `POST /api/generate`・`PUT /api/templates/:id` が成功。
6. **エディタ UI**: GrapesJS のアイコン/スタイルに欠けが無いか目視。
7. **回帰**: `corepack pnpm typecheck` と `corepack pnpm check:ci`（biome、ローカルバイナリ）が通る。
