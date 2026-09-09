@echo off
chcp 65001 >nul
title Offline bundle - fetch from GitHub Releases
rem Launches fetch-offline-bundle.ps1 with ExecutionPolicy Bypass (args forwarded).
rem Downloads the offline bundle (tar.gz / .sha256 / bundle.key) from GitHub Releases over
rem HTTPS into the repo root. Run this on a machine with network access, then run
rem setup-offline.bat (which never downloads by itself).
rem   fetch-offline-bundle.bat                    fetch tag offline-bundle-v1
rem   fetch-offline-bundle.bat -Tag <tag>         fetch another release tag
rem ASCII only on purpose: cmd garbles multi-byte rem/title lines in .bat files.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0fetch-offline-bundle.ps1" %*
exit /b %ERRORLEVEL%
