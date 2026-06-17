@echo off
chcp 65001 >nul
cd /d "%~dp0"
title PdfToSvg ビルド

rem py ランチャ優先、無ければ python
set "PY=py"
where py >nul 2>&1 || set "PY=python"

rem === ビルド専用の隔離 venv ===
rem 端末のグローバル Python には無関係なライブラリが多数入っており、そのまま
rem ビルドすると PyInstaller が拾って exe に余計な依存が混入する。専用 venv は
rem 既定でシステムの site-packages を参照しないため、必要な依存だけが入った
rem クリーンな環境でビルドでき、配布物の肥大化を防げる。
rem   build.bat clean  … venv を作り直す
set "VENV=%~dp0.venv-build"
if /i "%~1"=="clean" if exist "%VENV%" (
    echo [setup] ビルド venv を作り直します ^(clean^)...
    rmdir /s /q "%VENV%"
)
if not exist "%VENV%\Scripts\python.exe" (
    echo [setup] 隔離ビルド venv ^(.venv-build^) を作成中...
    %PY% -m venv "%VENV%"
    if errorlevel 1 (
        echo.
        echo [エラー] ビルド venv の作成に失敗しました。
        pause
        exit /b 1
    )
)
set "VPY=%VENV%\Scripts\python.exe"

echo ============================================
echo  [1/2] 依存ライブラリをインストール ^(隔離 venv 内^)
echo ============================================
"%VPY%" -m pip install --upgrade pip
"%VPY%" -m pip install PyMuPDF Pillow fonttools brotli pyinstaller
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
