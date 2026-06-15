# Jinja2 テンプレ GUI 編集 Web アプリ

Jinja2 で作成された HTML/CSS テンプレート（ファンド報告書系）を、非エンジニアが GUI で
安全に編集し、サンプルデータ差込でプレビュー＆PDF 出力できる社内 Web アプリ。

- **編集**: GrapesJS（レイアウト/CSS 中心）。`{{ }}` / `{% %}` / `{# #}` は壊さず温存（mask/restore）。
- **プレビュー**: ブラウザ内 Nunjucks で生 Jinja2 + サンプルデータを描画 → vivliostyle でページ組み表示。
- **PDF**: サーバ側 `@vivliostyle/cli` で生成。
- **作成**: 既存 Python 生成器を Express から child_process で呼び出し。
- **認証**: 独自認証（ログイン + 初回パスワード初期化）。
- **テーマ**: ブルー系（Tailwind v4 + shadcn-vue）。

## 構成（npm workspaces モノレポ）

```
shared/   共有 TS 型/DTO + Result/AppError + ドメイン + 集約ごとの Repository 契約
web/      Vue3 + Vite + TS + Vue Router + Pinia + Tailwind v4 + shadcn-vue + GrapesJS + Nunjucks + vivliostyle
server/   Express + TS（PDF 生成 / ファイル索引 / Python 生成器アダプタ）
data/     テンプレ(.html) と ファンド毎 CSS（サーバが参照）
```

> **フェーズ 1（現状）**: フロント先行。データは `web/src/api/local`（fixtures + localStorage）の Repository 実装で抽象化。
> **フェーズ 2（予定）**: 同じ Repository インターフェースの REST 実装に差し替え、SQL Server（固定スキーマ・DDL 禁止）連携。
> `web/src/api/repositories.ts` の 1 オブジェクトを差し替えれば画面/サービス/ストアは無改修。

## 起動

```bash
npm install
npm run dev      # shared をビルド後、Express(:3001) と Vite(:5173) を並行起動
```

Windows では `start.bat` をダブルクリックでも起動できます（初回は `npm install` を自動実行）。
本番モード（build → server 単体 :3001）は `start.bat prod`。

ブラウザで http://localhost:5173 → デモログイン `admin / admin`（または `editor / editor`）。

> 開発に参加する方は **[CONTRIBUTING.md](./CONTRIBUTING.md)** を最初に読んでください（セットアップ・コマンド・ディレクトリ地図・規約）。

### 個別コマンド

```bash
npm run build       # shared → server → web を順にビルド
npm test            # web の vitest（jinjaMask 往復テスト 等）
npm run typecheck   # 全 workspace の型チェック
```

## 主要モジュール

| 役割 | パス |
|---|---|
| Jinja2 タグ保護（核心） | `web/src/lib/jinjaMask.ts` |
| Nunjucks プレビュー描画 | `web/src/lib/nunjucksRender.ts` |
| GrapesJS 連携 | `web/src/features/editor/useGrapes.ts`, `jinjaComponents.ts` |
| データ抽象化（差し替え点） | `web/src/api/repositories.ts`, `web/src/api/local/*Repo.ts` |
| PDF / preview（vivliostyle CLI） | `server/src/vivliostyle/*`（`build.ts` / `previewManager.ts`） |
| Python 生成器アダプタ | `server/src/generate/pyTemplate.ts`（`server/scripts/generate_template.py` を呼ぶ） |

## 環境変数（server）

| 変数 | 既定 | 用途 |
|---|---|---|
| `PORT` | 3001 | API ポート |
| `TEMPLATES_DIR` | `data/templates` | テンプレ .html 置き場 |
| `CSS_DIR` | `data/css` | ファンド毎 CSS 置き場 |
| `PYTHON_BIN` | `python` | Python 実行体 |
| `PY_GENERATE_SCRIPT` | `server/scripts/generate_template.py` | 既存 Python 生成器（要差し替え） |

## フェーズ 2 で確認が必要な外部依存

1. 固定 SQL Server の実テーブル/カラム定義（テンプレ台帳・監査ログ・サンプルデータ・ユーザー）。
2. 既存ユーザーテーブルのパスワード保管方式（独自認証の照合）。

## 既知の制限（フェーズ 1）

- `jinjaMask` の block 吸収は「単一要素を包む for/if（本体に `{% %}` を含まない）」が対象。
  if/else や入れ子はチップ表示にフォールバック（テーブル内の入れ子ループは要注意）。
- Nunjucks は Jinja2 の近似（プレビュー用途）。`items()`/`is` など一部構文は非互換。
- GrapesJS は編集領域の HTML を正規化する（空白/属性順）。Jinja タグ自体は保持。
