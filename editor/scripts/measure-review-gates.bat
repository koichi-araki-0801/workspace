@echo off
rem ============================================================================
rem  measure-review-gates.bat - count false positives of the create-route review
rem  checks and the script-invariance gate on THIS machine's templates/, pending/ and part
rem  catalog (DB). Read-only: it never writes to dataRoot or the DB (DB calls go
rem  through a read-only allow list). Same settings as the server: appconfig.json
rem  and the environment (DATA_ROOT, DB_SERVER, DB_NAME, ...); start.bat sets none
rem  of those, so run it in the same kind of console that starts the server.
rem
rem  Usage:
rem    scripts\measure-review-gates.bat                  report to <repo>\bk\measure-<time>\
rem    scripts\measure-review-gates.bat --out <folder>   report to <folder> (not inside dataRoot)
rem
rem  Prints a summary on screen; the details go to report.txt (excerpts only).
rem  Exit code: 0 measured, 1 failed (nothing was changed), 2 bad arguments.
rem  ASCII only on purpose: non-ASCII here breaks cmd parsing on JP code pages.
rem ============================================================================
setlocal
rem pushd instead of `cd /d`: UNC-safe. The script resolves dataRoot like the server.
pushd "%~dp0..\server" || (
  echo [measure] ERROR: cannot enter "%~dp0..\server".
  exit /b 1
)
rem Show the Japanese summary in UTF-8, then restore the caller's code page.
set "OLDCP="
for /f "tokens=2 delims=:" %%c in ('chcp') do set /a "OLDCP=%%c" >nul 2>nul
chcp 65001 >nul
call pnpm exec tsx scripts\measure-review-gates.ts %*
set "RC=%ERRORLEVEL%"
if defined OLDCP chcp %OLDCP% >nul
popd
endlocal & exit /b %RC%
