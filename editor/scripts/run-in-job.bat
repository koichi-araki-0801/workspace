@echo off
rem Launcher for run-in-job.ps1 (ASCII only on purpose: a non-ASCII rem here breaks
rem cmd parsing on JP code pages). Runs the .ps1 with ExecutionPolicy Bypass and
rem forwards all args unchanged. %~dp0 resolves relative to this .bat.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run-in-job.ps1" %*
exit /b %ERRORLEVEL%
