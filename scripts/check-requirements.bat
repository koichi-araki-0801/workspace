@echo off
chcp 65001 >nul
rem Runs check-requirements.ps1 with execution policy bypass (arguments are forwarded).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0check-requirements.ps1" %*
exit /b %ERRORLEVEL%
