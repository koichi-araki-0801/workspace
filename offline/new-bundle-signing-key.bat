@echo off
chcp 65001 >nul
title Offline bundle - generate signing key
rem Launches new-bundle-signing-key.ps1 with ExecutionPolicy Bypass (args forwarded).
rem Publisher runs this once. Private key goes to %USERPROFILE%\.offline-signing\,
rem public key to offlineundle-signing.pub.xml. Details: see the .ps1 help.
rem ASCII only on purpose: cmd garbles multi-byte rem/title lines in .bat files.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0new-bundle-signing-key.ps1" %*
exit /b %ERRORLEVEL%
