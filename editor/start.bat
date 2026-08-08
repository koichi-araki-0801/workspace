@echo off
rem ============================================================================
rem  Jinja Template Editor - launcher
rem
rem  Usage:
rem    start.bat               production, local data (build + server :24680)
rem    start.bat dev           development : Fastify(:24680) + Vite(:24681)
rem    start.bat rest          REST data mode (SQL Server backend; needs login)
rem    start.bat dev rest      development + REST
rem    start.bat prod rest     production  + REST
rem    start.bat rest lan      production + REST, exposed to the intranet LAN (HTTPS)
rem    start.bat rest lan-plain  same but plain HTTP (opt-in, discouraged)
rem
rem  Args are order-free. The data mode (local|rest) sets VITE_API_MODE, which
rem  the web app reads to pick localStorage (local, default, no DB) or the REST
rem  repositories (rest). 'db' is an alias of 'rest'.
rem
rem  'lan' (prod only) binds to 0.0.0.0 so other machines can reach the app.
rem  It implies the REST data mode: REST is the mode that has logins, and the
rem  server refuses to bind a non-loopback host without AUTH_REQUIRED=true (see
rem  config.ts), so 'local lan' would only ever produce a failed start. Asking
rem  for both explicitly is rejected here instead of overriding what was typed.
rem  'lan' always asks the server for HTTPS. The cert is resolved by the server
rem  (HTTPS_PFX > appconfig tls.pfx > server\tls\editor.pfx), so a cert placed
rem  anywhere the documented config allows still starts as HTTPS; a missing cert
rem  now stops the start instead of silently serving plain HTTP. Run
rem  scripts\setup-lan-https.bat once. If plain HTTP is truly required, use
rem  'lan-plain', which opts in via ALLOW_PLAINTEXT_LAN and drops the Secure
rem  cookie flag (otherwise REST login cookies would be rejected by browsers).
rem
rem  Double-click runs production mode with local data. Stop with Ctrl+C.
rem  ASCII only on purpose: non-ASCII here breaks cmd parsing on JP code pages.
rem ============================================================================
setlocal
rem Drive the pnpm workspace from the repo root (one level up: editor/ -> root).
cd /d "%~dp0\.."
rem Repo root absolute path, used to scope the port pre-check/cleanup to THIS repo.
set "REPO_ROOT=%CD%"

rem --- process-identity patterns (single source for :portcheck and :cleanup) --
rem A listener is "ours" only when its command line runs our entry (server prod
rem dist\app.js / dev src/app.ts under tsx / vite) AND mentions this repo's path
rem (%REPO_ROOT%). Without the path check, a generic `tsx watch src/app.ts` from an
rem unrelated repo that happens to hold our port would be tree-killed by mistake.
set "SRV_PAT=(dist[\\/]app\.js)|(src[\\/]app\.ts)"
set "VITE_PAT=vite[\\/]bin[\\/]vite\.js"

rem --- mode (build prod/dev) and data mode (local/rest), order-free -----------
set "MODE=prod"
set "APIMODE=local"
rem Server listen port. Kept in env so the port pre-check and node agree (see config.ts).
set "PORT=24680"
set "LAN="
set "LANPLAIN="
rem Set when 'local' was typed, to tell it apart from 'local' being the default.
set "LOCALARG="
for %%A in (%1 %2 %3) do (
  if /I "%%A"=="dev"         set "MODE=dev"
  if /I "%%A"=="-dev"        set "MODE=dev"
  if /I "%%A"=="development" set "MODE=dev"
  if /I "%%A"=="prod"        set "MODE=prod"
  if /I "%%A"=="local"       set "APIMODE=local"
  if /I "%%A"=="local"       set "LOCALARG=1"
  if /I "%%A"=="rest"        set "APIMODE=rest"
  if /I "%%A"=="db"          set "APIMODE=rest"
  if /I "%%A"=="lan"         set "LAN=1"
  if /I "%%A"=="lan-plain"   set "LAN=1"
  if /I "%%A"=="lan-plain"   set "LANPLAIN=1"
  if /I "%%A"=="plain"       set "LAN=1"
  if /I "%%A"=="plain"       set "LANPLAIN=1"
)

rem --- LAN exposure (prod only) ------------------------------------------------
rem 'lan' binds the server to all interfaces so other intranet machines can reach
rem it, and always asks for HTTPS. Deciding TLS here (by probing one hard-coded
rem cert path) used to publish a correctly-configured deployment as plain HTTP,
rem so cert resolution is left to config.ts alone - the single source of truth.
rem Exposure and authentication used to be independent switches, so 'lan' alone
rem published an editor with every auth check disabled. LAN now implies REST
rem (the data mode that has logins and sets AUTH_REQUIRED below); an explicit
rem 'local lan' is a contradiction and stops here rather than being overridden.
set "SCHEME=http"
if "%LAN%"=="1" if /I "%MODE%"=="dev" (
  echo [start] WARN: 'lan' is ignored in dev mode - LAN exposure is prod-only.
  set "LAN="
)
if "%LAN%"=="1" if "%LOCALARG%"=="1" goto :lanlocal
if "%LAN%"=="1" if /I "%APIMODE%"=="local" (
  echo [start] NOTE: 'lan' implies the REST backend - data mode set to rest.
  set "APIMODE=rest"
)

rem Vite exposes process-env vars prefixed VITE_ to the client at build/dev time.
set "VITE_API_MODE=%APIMODE%"
rem In REST mode, turn on server-side auth enforcement + DB audit mirroring.
rem (DB_SERVER etc. come from the environment / appconfig; see server/db/README.)
if /I "%APIMODE%"=="rest" (
  set "AUTH_REQUIRED=true"
  set "AUDIT_DB=true"
)

if "%LAN%"=="1" (
  set "HOST=0.0.0.0"
  if "%LANPLAIN%"=="1" (
    echo [start] WARN: PLAINTEXT LAN. Login IDs and passwords travel unencrypted.
    echo [start]       Do not make ALLOW_PLAINTEXT_LAN a permanent setting.
    set "HTTPS=false"
    set "ALLOW_PLAINTEXT_LAN=1"
    set "COOKIE_SECURE=false"
    set "SCHEME=http"
  ) else (
    set "HTTPS=true"
    set "SCHEME=https"
  )
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
echo    App   : http://localhost:24681
echo    API   : http://localhost:24680
echo    Login : admin / admin   or   editor / editor
echo    Stop  : Ctrl+C
echo   ==========================================
echo.
rem Launch through run-in-job: a hidden watchdog tears down the whole tree (node, vite,
rem tsx watch, the forked PDF worker daemon and the headless chromium it spawns) even
rem when this window is closed with the X button, which sends no signal. See
rem scripts\run-in-job.ps1. %~dp0 stays editor\ even after the cd above.
call "%~dp0scripts\run-in-job.bat" pnpm run dev
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
rem Resolve this machine's LAN IPv4 for the banner (loopback/APIPA excluded).
rem Falls back to the computer name when no address is found.
set "LANIP="
if "%LAN%"=="1" for /f "delims=" %%i in ('powershell -NoProfile -Command "(Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -ne '127.0.0.1' -and $_.IPAddress -notlike '169.254.*' } | Select-Object -First 1 -ExpandProperty IPAddress)"') do set "LANIP=%%i"
if "%LAN%"=="1" if not defined LANIP set "LANIP=%COMPUTERNAME%"
echo.
echo   ==========================================
echo    Server : %SCHEME%://localhost:%PORT%
if "%LAN%"=="1" echo    LAN    : %SCHEME%://%LANIP%:%PORT%   ^(from other machines^)
echo    Stop   : Ctrl+C
echo   ==========================================
echo.
rem Same run-in-job watchdog wrapper as dev so an X-button close kills the server tree.
rem Run node with the absolute entry path instead of `pnpm --filter server run start`:
rem the path in the command line is what lets :portcheck/:cleanup identify a stale
rem server as ours (repo-scoped match); pnpm's child shows only `node dist/app.js`.
rem cwd must stay editor\server (config resolves data dirs from it), hence the cd.
cd /d "%~dp0server"
call "%~dp0scripts\run-in-job.bat" node "%~dp0server\dist\app.js"
if errorlevel 1 goto :serverfail
goto :end

rem --- error exits ------------------------------------------------------------
:nonode
echo [start] ERROR: Node.js not found. Install Node 24.x and add it to PATH.
exit /b 1

:installfail
echo [start] ERROR: pnpm install failed.
exit /b 1

:lanlocal
rem 'local lan' would bind 0.0.0.0 with authentication disabled; the server would
rem refuse to start anyway (config.ts), so fail here with the fix spelled out.
echo [start] ERROR: 'lan' cannot be combined with 'local'.
echo [start]        LAN exposure requires the REST backend, which is what enables
echo [start]        logins (AUTH_REQUIRED). Use:  start.bat rest lan
exit /b 1

:buildfail
echo [start] ERROR: build failed.
exit /b 1

:portbusy
rem Port held by a process that is not our server; :portcheck already printed who.
rem Pause so the reason stays readable when launched by double-click.
echo [start] Aborting: free port %PORT% and retry.
echo [start] Hint: stop the PID printed above, e.g.  taskkill /PID ^<pid^> /F
pause
exit /b 1

:serverfail
rem Server exited non-zero. Keep the window open so the error above is readable
rem (double-click closes it otherwise), which is what made crashes look silent.
set "RC=%ERRORLEVEL%"
call :cleanup
echo [start] server exited with code %RC%
pause
exit /b %RC%

:end
call :cleanup
endlocal
exit /b 0

rem --- subroutine: free the listen port (called before launch) ----------------
rem Returns 0 when the port is free (or a stale server of ours was stopped),
rem 1 when an unrelated process holds it. Detection is delegated to PowerShell
rem (Get-NetTCPConnection / Win32_Process), available on Windows 10+. A process
rem is treated as "ours" when its command line matches SRV_PAT AND contains this
rem repo's path (REPO_ROOT) - see the pattern block at the top. The dev
rem supervisor (its parent: `tsx watch src/app.ts`) is stopped too, otherwise
rem tsx would respawn the child and re-grab the port. We never auto-stop an
rem unrelated process: a foreign holder aborts with its PID printed.
rem
rem We kill with `taskkill /T /F` (whole tree), not `Stop-Process -Force`: on
rem Windows the latter kills only that PID, so the forked PDF worker daemon and
rem the headless chromium it spawned would be orphaned. We also reap a stale
rem vite of ours on :24681 (best-effort, never abort, never touch a foreign holder).
:portcheck
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='SilentlyContinue'; $srv='%SRV_PAT%'; $vite='%VITE_PAT%'; $root=[regex]::Escape('%REPO_ROOT%'); $kill=@(); $foreign=$false; $c=Get-NetTCPConnection -LocalPort %PORT% -State Listen; foreach($procId in ($c | Select-Object -ExpandProperty OwningProcess -Unique)){ $p=Get-CimInstance Win32_Process -Filter ('ProcessId='+$procId); $cl=''; if($p){$cl=$p.CommandLine}; if(($cl -match $srv) -and ($cl -match $root)){ $top=$procId; if($p -and $p.ParentProcessId){ $par=Get-CimInstance Win32_Process -Filter ('ProcessId='+$p.ParentProcessId); if($par -and ($par.CommandLine -match $srv) -and ($par.CommandLine -match $root)){ $top=$par.ProcessId } }; $kill+=$top } else { $n='unknown'; if($p){$n=$p.Name}; Write-Host ('[start] ERROR: port %PORT% is in use by PID '+$procId+' ('+$n+').'); $foreign=$true } }; if($foreign){exit 1}; $vc=Get-NetTCPConnection -LocalPort 24681 -State Listen; foreach($procId in ($vc | Select-Object -ExpandProperty OwningProcess -Unique)){ $p=Get-CimInstance Win32_Process -Filter ('ProcessId='+$procId); if($p -and ($p.CommandLine -match $vite) -and ($p.CommandLine -match $root)){ $kill+=$procId } }; foreach($procId in ($kill | Select-Object -Unique)){ Write-Host ('[start] stopping stale process (PID '+$procId+') ...'); $null=(taskkill /PID $procId /T /F 2>&1) }; for($i=0;$i -lt 20;$i++){ if(-not (Get-NetTCPConnection -LocalPort %PORT% -State Listen)){ exit 0 }; Start-Sleep -Milliseconds 150 }; exit 0"
exit /b %ERRORLEVEL%

rem --- subroutine: tear down our leftover processes on exit -------------------
rem Best-effort safety net for the normal/Ctrl+C->N exit path (the Job Object in
rem run-in-job.ps1 already handles X-button and hard kills). Tree-kills any
rem listener of ours on :%PORT% (server) or :24681 (vite); foreign holders are
rem left untouched. No abort, no wait - cleanup must never block shutdown.
:cleanup
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='SilentlyContinue'; $pat='%SRV_PAT%|%VITE_PAT%'; $root=[regex]::Escape('%REPO_ROOT%'); foreach($port in @(%PORT%,24681)){ $c=Get-NetTCPConnection -LocalPort $port -State Listen; foreach($procId in ($c | Select-Object -ExpandProperty OwningProcess -Unique)){ $p=Get-CimInstance Win32_Process -Filter ('ProcessId='+$procId); if($p -and ($p.CommandLine -match $pat) -and ($p.CommandLine -match $root)){ $top=$procId; if($p.ParentProcessId){ $par=Get-CimInstance Win32_Process -Filter ('ProcessId='+$p.ParentProcessId); if($par -and ($par.CommandLine -match $pat) -and ($par.CommandLine -match $root)){ $top=$par.ProcessId } }; $null=(taskkill /PID $top /T /F 2>&1) } } }"
exit /b 0
