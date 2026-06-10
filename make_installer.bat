@echo off
chcp 65001 >nul
cd /d "%~dp0"
title PdfToSvg インストーラ生成

rem exe がビルド済みか確認
if not exist "dist\PdfToSvg\PdfToSvg.exe" (
    echo [中止] exe が見つかりません: dist\PdfToSvg\PdfToSvg.exe
    echo 先に build.bat を実行してください。
    pause
    exit /b 1
)

rem Inno Setup (ISCC.exe) を探索
set "ISCC="
if exist "%ProgramFiles(x86)%\Inno Setup 6\ISCC.exe" set "ISCC=%ProgramFiles(x86)%\Inno Setup 6\ISCC.exe"
if exist "%ProgramFiles%\Inno Setup 6\ISCC.exe" set "ISCC=%ProgramFiles%\Inno Setup 6\ISCC.exe"

if "%ISCC%"=="" (
    echo [中止] Inno Setup が見つかりません。
    echo 下記からインストールしてから再実行してください:
    echo   https://jrsoftware.org/isdl.php
    pause
    exit /b 1
)

echo Inno Setup: "%ISCC%"
echo インストーラを生成します...
"%ISCC%" packaging\installer.iss
if errorlevel 1 (
    echo.
    echo [エラー] インストーラ生成に失敗しました。
    pause
    exit /b 1
)

echo.
echo ============================================
echo  完成: dist_installer\PdfToSvg-Setup-0.1.0.exe
echo ============================================
pause
