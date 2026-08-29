@echo off
chcp 65001 >nul
title Offline setup - fetch and build
rem Launches setup-offline.ps1 with ExecutionPolicy Bypass (args forwarded).
rem Fetches source + heavy bundle from Releases over HTTPS, extracts, builds.
rem Verification (sha256 from offline\pinned-release.txt and the detached signature
rem checked with offlineundle-signing.pub.xml) is mandatory; missing or mismatching
rem material aborts the run. Add -InstallTortoiseGit only if you also want TortoiseGit
rem (elevated MSI, so it is not installed by default). Details: see the .ps1 help.
rem ASCII only on purpose: cmd garbles multi-byte rem/title lines in .bat files.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-offline.ps1" %*
exit /b %ERRORLEVEL%
