==============================================================================
 オフライン環境構築（無git・無gh 手動手順 / 一時パブリック公開方式）
 対象: Windows x64
==============================================================================

git も GitHub CLI (gh) も無い／GitHub 認証を通せない端末向けの手動手順です。
リポジトリを「取得中だけ一時的に Public 公開」し、ブラウザ／PowerShell の HTTPS
取得だけで環境を構築します（認証不要）。

  ※ git/gh が使える通常端末は README-offline-bundle.txt の手順を使ってください。

配布は 2 系統に分かれます（通常手順と同じ）。
  (A) コード   … GitHub のタグ ZIP（codeload）を HTTPS で取得
  (B) 重量物   … GitHub Releases のアセットを HTTPS で直取得（約 1.2GB）
                 .pnpm-store / pnpm.tgz / ms-playwright

------------------------------------------------------------------------------
■ 前提
------------------------------------------------------------------------------
  - Windows x64（このバンドルはこの端末と同一 OS/アーキ前提）
  - Node.js 24 以降がインストール済み（corepack 同梱）。確認: node -v
  - tar / curl.exe（Windows 10/11 標準。追加インストール不要）
  - PDF 出力には Microsoft Edge を使用（Windows 標準。追加不要）
  - 取得の間だけリポジトリを Public 公開できること

------------------------------------------------------------------------------
■ 手順
------------------------------------------------------------------------------

0) 【オンライン側・公開元】リポジトリを一時 Public 化
   GitHub → リポジトリ → Settings → 最下部 Danger Zone →
   "Change repository visibility" → Public に変更。
   ★ 手順 3) まで完了したら、必ず Private へ戻すこと（後述の手順 4）。

1) 【取得端末】コードを取得（無git）
   ブラウザで以下を開いて ZIP をダウンロード（または下の curl を実行）:
     https://github.com/koichi-araki-0801/workspace/archive/refs/tags/offline-bundle-v1.zip

   PowerShell から取得する場合:
     curl.exe -L -o workspace.zip "https://github.com/koichi-araki-0801/workspace/archive/refs/tags/offline-bundle-v1.zip"
     Expand-Archive .\workspace.zip -DestinationPath .

   展開すると、タグ名を含むフォルダが作られます:
     workspace-offline-bundle-v1
   以降の作業はこのフォルダ内で行います:
     cd .\workspace-offline-bundle-v1

   ※ タグ offline-bundle-v1 の ZIP は、公開のたびに重量物バンドルと同じコミットへ
     更新されるため、ZIP のコードと Release のバンドル（pnpm-lock.yaml）は常に一致します。
     ブランチを選ぶ必要はありません。

2) 【取得端末】重量物を取得・展開（推奨＝スクリプト / gh 不要）
   展開フォルダ内で:
     pwsh -File scripts\offline\fetch-offline-bundle-http.ps1
   （PowerShell 7 が無ければ powershell.exe でも可）:
     powershell -ExecutionPolicy Bypass -File scripts\offline\fetch-offline-bundle-http.ps1

   これで Release から offline-deps-bundle.tar.gz / .sha256 / bundle.key を
   HTTPS 直取得 → sha256 検証 → lockfile 整合チェック → リポジトリ直下へ
   展開（.pnpm-store / pnpm.tgz / ms-playwright）まで自動実行します。
   -RunSetup を付ければ手順 3) も続けて自動実行します。

2') 【取得端末】重量物を取得・展開（スクリプトを使わない完全手動）
   展開フォルダ直下で、以下を順に実行してください:

     # ダウンロード（Release アセット直 URL）
     $base = "https://github.com/koichi-araki-0801/workspace/releases/download/offline-bundle-v1"
     curl.exe -L --fail -o offline-deps-bundle.tar.gz        "$base/offline-deps-bundle.tar.gz"
     curl.exe -L --fail -o offline-deps-bundle.tar.gz.sha256 "$base/offline-deps-bundle.tar.gz.sha256"

     # sha256 検証（一致しなければ再取得）
     $expected = ((Get-Content .\offline-deps-bundle.tar.gz.sha256 -Raw).Trim() -split '\s+')[0].ToLower()
     $actual   = (Get-FileHash .\offline-deps-bundle.tar.gz -Algorithm SHA256).Hash.ToLower()
     if ($expected -ne $actual) { Write-Error "sha256 不一致: 破損の可能性"; } else { "sha256 OK" }

     # リポジトリ直下へ展開
     tar -xzf offline-deps-bundle.tar.gz

   実行後、.pnpm-store / pnpm.tgz / ms-playwright が展開されていれば成功です。

3) 【取得端末】セットアップ（完全オフライン。ネット不要）
     setup-offline.bat
   「[OK] セットアップ完了。」が表示されれば完了です。
   （依存のオフライン復元 → ビルド → Playwright Chromium 配置まで自動）

4) 【オンライン側・公開元】リポジトリを Private へ戻す
   手順 0) と同じ Danger Zone から Private に戻してください。

------------------------------------------------------------------------------
■ 動作確認（任意）
------------------------------------------------------------------------------
     corepack pnpm typecheck
     corepack pnpm test
     corepack pnpm test:e2e
     corepack pnpm build
   開発サーバ:  corepack pnpm dev

------------------------------------------------------------------------------
■ トラブルシュート
------------------------------------------------------------------------------
  - 手順 2) で「lockfile 不整合の可能性」と警告 / 手順 3) の install が
    --frozen-lockfile で失敗する
      → コードの ZIP がバンドルと別コミットです。手順 1) のタグ ZIP
        （offline-bundle-v1）を取得し直してください（タグは常にバンドルと一致）。
  - ダウンロードが 404 / 認証を要求される
      → リポジトリが Public になっていません。手順 0) を確認してください。
  - corepack が見つからない / pnpm 登録に失敗する
      → Node.js 24+ をインストールしてください（corepack 同梱）。
==============================================================================
