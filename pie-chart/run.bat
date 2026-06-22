@echo off
chcp 65001 >nul
rem Detect installed Node version and dispatch to pnpm (24.x) or npm (20.x).
rem Runs run.ps1 with ExecutionPolicy Bypass; forwards all args as-is.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run.ps1" %*
exit /b %ERRORLEVEL%
