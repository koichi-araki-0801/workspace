@echo off
chcp 65001 >nul
title Offline setup - extract and build
rem Launches setup-offline.ps1 with ExecutionPolicy Bypass (args forwarded).
rem Prerequisite: this repository is already git-cloned. Uses the bundle found at the
rem repo root (or bk\); otherwise downloads it from GitHub Releases over HTTPS.
rem   setup-offline.bat                     extract (download if needed) + offline build
rem   setup-offline.bat -SkipBuild          extract only, no install/build
rem   setup-offline.bat -InstallTortoiseGit also install TortoiseGit (elevated MSI)
rem ASCII only on purpose: cmd garbles multi-byte rem/title lines in .bat files.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-offline.ps1" %*
exit /b %ERRORLEVEL%
