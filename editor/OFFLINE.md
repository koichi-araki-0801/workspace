# オフライン（社内LANのみ）運用ガイド

本アプリは将来、インターネット非接続の社内 LAN 環境で**ビルドから運用まで**を行う。
本書はその調達・展開・検証手順をまとめた runbook である。

## 方針（前提）

- **PDF 生成はサーバ側**（運用機 1 台に集約）。
- **PDF 用ブラウザは社内 Windows の Microsoft Edge を使用**（Chromium を同梱しない）。
- **依存は node_modules を tgz で持ち込み**。
- **ビルドはオフライン機で実施**（持ち込んだ node_modules で `npm run build`）。
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
2. **npm 導入時のネイティブバイナリ取得**
   `npm install` は OS 別バイナリをネットから取る。→ オフライン機では `npm install` せず、
   調達機で `npm ci` 済みの node_modules を丸ごと持ち込む。

## 事前に運用機へインストールしておくもの

- **Node.js 24.x**（`.nvmrc` = 24、`engines: node>=24`）
- **Python**（`/api/generate` 用。現状の stub は標準ライブラリのみ）
- **Microsoft Edge**（Windows 11 標準。`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`）

## 手順

### 1. 調達（オンライン機・Windows x64・Node 24）

```powershell
pwsh -File scripts/offline/pack.ps1
```

- クリーン `npm ci`（dev 含む）→ 主要ネイティブバイナリの存在チェック →
  リポジトリ一式（node_modules 含む）を `dist-offline\editor-offline-<日時>.tgz` に固め、
  `.sha256` を生成する。
- 生成物（tgz と .sha256）を LAN 経由で運用機へ持ち込む。

### 2. 展開・ビルド・起動（オフライン運用機）

```powershell
pwsh -File scripts/offline/setup.ps1 -Bundle .\editor-offline-<日時>.tgz -Start
```

- SHA256 検証 → 展開 → Node/Python/Edge の存在確認 →
  `appconfig.json` 生成（`appconfig.example.json` から、検出 Edge パスを埋める。既存なら保持）→
  `npm run build`（**ネット不要**）→ `-Start` 指定時はそのままサーバ起動。
- 運用機は**単一 Node プロセス**で API と SPA（`web/dist`）を配信する。

手動起動する場合:

```powershell
cd <展開先>\editor
$env:NODE_ENV='production'; npm start -w server
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

1. **調達**: `pack.ps1` で tgz + `.sha256` が生成される。
2. **遮断**: 運用機をネット遮断し、`setup.ps1` の展開〜`npm run build` がネット無しで完走する
   （biome / esbuild / rollup / lightningcss / vue-tsc の取得が走らない）。
3. **起動**: `GET /api/health` → `{ok:true}`、ブラウザで SPA が表示される。
4. **PDF（最重要）**: `POST /api/pdf` で PDF 生成成功。ログに
   `Downloading now...`（`downloadBrowser`）が**出ない**こと、MathJax 失敗で生成がストール
   /失敗しないこと。
5. **生成/保存**: `POST /api/generate`・`PUT /api/templates/:id` が成功。
6. **エディタ UI**: GrapesJS のアイコン/スタイルに欠けが無いか目視。
7. **回帰**: `npm run typecheck` と `npm run check:ci`（biome、ローカルバイナリ）が通る。
