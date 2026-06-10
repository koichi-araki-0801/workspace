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

echo [1/4] 同梱の pnpm 11 を corepack に登録（オフライン）...
call corepack install -g "%~dp0pnpm.tgz"
if errorlevel 1 (
  echo [ERROR] corepack install に失敗しました。Node.js 24+ がインストールされているか確認してください。
  exit /b 1
)

echo [2/4] 依存を同梱ストアからオフライン復元...
call corepack pnpm install --offline --frozen-lockfile --store-dir "%~dp0.pnpm-store"
if errorlevel 1 (
  echo.
  echo [ERROR] オフライン install に失敗しました。
  exit /b 1
)

echo [3/4] ワークスペースをビルド（@editor/shared の dist 生成を含む）...
call corepack pnpm build
if errorlevel 1 (
  echo.
  echo [ERROR] build に失敗しました。
  exit /b 1
)

echo [4/4] Playwright ブラウザ（chromium）を既定キャッシュへ配置...
if exist "%~dp0ms-playwright" (
  rem %LOCALAPPDATA% はユーザー毎に解決されるため、ユーザー名が違っても Playwright が発見できる
  xcopy /E /I /Y /Q "%~dp0ms-playwright" "%LOCALAPPDATA%\ms-playwright" >nul
  echo       -^> %LOCALAPPDATA%\ms-playwright
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
