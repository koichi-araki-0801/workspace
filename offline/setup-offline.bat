@echo off
chcp 65001 >nul
title Offline setup - extract and build
rem Launches setup-offline.ps1 with ExecutionPolicy Bypass (args forwarded).
rem Prerequisite: repo is git-cloned and the bundle (tar.gz / .sha256 / bundle.key) is at the
rem repo root (or bk\). This script never downloads; fetch first with fetch-offline-bundle.bat
rem on a machine with network access.
rem   setup-offline.bat                     extract + offline build
rem   setup-offline.bat -SkipBuild          extract only, no install/build
rem   setup-offline.bat -InstallTortoiseGit also install TortoiseGit (elevated MSI)
rem ASCII only on purpose: cmd garbles multi-byte rem/title lines in .bat files.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-offline.ps1" %*
exit /b %ERRORLEVEL%
