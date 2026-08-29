@echo off
chcp 65001 >nul
title Offline bundle - publish
rem Launches publish-offline-bundle.ps1 with ExecutionPolicy Bypass (args forwarded).
rem Double-click or command line. Details: see the .ps1 help.
rem ASCII only on purpose: cmd garbles multi-byte rem/title lines in .bat files.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0publish-offline-bundle.ps1" %*
exit /b %ERRORLEVEL%
