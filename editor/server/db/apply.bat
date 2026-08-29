@echo off
chcp 65001 >nul
title DB 適用
rem 同梱の apply.ps1 を実行ポリシー Bypass で実行（引数はそのまま転送）。
rem 単体実行用ランチャ。-Server が必須（例: apply.bat -Server host\instance）。
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0apply.ps1" %*
exit /b %ERRORLEVEL%
