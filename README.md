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
| `editor/scripts/setup-lan-https.bat` | LAN 公開用の自己署名 TLS 証明書（PFX/cer）を生成 |
| `editor/scripts/setup-lan-firewall.bat` | LAN 公開ポート（TCP 24680）の受信許可ルールを登録（要管理者） |
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
| `pnpm run clean` | ルート直下の再生成物を掃除（既定はドライラン。実削除は `-- --yes`。`scripts/clean.mjs`） |
| `pnpm run clean:deep` / `clean:bundles` | `node_modules` 等 / 大容量バンドルも対象に含める |
| `pnpm run ci` | CI 集約（全領域＋coverage 85% 閾値ゲート） |
| `pnpm run ci:affected` | 変更領域だけ CI を実行（`scripts/ci-affected.mjs`。**pre-push で実行**） |
| `pnpm run ci:editor` / `ci:pie-chart` / `ci:graph-editor` | 領域別 CI を手動実行 |

その他のコマンドは各 `package.json` の `scripts` を参照。

### CI の分割と coverage ゲート

CI は領域（`editor` = shared+server+web / `pie-chart` / `graph-editor`）単位で分割できる。
`pnpm run ci:<領域>` で手動部分実行、`pnpm run ci:affected` は `git diff`（既定で現ブランチ upstream 基準。
`--base <ref>` / `--all` / `--dry-run`(計画のみ表示) / 環境変数 `CI_AFFECTED_BASE` で上書き可）から
変更領域を判定して該当領域だけ走らせる。
`.husky/pre-push` はこの affected 方式で push を高速化する（振り分けは `scripts/pre-push.mjs`）。領域に
紐付かない共有変更（`package.json` / lockfile / 各種 config）を検出した場合はフル `ci` にフォールバックする。
**タグのみの push（ローリングタグ `offline-bundle-v1` の移動など）は CI をスキップする**（タグは CI 済み
コミットへのポインタであり、リリース更新でフル CI を発火させてタグ push を巻き込み失敗させないため）。

> **注意:** 領域別 / affected run は速度優先で **coverage 85% 閾値ゲートを通さない**
> （vitest の coverage はラン全体で 1 つしか持てず、領域だけ走らせると他領域が 0% 扱いで落ちるため）。
> 85% ゲートはフル `pnpm run ci` と GitHub Actions（`test:coverage`）が担保する。pre-push 後の GHA で必ず掛かる。
