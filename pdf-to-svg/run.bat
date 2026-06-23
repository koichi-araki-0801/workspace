@echo off
chcp 65001 >nul
cd /d "%~dp0"
title PdfToSvg 起動

rem py ランチャ優先、無ければ python
set "PY=py"
where py >nul 2>&1 || set "PY=python"

echo PdfToSvg を起動します...
%PY% run.py

if errorlevel 1 (
    echo.
    echo [エラー] 起動に失敗しました。
    echo 依存が未導入の場合は scripts\build.bat を一度実行してください。
    pause
)
