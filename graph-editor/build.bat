@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title LabelEditor ビルド

rem =============================================================================
rem  SVG ラベル位置エディタ - Windows exe ビルド（ワンクリック）
rem  出力: graph-editor\dist\LabelEditor.exe（単一ファイル / 実行に Python 不要）
rem  設計: ブラウザエンジンは同梱しない。exe は小さなローカル HTTP サーバを起動し、
rem        OS の Edge をアプリモードで開く。ファイル入出力はブラウザの
rem        File System Access API を使う。WebView2 ランタイムを同梱しないため小さい(~10MB)。
rem
rem  ビルドは専用の隔離 venv（.venv-build）内で行う。素の `python -m venv` は端末の
rem  グローバル site-packages を参照しないため、余計なライブラリが exe に混入しない。
rem  LabelEditor 自体は実行時依存ゼロ（標準ライブラリのみ）なので配布物は最小のまま。
rem    build.bat clean … venv を作り直す
rem  日本語メッセージは chcp 65001（UTF-8）前提で表示する。
rem =============================================================================

rem ── Python ランチャ選択（py -3 優先 → python、双方無ければ中断）──
set "PY=py -3"
%PY% --version >nul 2>&1 || set "PY=python"
%PY% --version >nul 2>&1 || (
    echo [エラー] Python が見つかりません。Python を導入し PATH を通して再実行してください。
    pause
    exit /b 1
)

rem ── 隔離ビルド venv（.venv-build）。clean 引数で作り直す ──
set "VENV=%~dp0.venv-build"
set "VPY=%VENV%\Scripts\python.exe"
if /i "%~1"=="clean" if exist "%VENV%" (
    echo [setup] ビルド venv を作り直します ^(clean^)...
    rmdir /s /q "%VENV%"
)

rem 既存 venv の健全性チェック。python.exe が無い/実際に起動しない場合は壊れているとみなす。
rem （存在チェックだけだと不完全/破損 venv の上に `python -m venv` を実行して失敗するため）
set "VENV_OK="
if exist "%VPY%" (
    "%VPY%" --version >nul 2>&1 && set "VENV_OK=1"
)
if not defined VENV_OK (
    if exist "%VENV%" (
        echo [setup] 既存ビルド venv が不完全なため作り直します...
        rmdir /s /q "%VENV%"
    )
    echo [setup] 隔離ビルド venv ^(.venv-build^) を作成中...
    %PY% -m venv "%VENV%"
    if errorlevel 1 (
        echo.
        echo [エラー] ビルド venv の作成に失敗しました。
        pause
        exit /b 1
    )
)

rem ── 依存インストール（オフライン優先：同梱 wheelhouse から毎回 install）──
rem wheelhouse があればネット不要でそこから入れる。無ければ通常 pip install へフォールバック。
set "WHEELHOUSE=%~dp0..\python-wheelhouse"
echo ============================================
echo  [1/2] 依存ライブラリをインストール ^(隔離 venv 内^)
echo ============================================
if exist "%WHEELHOUSE%" (
    echo [setup] オフライン wheelhouse から install: %WHEELHOUSE%
    "%VPY%" -m pip install --no-index --find-links "%WHEELHOUSE%" -r "%~dp0requirements.txt"
) else (
    echo [setup] wheelhouse 無し。オンラインで install します...
    "%VPY%" -m pip install -r "%~dp0requirements.txt"
)
if errorlevel 1 (
    echo.
    echo [エラー] 依存のインストールに失敗しました。
    pause
    exit /b 1
)

echo.
echo ============================================
echo  [2/2] exe をビルド (PyInstaller, 単一ファイル)
echo ============================================
"%VPY%" -m PyInstaller --noconfirm --clean --onefile --windowed --name LabelEditor ^
  --add-data "ui.html;." ^
  --add-data "styles.css;." ^
  --add-data "js;js" ^
  --add-data "lib/leader_geom.cjs;lib" ^
  app.py
if errorlevel 1 (
    echo.
    echo [エラー] ビルドに失敗しました。
    echo   - LabelEditor.exe 実行中なら閉じて再実行してください（上書き不可）。
    echo   - それ以外は上の PyInstaller のエラーログを確認してください。
    pause
    exit /b 1
)

echo.
echo 完成: %~dp0dist\LabelEditor.exe （単一ファイル, ~10MB）
echo   配布: このファイルを渡すだけ。受け取り側はダブルクリックで Microsoft Edge の
echo         アプリウィンドウが開きます（Windows 10/11 標準の Edge を使用, 追加導入不要）。
pause
