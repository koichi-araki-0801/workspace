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
パッケージマネージャは `pnpm@11.18.0+`、Node は `>=24`（`editor/.nvmrc` = 24）。

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
pnpm dev         # shared をビルド後、Fastify(:24680) と Vite(:24681) を並行起動
```

Windows では `editor/start.bat` をダブルクリックでも起動できます（初回は `pnpm install` を自動実行）。
引数は順不同で、ビルドモード（`dev`／`prod`・既定 prod）とデータモード（`local`／`rest`・既定 local）を指定:

| コマンド | 内容 |
|---|---|
| `start.bat` | 本番（build → server 単体 :24680）/ ローカルデータ |
| `start.bat dev` | 開発（Fastify :24680 + Vite :24681）/ ローカルデータ |
| `start.bat rest` | 本番 / REST（SQL Server バックエンド・認証必須） |
| `start.bat dev rest` | 開発 / REST |
| `start.bat rest lan` | 本番 / REST + **社内 LAN 公開**（下記「LAN 公開」節） |

ブラウザで http://localhost:24681 → デモログイン `admin / admin`（または `editor / editor`）。

> 開発に参加する方は **[CONTRIBUTING.md](./CONTRIBUTING.md)** を最初に読んでください（セットアップ・コマンド・ディレクトリ地図・規約）。

### 個別コマンド（ルートから）

```bash
pnpm build       # tsc -b editor/server（shared→server）後に web をビルド
pnpm test        # ルート集約の vitest（projects で全 workspace を一括実行。web は web-dom / web-node の 2 project）
pnpm test:coverage  # カバレッジ付き（include 列挙＝テスト済みのみ・全指標 85% 閾値）
pnpm typecheck   # 全 workspace の型チェック（shared 先行ビルド込み）
pnpm knip        # 未使用 export / 依存の検出（knip.json）
pnpm ci          # CI 集約（下記の全段）
```

`pnpm ci` の内訳は `check:comments → check:claude-hooks → check:ci → test:scripts →
typecheck → test:coverage → build → test:e2e`（pdf-to-svg / graph-editor の pytest 段は
2026-08 の python-tools リポジトリへの分離に伴い除去済み）。

カバレッジ include は「テスト済みのファイルだけを列挙する」方針で、正典は
ルート `vitest.config.ts`。**セキュリティ上の関門（許可リスト・認可テーブル・
egress 遮断・不変性チェック）は、テストの有無に関わらず include へ入れる** —
閾値の外に置くと退行を検出できないため。

web のテストは vitest の project が 2 つある。`test/**/*.dom.test.ts` は **`web-dom`（jsdom）**、
それ以外の `test/**/*.test.ts` は **`web-node`（node）** で走る。jsdom の起動はファイルごとに
約 1.5 秒かかるため、`document` / `window` / `localStorage` に触れるテストだけを `.dom.test.ts` に
する（node 側で `... is not defined` の ReferenceError が出たら改名して移す）。両方を選ぶときは
`vitest run --project "web-*"`。`pnpm --filter web test <name>` は `web/vitest.config.ts`（薄い
root）経由で両 project を束ねる。設定の実体は `web/vitest.dom.config.ts` / `web/vitest.node.config.ts`。

e2e（Playwright）は project が 2 つある。`chromium` は挙動を検証する spec 全部で、`pnpm test:e2e`
（`ci`・GitHub Actions）が走らせる。`docs` は `e2e/capture_docs.spec.ts` だけで、操作手引きの
`docs/editor/images/*.png` を撮り直す。撮影は git 管理下の成果物を書き換えるため `ci` には入れず、
`pnpm e2e:editor`（`ci:affected` の editor 領域 = editor に触れた push）だけが
`--project chromium --project docs` で走らせる。撮り直した画像の差分は「再撮影」としてコミットし、
`py -3.13 docs/_build/build_all.py --project editor` で HTML を作り直す。撮影だけ手で走らせるときは
`cd editor && pnpm exec playwright test --project docs`。

## LAN 公開（社内ネットワークの他端末から使う）

既定ではサーバは `127.0.0.1` にのみバインドされ、起動した PC 以外からはアクセスできない。
社内 LAN の他端末へ公開するには **本番モード + `lan` 引数**で起動する（dev モードは対象外）。

セットアップ（サーバにする PC で各 1 回）:

1. `editor\scripts\setup-lan-https.bat` — HTTPS 用の自己署名証明書を生成
   （`server\tls\editor.pfx` ほか。SAN にホスト名と LAN IP を含む・有効期限 5 年）。
2. `editor\scripts\setup-lan-firewall.bat` — **管理者で実行**。TCP 24680 の受信許可ルールを
   登録（Domain/Private プロファイルのみ。`-Remove` で削除）。

起動とアクセス:

```
editor\start.bat rest lan     # 本番 + REST + LAN 公開（HTTPS）
```

他端末のブラウザから `https://<サーバPCのIP>:24680/` を開く（起動バナーに URL が表示される）。
証明書の警告を消すには、同フォルダの `editor-lan.cer` を各端末の
「信頼されたルート証明機関」へ取り込む（管理者コマンド例: `certutil -addstore Root editor-lan.cer`）。

注意:

- 証明書未生成のまま `lan` で起動すると **平文 HTTP にフォールバック**し、`COOKIE_SECURE=false`
  を自動設定してログインを通す（社内 LAN 限定の暫定運用。HTTPS 推奨）。
- `start.bat lan`（local データ）でも公開はできるが、**local モードは認証なし**のため
  LAN 上の誰でも編集できる点に注意。
- 社内 CA 発行の証明書を使う場合は PFX を `server\tls\editor.pfx` に置く
  （パスフレーズは `editor.pfx.pass` か env `HTTPS_PFX_PASSPHRASE`）。

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
| `PORT` | 24680 | API ポート |
| `HOST` | `127.0.0.1` | listen ホスト（LAN 公開時は `0.0.0.0`。`start.bat lan` が設定） |
| `HTTPS` | `false` | HTTPS 待受の明示 opt-in（`start.bat lan` が pfx 存在時に設定） |
| `HTTPS_PFX` | `server/tls/editor.pfx` | HTTPS 用 PFX のパス |
| `HTTPS_PFX_PASSPHRASE` | （pfx 隣の `.pass`） | PFX のパスフレーズ |
| `COOKIE_SECURE` | 本番=true | セッション cookie の Secure 属性（HTTP フォールバック時のみ false） |
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
