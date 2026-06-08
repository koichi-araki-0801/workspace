@echo off
rem ============================================================================
rem  Jinja Template Editor - launcher
rem
rem  Usage:
rem    start.bat          production : build, then server only (:3001)
rem    start.bat dev      development: Express(:3001) + Vite(:5173)
rem
rem  Double-click runs production mode. Stop with Ctrl+C.
rem  ASCII only on purpose: non-ASCII here breaks cmd parsing on JP code pages.
rem ============================================================================
setlocal
rem Drive the pnpm workspace from the repo root (one level up: editor/ -> root).
cd /d "%~dp0\.."

rem --- mode -------------------------------------------------------------------
set "MODE=prod"
if /I "%~1"=="dev"         set "MODE=dev"
if /I "%~1"=="-dev"        set "MODE=dev"
if /I "%~1"=="development" set "MODE=dev"

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

if /I "%MODE%"=="prod" goto :prod

rem --- development ------------------------------------------------------------
echo [start] mode : development
echo.
echo   ==========================================
echo    App   : http://localhost:5173
echo    API   : http://localhost:3001
echo    Login : admin / admin   or   editor / editor
echo    Stop  : Ctrl+C
echo   ==========================================
echo.
call pnpm run dev
goto :end

rem --- production -------------------------------------------------------------
:prod
echo [start] mode : production
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

:end
endlocal
