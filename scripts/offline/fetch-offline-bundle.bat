@echo off
chcp 65001 >nul
title オフライン重量物 取得
rem 同梱の fetch-offline-bundle.ps1 を実行ポリシー Bypass で実行（引数はそのまま転送）。
rem 単体実行用ランチャ。ダブルクリック／コマンドのどちらでも起動可。
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0fetch-offline-bundle.ps1" %*
exit /b %ERRORLEVEL%
