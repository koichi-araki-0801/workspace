==============================================================================
 オフライン環境構築バンドル（Windows x64 専用）
==============================================================================

このアーカイブは、インターネット／npm レジストリに接続せずに本プロジェクトの
開発環境を別端末で構築するための一式です。

■ 同梱物
  - ソースコード一式（editor/ graph2/ graph-editor/ など）
  - pnpm-lock.yaml / 各 package.json / pnpm-workspace.yaml / .npmrc
  - .pnpm-store/      … 依存パッケージのオフラインストア（content-addressable）
  - pnpm.tgz          … pnpm 11 本体（corepack 用オフライン tarball）
  - ms-playwright/    … Playwright 用 Chromium（E2E テスト用、chromium 1223 系）
  - setup-offline.bat … セットアップスクリプト

■ 前提
  - Windows x64（このバンドルはこの端末と同一 OS/アーキ前提）
  - Node.js 24 以降がインストール済み（corepack が同梱されます）
    確認: コマンドプロンプトで  node -v
  - PDF 出力には Microsoft Edge を使用します（Windows 標準。追加不要）

■ 手順
  1) このアーカイブを任意のフォルダに展開する
       tar -xzf workspace-offline-bundle.tar.gz
     （分割ファイルの場合は先に結合：
        copy /b workspace-offline-bundle.tar.gz.part-* workspace-offline-bundle.tar.gz ）
  2) 展開された workspace フォルダ内の setup-offline.bat をダブルクリック
     （またはコマンドプロンプトで実行）
  3) 「[OK] セットアップ完了。」が表示されれば完了

■ 動作確認（任意）
       corepack pnpm typecheck
       corepack pnpm test
       corepack pnpm test:e2e
       corepack pnpm build

■ 補足
  - ネットワークは一切使用しません（依存・pnpm・ブラウザすべて同梱）。
  - corepack enable を一度実行しておくと、以後は corepack を付けずに
    pnpm コマンドだけで実行できます（管理者権限が必要な場合があります）。
  - 開発サーバ:  corepack pnpm dev
==============================================================================
