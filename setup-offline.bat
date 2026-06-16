@echo off
chcp 65001 >nul 2>&1
setlocal enabledelayedexpansion
cd /d "%~dp0"

rem ==========================================================================
rem  オフライン環境セットアップ（Windows x64 / 完全オフライン）
rem  前提: Node.js 24 以降がインストール済み（corepack 同梱）。ネット不要。
rem ==========================================================================

rem corepack のダウンロードプロンプトを抑止（同梱の pnpm を使うため）
set COREPACK_ENABLE_DOWNLOAD_PROMPT=0
rem node_modules purge 等の対話確認を抑止
set CI=true

rem 同梱物の存在チェック（重量物は git 管理外。GitHub Releases から取得して展開すること）
if not exist "%~dp0pnpm.tgz" (
  echo [ERROR] pnpm.tgz が見つかりません。重量物が未取得です。
  echo         先に  scripts\offline\fetch-offline-bundle.bat  を実行し、
  echo         GitHub Releases から重量物（.pnpm-store / pnpm.tgz / ms-playwright）を取得してください。
  exit /b 1
)
if not exist "%~dp0.pnpm-store" (
  echo [ERROR] .pnpm-store が見つかりません。重量物が未取得です。
  echo         先に  scripts\offline\fetch-offline-bundle.bat  を実行してください。
  exit /b 1
)

echo [1/5] 同梱の pnpm 11 を corepack に登録（オフライン）...
call corepack install -g "%~dp0pnpm.tgz"
if errorlevel 1 (
  echo [ERROR] corepack install に失敗しました。Node.js 24+ がインストールされているか確認してください。
  exit /b 1
)

echo [2/5] クリーン（node_modules とビルド成果物を全削除。重量物は温存）...
rem node_modules を全削除（ルート + 全ワークスペースパッケージ）。
rem  → 前回の壊れた symlink farm / 古いパッケージ / web の .vite キャッシュを一掃し、
rem    毎回ストアからクリーンインストールさせる。.pnpm-store / pnpm.tgz / ms-playwright は触れない。
for %%D in (
  "%~dp0node_modules"
  "%~dp0editor\shared\node_modules"
  "%~dp0editor\server\node_modules"
  "%~dp0editor\web\node_modules"
  "%~dp0graph2\node_modules"
  "%~dp0graph-editor\node_modules"
) do (
  if exist "%%~D" rmdir /s /q "%%~D"
)
rem ビルド成果物（pnpm build が生成する dist）を削除し、古い dist 由来の不整合を排除。
for %%D in (
  "%~dp0editor\shared\dist"
  "%~dp0editor\server\dist"
  "%~dp0editor\web\dist"
) do (
  if exist "%%~D" rmdir /s /q "%%~D"
)
if exist "%~dp0editor\web\tsconfig.tsbuildinfo" del /q "%~dp0editor\web\tsconfig.tsbuildinfo"

echo [3/5] 依存を同梱ストアからオフラインクリーンインストール...
call corepack pnpm install --offline --frozen-lockfile --store-dir "%~dp0.pnpm-store"
if errorlevel 1 (
  echo.
  echo [ERROR] オフライン install に失敗しました。
  exit /b 1
)

echo [4/5] ワークスペースをビルド（@editor/shared の dist 生成を含む）...
call corepack pnpm build
if errorlevel 1 (
  echo.
  echo [ERROR] build に失敗しました。
  exit /b 1
)

echo [5/5] Playwright ブラウザ（chromium）を既定キャッシュへ配置...
if exist "%~dp0ms-playwright" (
  rem %LOCALAPPDATA% はユーザー毎に解決されるため、ユーザー名が違っても Playwright が発見できる
  xcopy /E /I /Y /Q "%~dp0ms-playwright" "%LOCALAPPDATA%\ms-playwright" >nul
  if errorlevel 1 (
    echo [WARN] ms-playwright のコピーに失敗しました。E2E テスト時は手動で
    echo        "%~dp0ms-playwright" を "%LOCALAPPDATA%\ms-playwright" へコピーしてください。
  ) else (
    echo       -^> %LOCALAPPDATA%\ms-playwright
  )
) else (
  echo [WARN] ms-playwright が同梱されていません。E2E テスト（pnpm test:e2e）は
  echo        初回にネットワークでの Chromium ダウンロードが必要になります。
)

echo.
echo [OK] セットアップ完了。
echo   - 型チェック: corepack pnpm typecheck
echo   - テスト:     corepack pnpm test
echo   - E2E:        corepack pnpm test:e2e
echo   - 開発サーバ: corepack pnpm dev
echo   ( corepack enable を一度実行しておけば、以後は corepack を付けず pnpm だけで実行可能 )
echo.
echo   PDF 出力はシステムの Microsoft Edge を自動使用します（追加ブラウザ不要）。
endlocal
