==============================================================================
 オフライン環境構築（Windows x64 専用）
==============================================================================

別端末で、最終的にはインターネット／npm レジストリに接続せずに本プロジェクトの
開発環境を構築するための手順です。配布は 2 系統に分かれます。

  ※ git も GitHub CLI (gh) も使えない端末は README-offline-manual.txt を参照
    （リポジトリを一時 Public 化し HTTPS だけで取得する手動手順）。

  (A) コード          … git リポジトリ本体（変更の都度コミット・push で履歴管理）
  (B) 重量物          … GitHub Releases（約 1.2GB。容量が大きいため git に入れない）
                        .pnpm-store / pnpm.tgz / ms-playwright

■ 重量物の内訳（GitHub Releases: タグ offline-bundle-v1）
  - .pnpm-store/      … 依存パッケージのオフラインストア（content-addressable）
  - pnpm.tgz          … pnpm 11 本体（corepack 用オフライン tarball）
  - ms-playwright/    … Playwright 用 Chromium（E2E テスト用、chromium 1223 系）
  これらは offline-deps-bundle.tar.gz 1 ファイルに固めて Release に置かれます。
  内容（pnpm-lock.yaml / packageManager）に変更が無い限り再アップロードされません。

■ 前提
  - Windows x64（このバンドルはこの端末と同一 OS/アーキ前提）
  - Node.js 24 以降がインストール済み（corepack が同梱されます）
    確認: コマンドプロンプトで  node -v
  - 取得には GitHub CLI (gh) が認証済みであること（private repo のため）
      gh auth login
  - PDF 出力には Microsoft Edge を使用します（Windows 標準。追加不要）

■ 手順（別端末・GitHub 到達可）
  1) コードを取得
       git clone <このリポジトリ>
     （既にある場合は  git pull ）
  2) 重量物を取得・展開（Release からダウンロード → sha256 検証 → 展開）
       pwsh -File scripts\offline\fetch-offline-bundle.ps1
  3) セットアップ実行
       setup-offline.bat
     「[OK] セットアップ完了。」が表示されれば完了
     （fetch スクリプトに -RunSetup を付ければ 2) と 3) を一括実行）

■ 動作確認（任意）
       corepack pnpm typecheck
       corepack pnpm test
       corepack pnpm test:e2e
       corepack pnpm build

■ 重量物の公開（調達側・オンライン機）
  依存や pnpm/Playwright のバージョンを更新したら、調達側で次を実行すると
  Release の重量物が更新されます（変更が無ければ自動でスキップ）。
       pwsh -File scripts\offline\publish-offline-bundle.ps1

■ 補足
  - 重量物の取得後は、依存・pnpm・ブラウザすべて同梱されるため、install/build は
    ネットワーク不要で完走します（完全オフライン運用）。
  - corepack enable を一度実行しておくと、以後は corepack を付けずに
    pnpm コマンドだけで実行できます（管理者権限が必要な場合があります）。
  - 開発サーバ:  corepack pnpm dev
==============================================================================
