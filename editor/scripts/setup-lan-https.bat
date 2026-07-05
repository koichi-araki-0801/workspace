@echo off
chcp 65001 >nul
rem 同梱の setup-lan-https.ps1 を実行ポリシー Bypass で実行（引数はそのまま転送）。
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-lan-https.ps1" %*
exit /b %ERRORLEVEL%
