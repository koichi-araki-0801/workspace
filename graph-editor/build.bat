@echo off
REM =============================================================================
REM  SVG Label Position Editor - Windows exe build (one click)
REM  Output: editor\dist\LabelEditor.exe  (single file, no Python needed to run)
REM  Design: no bundled browser engine. The exe starts a tiny local HTTP server
REM  and opens the OS Edge in app mode; file I/O uses the browser File System
REM  Access API. So there is NO WebView2 runtime to bundle -> tiny (~10MB) exe.
REM
REM  IMPORTANT: the build runs inside a DEDICATED, ISOLATED venv (.venv-build).
REM  A plain `python -m venv` does NOT see the machine's global site-packages,
REM  so whatever extra libraries are installed on this terminal can NOT leak
REM  into the exe. LabelEditor itself has no runtime deps (stdlib only), so the
REM  bundle stays minimal regardless of the build host.
REM  Run `build.bat clean` to recreate the venv from scratch.
REM
REM  Messages are ASCII-only on purpose: cmd.exe mis-parses multibyte .bat files.
REM =============================================================================
setlocal
cd /d "%~dp0"

REM --- choose Python launcher (prefer py -3, fall back to python) ---
set "PY=py -3"
%PY% --version >nul 2>&1 || set "PY=python"
%PY% --version >nul 2>&1 || (
  echo [ERROR] Python not found. Install Python and add it to PATH, then retry.
  pause
  exit /b 1
)

REM --- isolated build venv (keeps the global Python's extra packages OUT of the exe) ---
set "VENV=%~dp0.venv-build"
if /i "%~1"=="clean" if exist "%VENV%" (
  echo [setup] Removing existing build venv ^(clean^)...
  rmdir /s /q "%VENV%"
)
if not exist "%VENV%\Scripts\python.exe" (
  echo [setup] Creating isolated build venv ^(.venv-build^)...
  %PY% -m venv "%VENV%" || (
    echo [ERROR] Failed to create the build venv.
    pause
    exit /b 1
  )
)
set "VPY=%VENV%\Scripts\python.exe"

echo [1/2] Checking build dependency ^(PyInstaller^) in the isolated venv...
"%VPY%" -m pip install --upgrade pip >nul 2>&1
"%VPY%" -c "import PyInstaller" 2>nul
if errorlevel 1 (
  echo   Installing PyInstaller ^(network required^)...
  "%VPY%" -m pip install pyinstaller
  "%VPY%" -c "import PyInstaller" 2>nul || (
    echo [ERROR] Install failed. Check your network / proxy settings.
    pause
    exit /b 1
  )
) else (
  echo   OK ^(already installed, no network needed^)
)

echo [2/2] Building with PyInstaller ^(single file, no runtime to bundle^)...
"%VPY%" -m PyInstaller --noconfirm --clean --onefile --windowed --name LabelEditor ^
  --add-data "ui.html;." ^
  --add-data "styles.css;." ^
  --add-data "js;js" ^
  --add-data "lib/leader_geom.cjs;lib" ^
  app.py
if errorlevel 1 (
  echo.
  echo [ERROR] Build failed.
  echo   - If LabelEditor.exe is currently running, close it and retry ^(cannot overwrite^).
  echo   - Otherwise check the PyInstaller error log above.
  pause
  exit /b 1
)

echo.
echo Done.
echo   Distribute:  %~dp0dist\LabelEditor.exe   ^(single file, ~10MB^)
echo   Recipient double-clicks it; it opens in Microsoft Edge ^(an app window^).
echo   Runs on Windows 10 / 11 with no extra install ^(Edge ships with Windows^).
pause
