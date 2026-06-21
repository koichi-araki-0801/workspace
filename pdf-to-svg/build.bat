@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title PdfToSvg ビルド

rem ── Python ランチャ選択（py -3 優先 → python、双方無ければ中断）──
set "PY=py -3"
%PY% --version >nul 2>&1 || set "PY=python"
%PY% --version >nul 2>&1 || (
    echo [エラー] Python が見つかりません。Python を導入し PATH を通して再実行してください。
    pause
    exit /b 1
)

rem === ビルド専用の隔離 venv ===
rem 端末のグローバル Python には無関係なライブラリが多数入っており、そのまま
rem ビルドすると PyInstaller が拾って exe に余計な依存が混入する。専用 venv は
rem 既定でシステムの site-packages を参照しないため、必要な依存だけが入った
rem クリーンな環境でビルドでき、配布物の肥大化を防げる。
rem   build.bat clean  … venv を作り直す
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
echo  [2/2] exe をビルド (PyInstaller)
echo ============================================
"%VPY%" -m PyInstaller packaging\pdftosvg.spec --clean --noconfirm --distpath dist --workpath build
if errorlevel 1 (
    echo.
    echo [エラー] ビルドに失敗しました。
    pause
    exit /b 1
)

echo.
echo ============================================
echo  完成: dist\PdfToSvg\PdfToSvg.exe
echo ============================================
pause
