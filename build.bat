@echo off
chcp 65001 >nul
cd /d "%~dp0"
title PdfToSvg ビルド

rem py ランチャ優先、無ければ python
set "PY=py"
where py >nul 2>&1 || set "PY=python"

echo ============================================
echo  [1/2] 依存ライブラリをインストール
echo ============================================
%PY% -m pip install --upgrade pip
%PY% -m pip install PySide6 PyMuPDF Pillow pyinstaller
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
%PY% -m PyInstaller packaging\pdftosvg.spec --noconfirm --distpath dist --workpath build
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
echo  配布用インストーラを作る場合は make_installer.bat を実行してください。
pause
