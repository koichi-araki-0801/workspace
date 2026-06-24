# workspace

editor / pie-chart / pdf-to-svg / graph-editor などを束ねる pnpm モノレポ。
各プロジェクトの詳細はそれぞれの `README.md` を参照。共通ルールは [`CLAUDE.md`](CLAUDE.md) と
[`docs/コメント規約.md`](docs/コメント規約.md) が正典。

## スクリプトの置き場ルール

> **入口（利用者がダブルクリック/コマンドで直接実行する）はプロジェクト直下に最小限置く。**
> **裏方（ビルド・セットアップ・コード生成）は各 `<project>/scripts/` に集約する。**

- `.ps1` には必ず同名 `.bat` ランチャを **同じフォルダに併設**する（実行ポリシー Bypass で起動）。
  CI (`pnpm run check:comments`) が併設と UTF-8 BOM を検査する。
- dot-source 専用ライブラリ（`offline/lib/content-key.ps1`、`scripts/lib/build-python-venv.ps1`）は
  単体起動しないため `.bat` 併設の例外。
- 詳しい `.ps1`/`.bat` 規約は [`CLAUDE.md`](CLAUDE.md) の「PowerShell スクリプト」節を参照。

## 入口スクリプト一覧

よく使う入口（各プロジェクト直下）:

| スクリプト | 役割 | 使い方 |
|---|---|---|
| `editor/start.bat` | editor アプリ起動（dev / prod / rest モード） | `editor\start.bat` または引数でモード指定 |
| `pdf-to-svg/run.bat` | PdfToSvg をソースから起動 | `pdf-to-svg\run.bat` |
| `offline/setup-offline.bat` | オンライン機でソース+重量物を取得し構築 | `offline\setup-offline.bat` |
| `offline/setup-offline-local.bat` | 完全オフライン環境で構築（取得済み前提） | `offline\setup-offline-local.bat` |

裏方（各 `<project>/scripts/` ほか。ビルド・初期化・運用）:

| スクリプト | 役割 |
|---|---|
| `pie-chart/scripts/build-exe.bat` | pie-chart CLI を単一 exe（Node SEA）へビルド |
| `pie-chart/scripts/sign-exe.bat` | 生成 exe を自己署名 |
| `pdf-to-svg/scripts/build.bat` | PdfToSvg の配布 exe をビルド（隔離 venv） |
| `graph-editor/scripts/build.bat` | LabelEditor の配布 exe をビルド（隔離 venv） |
| `editor/scripts/init-data-repo.bat` | テンプレ版管理用 data リポジトリを初期化 |
| `editor/server/db/apply.bat` | SQL Server へ DDL/sproc/seed を適用 |
| `offline/publish-offline-bundle.bat` | オフラインバンドルを GitHub Releases へ公開（post-commit で自動実行） |
| `docs/_build/build_all.bat` | `docs/<project>/src/` の原稿から .docx/.xlsx を一括生成 |

Python ビルドの venv 準備は共有ライブラリ `scripts/lib/build-python-venv.ps1` に集約してあり、
`pdf-to-svg` / `graph-editor` の `scripts/build.ps1` が dot-source して使う。

## 主な pnpm コマンド（リポジトリ直下）

| コマンド | 役割 |
|---|---|
| `pnpm run dev` | editor を開発モードで起動 |
| `pnpm run build` | 全パッケージをビルド |
| `pnpm run test` | 単体テスト一式 |
| `pnpm run check:comments` | コメント規約・スクリプト配置の機械検査 |
| `pnpm run knip` | 未使用 export / 依存の検出（`knip.json`） |
| `pnpm run ci` | CI 集約（pre-push でも実行） |

その他のコマンドは各 `package.json` の `scripts` を参照。
