@echo off
chcp 65001 >nul
rem Launch verify-dist.ps1 with ExecutionPolicy Bypass (forwards all args).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0verify-dist.ps1" %*
exit /b %ERRORLEVEL%
