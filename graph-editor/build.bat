@echo off
REM =============================================================================
REM  SVG Label Position Editor - Windows exe build (one click)
REM  Output: editor\dist\LabelEditor.exe  (single file, no Python needed to run)
REM  Design: no bundled browser engine. The exe starts a tiny local HTTP server
REM  and opens the OS Edge in app mode; file I/O uses the browser File System
REM  Access API. So there is NO WebView2 runtime to bundle -> tiny (~10MB) exe.
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

echo [1/2] Checking build dependency (PyInstaller)...
%PY% -c "import PyInstaller" 2>nul
if errorlevel 1 (
  echo   Installing PyInstaller ^(network required^)...
  %PY% -m pip install pyinstaller
  %PY% -c "import PyInstaller" 2>nul || (
    echo [ERROR] Install failed. Check your network / proxy settings.
    pause
    exit /b 1
  )
) else (
  echo   OK ^(already installed, no network needed^)
)

echo [2/2] Building with PyInstaller ^(single file, no runtime to bundle^)...
%PY% -m PyInstaller --noconfirm --onefile --windowed --name LabelEditor ^
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
