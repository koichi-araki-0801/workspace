@echo off
chcp 65001 >nul
rem Launch build-exe.ps1 with ExecutionPolicy Bypass (forwards all args).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build-exe.ps1" %*
exit /b %ERRORLEVEL%
