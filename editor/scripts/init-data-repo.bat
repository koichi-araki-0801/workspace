@echo off
rem Run the bundled init-data-repo.ps1 with ExecutionPolicy Bypass (forward all args).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0init-data-repo.ps1" %*
exit /b %ERRORLEVEL%
