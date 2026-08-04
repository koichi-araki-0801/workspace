@echo off
chcp 65001 >nul
rem Launch new-signing-cert.ps1 with ExecutionPolicy Bypass (forwards all args).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0new-signing-cert.ps1" %*
exit /b %ERRORLEVEL%
