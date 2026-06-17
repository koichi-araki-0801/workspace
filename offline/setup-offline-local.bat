@echo off
rem ============================================================================
rem  Fully-offline setup (NO download) - uses already-fetched local bundle only
rem
rem  Prerequisite: the heavy bundle is already obtained from GitHub and placed at
rem  the repo root (or bk\):
rem    - offline-deps-bundle.tar.gz   (unextracted bundle), OR
rem    - already-extracted .pnpm-store / pnpm.tgz / ms-playwright
rem
rem  This script NEVER touches the network. It only extracts (if needed) and
rem  builds the environment offline. For the fetch+build flow use setup-offline.bat.
rem
rem  Usage (double-click or command line; args forwarded to the .ps1):
rem    setup-offline-local.bat              extract (if needed) + offline build
rem    setup-offline-local.bat -SkipBuild   extract only, no install/build
rem    setup-offline-local.bat -NoVerify    skip sha256 / lockfile checks
rem
rem  ASCII only on purpose: non-ASCII here breaks cmd parsing on JP code pages.
rem ============================================================================
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-offline-local.ps1" %*
exit /b %ERRORLEVEL%
