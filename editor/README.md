# Jinja2 テンプレ GUI 編集 Web アプリ

Jinja2 で作成された HTML/CSS テンプレート（ファンド報告書系）を、非エンジニアが GUI で
安全に編集し、サンプルデータ差込でプレビュー＆PDF 出力できる社内 Web アプリ。

- **編集**: GrapesJS（レイアウト/CSS 中心）。`{{ }}` / `{% %}` / `{# #}` は壊さず温存（mask/restore）。ページ境界（`.page`）をオーバーレイ表示。
- **プレビュー**: ブラウザ内 Nunjucks で生 Jinja2 + サンプルデータを描画 → vivliostyle でページ組み表示。
- **PDF**: サーバ側 `@vivliostyle/cli` で生成。
- **作成**: 既存 Python 生成器を Fastify から child_process で呼び出し。
- **比較**: 確定版どうし／現行版との差分を版ピッカーで比較。
- **認証**: 独自認証（ログイン + 初回パスワード初期化）。配信/サーバ再起動でローカルセッションを失効（`appEpoch`）。
- **テーマ**: ブルー系（Tailwind v4 + shadcn-vue）。

## 構成（pnpm workspaces モノレポ）

editor はリポジトリ直下の **pnpm モノレポ**の一部（`editor/shared` `editor/server` `editor/web`）。
ワークスペース定義とビルド許可（`allowBuilds`）はルート `pnpm-workspace.yaml`、スクリプトはルート `package.json`。
パッケージマネージャは `pnpm@11.8.0+`、Node は `>=24`（`editor/.nvmrc` = 24）。

```
editor/shared/   共有 TS 型/DTO + Result/AppError + ドメイン + 集約ごとの Repository 契約（型の真実源）
editor/web/      Vue3 + Vite + TS + Vue Router + Pinia + Tailwind v4 + shadcn-vue + GrapesJS + Nunjucks + vivliostyle
editor/server/   Fastify + TS（PDF 生成 / ファイル索引 / Python 生成器アダプタ / フェーズ2 REST・SQL）
editor/data/     テンプレ(.html) と ファンド毎 CSS（サーバが参照）
```

> **フェーズ 1**: フロント先行。データは `web/src/api/local`（fixtures + localStorage）の Repository 実装で抽象化。
> **フェーズ 2（実装済・未デプロイ）**: 同じ Repository インターフェースの REST 実装（`web/src/api/rest`）+ SQL Server（固定スキーマ・DDL 禁止）連携。
> データソースは `VITE_API_MODE`（`local`／`rest`）で切替。`web/src/api/repositories.ts` の 1 オブジェクトを差し替えるだけで画面/サービス/ストアは無改修。

## 起動

コマンドは**リポジトリルート**から `pnpm` で実行する（editor 単体の `package.json` は無い）。

```bash
pnpm install
pnpm dev         # shared をビルド後、Fastify(:3001) と Vite(:5173) を並行起動
```

Windows では `editor/start.bat` をダブルクリックでも起動できます（初回は `pnpm install` を自動実行）。
引数は順不同で、ビルドモード（`dev`／`prod`・既定 prod）とデータモード（`local`／`rest`・既定 local）を指定:

| コマンド | 内容 |
|---|---|
| `start.bat` | 本番（build → server 単体 :3001）/ ローカルデータ |
| `start.bat dev` | 開発（Fastify :3001 + Vite :5173）/ ローカルデータ |
| `start.bat rest` | 本番 / REST（SQL Server バックエンド・認証必須） |
| `start.bat dev rest` | 開発 / REST |

ブラウザで http://localhost:5173 → デモログイン `admin / admin`（または `editor / editor`）。

> 開発に参加する方は **[CONTRIBUTING.md](./CONTRIBUTING.md)** を最初に読んでください（セットアップ・コマンド・ディレクトリ地図・規約）。

### 個別コマンド（ルートから）

```bash
pnpm build       # tsc -b editor/server（shared→server）後に web をビルド
pnpm test        # ルート集約の vitest（projects で全 workspace を一括実行）
pnpm test:coverage  # カバレッジ付き（include 列挙＝テスト済みのみ・全指標 85% 閾値）
pnpm typecheck   # 全 workspace の型チェック（shared 先行ビルド込み）
pnpm knip        # 未使用 export / 依存の検出（knip.json）
pnpm ci          # CI 集約（check:comments → check:ci → typecheck → test:coverage → build → test:e2e）
```

## 主要モジュール

| 役割 | パス |
|---|---|
| Jinja2 タグ保護（核心） | `web/src/lib/jinjaMask.ts` |
| Nunjucks プレビュー描画 | `web/src/lib/nunjucksRender.ts` |
| GrapesJS 連携 | `web/src/features/editor/useGrapes.ts`, `jinjaComponents.ts` |
| データ抽象化（差し替え点） | `web/src/api/repositories.ts`, `web/src/api/local/*Repo.ts`, `web/src/api/rest/*` |
| ページ境界オーバーレイ | `web/src/features/editor/pageView.ts` |
| セッション失効（再起動検知） | `web/src/lib/appEpoch.ts`, `web/src/stores/auth.ts`, `web/src/router/index.ts`（`authGuard`） |
| PDF / preview（vivliostyle CLI） | `server/src/vivliostyle/*`（`build.ts` / `previewManager.ts`） |
| Python 生成器アダプタ | `server/src/generate/pyTemplate.ts`（`server/scripts/generate_template.py` を呼ぶ） |
| REST + DB ゲートウェイ sproc | `server/src/routes/*`, `server/src/db/*`, `server/db/{ddl,sproc,seed}` |

## 環境変数（server）

優先順は `default < appconfig.json < 環境変数`。全キーは `server/src/config.ts` に集約。主要なもの:

| 変数 | 既定 | 用途 |
|---|---|---|
| `PORT` | 3001 | API ポート |
| `DATA_ROOT` | `../../editor-data` | テンプレ git リポジトリのルート（下の `*_DIR` の基準） |
| `TEMPLATES_DIR` | `<DATA_ROOT>/templates` | テンプレ .html 置き場 |
| `CSS_DIR` | `<DATA_ROOT>/css` | ファンド毎 CSS 置き場 |
| `DRAFTS_DIR` | `<DATA_ROOT>/drafts` | オートセーブ下書きの作業コピー |
| `WEB_DIR` | `web/dist` | 本番配信する build 済み SPA |
| `PYTHON_BIN` | `python` | Python 実行体 |
| `PY_GENERATE_SCRIPT` | `server/scripts/generate_template.py` | 既存 Python 生成器 |
| `VIVLIOSTYLE_EXECUTABLE_BROWSER` | 自動検出 | PDF 用ブラウザ（Edge → playwright 既定） |

REST モード（`start.bat rest`）で効く認証/DB 系（既定はローカルモード相当の無効値）:

| 変数 | 既定 | 用途 |
|---|---|---|
| `AUTH_REQUIRED` | `false` | 認証強制（REST で `true`） |
| `AUDIT_DB` | `false` | 監査ログを DB にも書く |
| `AUTH_SESSION_TTL_HOURS` | 12 | セッション有効期限（時間） |
| `DB_SERVER` | `localhost` | SQL Server ホスト |
| `DB_NAME` | `usrap` | DB 名 |
| `DB_ODBC_DRIVER` | `ODBC Driver 17 for SQL Server` | ODBC ドライバ |

> DB 接続・DDL/sproc の詳細は **[server/db/README.md](./server/db/README.md)** を参照（Windows 統合認証・SQL Server 2012 互換）。

## 既知の制限

- `jinjaMask` の block 吸収は「単一要素を包む for/if（本体に `{% %}` を含まない）」が対象。
  if/else や入れ子はチップ表示にフォールバック（テーブル内の入れ子ループは要注意）。
- Nunjucks は Jinja2 の近似（プレビュー用途）。`items()`/`is` など一部構文は非互換。
- GrapesJS は編集領域の HTML を正規化する（空白/属性順）。Jinja タグ自体は保持。
- 再起動セッション失効（`appEpoch`）はローカルモード用。REST モードでは DB セッション失効が権威。
