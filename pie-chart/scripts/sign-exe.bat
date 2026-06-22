@echo off
chcp 65001 >nul
rem Launch sign-exe.ps1 with ExecutionPolicy Bypass (forwards all args).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0sign-exe.ps1" %*
exit /b %ERRORLEVEL%
