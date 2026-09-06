# workspace

editor / pie-chart などを束ねる pnpm モノレポ（pdf-to-svg / graph-editor は 2026-08 に
Node 非依存の python-tools リポジトリへ分離済み）。
各プロジェクトの詳細はそれぞれの `README.md` を参照。コメントの書き方は
[`docs/コメント規約.md`](docs/コメント規約.md)、各プロジェクトの構成・不変則は
`docs/<project>/src/設計正典.md` が正典。

## 新しく参加した人へ（最初に読む）

1. **読む順序**: この README → 担当プロジェクトの `README.md`（各 README に
   「触りやすさマップ」がある。🟢 から着手する）→ [`docs/コメント規約.md`](docs/コメント規約.md)
   → `docs/<project>/src/設計正典.md`（構成・不変則・却下済み設計）。
   editor を触るなら `editor/CONTRIBUTING.md` がハブ。
2. **最初に覚える 3 コマンド**:
   - セットアップ: `offline\setup-offline-local.bat`（完全オフライン環境）または `pnpm install`
   - 検証: `pnpm run ci:<領域>`（editor / pie-chart。PR 前はフル `pnpm run ci`）
   - 起動: 各プロジェクト直下の入口 .bat（下記「入口スクリプト一覧」）
3. **リポジトリ直下の見分け方**: `offline-deps-bundle.tar.gz`・`pnpm.tgz`・`python-wheelhouse/`・
   `ms-playwright/` などはオフライン配布用の**生成物・配布物**であり、手で編集する本体コードではない。
4. **ハマったら**: [`docs/トラブルシュート.md`](docs/トラブルシュート.md)（症状 → 原因 → 対処の一覧）。

## スクリプトの置き場ルール

> **入口（利用者がダブルクリック/コマンドで直接実行する）はプロジェクト直下に最小限置く。**
> **裏方（ビルド・セットアップ・コード生成）は各 `<project>/scripts/` に集約する。**

- `.ps1` には必ず同名 `.bat` ランチャを **同じフォルダに併設**する（実行ポリシー Bypass で起動）。
  CI (`pnpm run check:comments`) が併設と UTF-8 BOM を検査する。
- dot-source 専用ライブラリ（`offline/lib/content-key.ps1`、`scripts/lib/build-python-venv.ps1`）は
  単体起動しないため `.bat` 併設の例外。
- 詳しい `.ps1`/`.bat` 規約は [`docs/コメント規約.md`](docs/コメント規約.md) の
  言語別付録 C（PowerShell）/ D（.bat ランチャ）を参照。

## 入口スクリプト一覧

よく使う入口（各プロジェクト直下）:

| スクリプト | 役割 | 使い方 |
|---|---|---|
| `editor/start.bat` | editor アプリ起動（dev / prod / rest モード） | `editor\start.bat` または引数でモード指定 |
| `offline/setup-offline.bat` | オンライン機でソース+重量物を取得し構築 | `offline\setup-offline.bat` |
| `offline/setup-offline-local.bat` | 完全オフライン環境で構築（取得済み前提） | `offline\setup-offline-local.bat` |

裏方（各 `<project>/scripts/` ほか。ビルド・初期化・運用）:

| スクリプト | 役割 |
|---|---|
| `pie-chart/scripts/build-exe.bat` | pie-chart CLI を単一 exe（Node SEA）へビルド |
| `pie-chart/scripts/sign-exe.bat` | 生成 exe を自己署名 |
| `editor/scripts/init-data-repo.bat` | テンプレ版管理用 data リポジトリを初期化 |
| `editor/scripts/setup-lan-https.bat` | LAN 公開用の自己署名 TLS 証明書（PFX/cer）を生成 |
| `editor/scripts/setup-lan-firewall.bat` | LAN 公開ポート（TCP 24680）の受信許可ルールを登録（要管理者） |
| `editor/server/db/apply.bat` | SQL Server へ DDL/sproc/seed を適用 |
| `offline/publish-offline-bundle.bat` | オフラインバンドルを GitHub Releases へ公開（post-commit で自動実行。`git config offline.publish true` を設定した公開担当者の clone のみ） |
| `docs/_build/build_all.bat` | `docs/<project>/src/` の原稿から閲覧用 HTML（手引き/設計の 2 冊）を一括生成 |

`docs/<project>/src/` に置いた Markdown 原稿は、**既定で**手引き/設計いずれかの冊子に掲載されます
（除外はファイル名に「設計正典」を含むものだけ）。社内限定で冊子に載せたくない下書き・メモは
`src/` 以外の場所に置いてください。

## フォント資産の対応

BIZ UDPGothic は pie-chart が埋込サイズ優先の WOFF2 形式
（`pie-chart/fonts/BIZUDPGothic-{Regular,Bold}.woff2`。SVG への base64 埋込用）で同梱する。
分離先 python-tools リポジトリの pdf-to-svg は同一書体を TTF 原本で持つ
（WOFF2 サブセット埋込の変換元に TTF が必須のため）。
**書体を差し替えるときは両リポジトリを同じ版で更新**すること。

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
| `pnpm run ci` | CI 集約（全領域＋coverage 85% 閾値ゲート＋pie-chart の SVG byte 比較。clone 直後は下記「フル `ci` の前提」を先に） |
| `pnpm run ci:affected` | 変更領域だけ CI を実行（`scripts/ci-affected.mjs`。**pre-push で実行**） |
| `pnpm run ci:editor` / `ci:pie-chart` | 領域別 CI を手動実行 |

その他のコマンドは各 `package.json` の `scripts` を参照。

### CI の分割と coverage ゲート

CI は領域（`editor` = shared+server+web / `pie-chart`）単位で分割できる。
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

#### フル `ci` の前提（clone 直後に 1 回）

`pnpm run ci` は `pie-chart:batch` → `pie-chart:batch:diff` を含み、`pie-chart/out/_baseline`
（ローカル生成物・git 管理外）と SVG を byte 比較する。clone 直後はこの基準が無く、
`batch:diff` は「基準が無い」ことを差分として扱い**必ず落ちる**（無ければ空として通す設計にすると、
基準の作り忘れが以後の退行を検出できない状態と区別できなくなる）。最初のフル `ci` の前に、
**コミット済みのクリーンな作業ツリー**で基準を 1 回作る:

```
pnpm run pie-chart:batch
pnpm --filter pie-chart run baseline:accept
```

以後、出力変更を意図した確定時だけ同じ 2 コマンドで基準を更新する。詳細と注意（未検証の変更を
基準に凍結しない）は `pie-chart/README.md` の「検証」節が正典。GitHub Actions では `out/_baseline`
を持てないため、この 2 段は GH の job に含めない（`scripts/ci-affected.test.mjs` の免除リスト）。
`pnpm run ci:affected`（pre-push）は pie-chart 領域に触れたときだけこの 2 段を走らせる。
