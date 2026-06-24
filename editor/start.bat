@echo off
rem ============================================================================
rem  Jinja Template Editor - launcher
rem
rem  Usage:
rem    start.bat               production, local data (build + server :3001)
rem    start.bat dev           development : Express(:3001) + Vite(:5173)
rem    start.bat rest          REST data mode (SQL Server backend; needs login)
rem    start.bat dev rest      development + REST
rem    start.bat prod rest     production  + REST
rem
rem  Args are order-free. The data mode (local|rest) sets VITE_API_MODE, which
rem  the web app reads to pick localStorage (local, default, no DB) or the REST
rem  repositories (rest). 'db' is an alias of 'rest'.
rem
rem  Double-click runs production mode with local data. Stop with Ctrl+C.
rem  ASCII only on purpose: non-ASCII here breaks cmd parsing on JP code pages.
rem ============================================================================
setlocal
rem Drive the pnpm workspace from the repo root (one level up: editor/ -> root).
cd /d "%~dp0\.."

rem --- mode (build prod/dev) and data mode (local/rest), order-free -----------
set "MODE=prod"
set "APIMODE=local"
rem Server listen port. Kept in env so the port pre-check and node agree (see config.ts).
set "PORT=3001"
for %%A in (%1 %2) do (
  if /I "%%A"=="dev"         set "MODE=dev"
  if /I "%%A"=="-dev"        set "MODE=dev"
  if /I "%%A"=="development" set "MODE=dev"
  if /I "%%A"=="prod"        set "MODE=prod"
  if /I "%%A"=="local"       set "APIMODE=local"
  if /I "%%A"=="rest"        set "APIMODE=rest"
  if /I "%%A"=="db"          set "APIMODE=rest"
)
rem Vite exposes process-env vars prefixed VITE_ to the client at build/dev time.
set "VITE_API_MODE=%APIMODE%"
rem In REST mode, turn on server-side auth enforcement + DB audit mirroring.
rem (DB_SERVER etc. come from the environment / appconfig; see server/db/README.)
if /I "%APIMODE%"=="rest" (
  set "AUTH_REQUIRED=true"
  set "AUDIT_DB=true"
)

rem --- node prerequisite ------------------------------------------------------
where node >nul 2>nul
if errorlevel 1 goto :nonode
for /f "delims=" %%v in ('node --version') do set "NODE_VERSION=%%v"
echo [start] node : %NODE_VERSION%
echo %NODE_VERSION%| findstr /b /c:"v24." >nul || echo [start] WARN: Node %NODE_VERSION% is not v24.x; .nvmrc requests 24.

rem --- dependencies (first run only) ------------------------------------------
if exist "node_modules" goto :haveDeps
echo [start] node_modules missing - running pnpm install ...
call pnpm install
if errorlevel 1 goto :installfail
:haveDeps

rem --- free the listen port before launch -------------------------------------
rem A prior server not stopped with Ctrl+C (e.g. window closed with the X button)
rem stays alive holding the port, so the next launch dies on EADDRINUSE and looks
rem like it exits silently. Pre-check the port: auto-stop a stale server of ours,
rem but refuse to kill any unrelated process on that port.
call :portcheck
if errorlevel 1 goto :portbusy

if /I "%MODE%"=="prod" goto :prod

rem --- development ------------------------------------------------------------
echo [start] mode : development
echo [start] data : %APIMODE%
echo.
echo   ==========================================
echo    App   : http://localhost:5173
echo    API   : http://localhost:3001
echo    Login : admin / admin   or   editor / editor
echo    Stop  : Ctrl+C
echo   ==========================================
echo.
call pnpm run dev
if errorlevel 1 goto :serverfail
goto :end

rem --- production -------------------------------------------------------------
:prod
echo [start] mode : production
echo [start] data : %APIMODE%
echo [start] building: shared, server, web ...
call pnpm run build
if errorlevel 1 goto :buildfail
set "NODE_ENV=production"
echo.
echo   ==========================================
echo    Server : http://localhost:3001
echo    Stop   : Ctrl+C
echo   ==========================================
echo.
call pnpm --filter server run start
if errorlevel 1 goto :serverfail
goto :end

rem --- error exits ------------------------------------------------------------
:nonode
echo [start] ERROR: Node.js not found. Install Node 24.x and add it to PATH.
exit /b 1

:installfail
echo [start] ERROR: pnpm install failed.
exit /b 1

:buildfail
echo [start] ERROR: build failed.
exit /b 1

:portbusy
rem Port held by a process that is not our server; :portcheck already printed who.
rem Pause so the reason stays readable when launched by double-click.
echo [start] Aborting: free port %PORT% and retry.
pause
exit /b 1

:serverfail
rem Server exited non-zero. Keep the window open so the error above is readable
rem (double-click closes it otherwise), which is what made crashes look silent.
echo [start] server exited with code %ERRORLEVEL%
pause
exit /b %ERRORLEVEL%

:end
endlocal
exit /b 0

rem --- subroutine: free the listen port (called before launch) ----------------
rem Returns 0 when the port is free (or a stale server of ours was stopped),
rem 1 when an unrelated process holds it. Detection is delegated to PowerShell
rem (Get-NetTCPConnection / Win32_Process), available on Windows 10+; the only
rem process auto-stopped is one whose command line runs our `dist/app.js`.
:portcheck
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='SilentlyContinue'; $c=Get-NetTCPConnection -LocalPort %PORT% -State Listen; if(-not $c){exit 0}; foreach($procId in ($c | Select-Object -ExpandProperty OwningProcess -Unique)){ $p=Get-CimInstance Win32_Process -Filter ('ProcessId='+$procId); $cl=''; if($p){$cl=$p.CommandLine}; if($cl -match 'dist[\\/]app\.js'){ Write-Host ('[start] stopping stale server (PID '+$procId+') ...'); Stop-Process -Id $procId -Force } else { $n='unknown'; if($p){$n=$p.Name}; Write-Host ('[start] ERROR: port %PORT% is in use by PID '+$procId+' ('+$n+').'); exit 1 } }; for($i=0;$i -lt 20;$i++){ if(-not (Get-NetTCPConnection -LocalPort %PORT% -State Listen)){ exit 0 }; Start-Sleep -Milliseconds 150 }; exit 0"
exit /b %ERRORLEVEL%
