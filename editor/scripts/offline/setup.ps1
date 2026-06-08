#requires -Version 5.1
<#
.SYNOPSIS
  Install and build this app from an offline bundle on an air-gapped Windows machine.

.DESCRIPTION
  Verifies the bundle checksum, extracts it, checks prerequisites (Node 24, Python,
  Edge), writes a .env template if missing, then builds (offline) and optionally starts
  the server. No network access is required or attempted.

.PARAMETER Bundle
  Path to the editor-offline-*.tgz produced by pack.ps1. Required.

.PARAMETER Dest
  Directory to extract into. Default: <bundle dir>\editor

.PARAMETER Start
  Also start the server after building (npm start -w server).

.EXAMPLE
  pwsh -File scripts/offline/setup.ps1 -Bundle .\editor-offline-20260606-101500.tgz -Start
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Bundle,
  [string]$Dest,
  [switch]$Start
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$Bundle = (Resolve-Path $Bundle).Path
if (-not $Dest) { $Dest = Join-Path (Split-Path $Bundle -Parent) 'editor' }

Write-Host "[setup] bundle : $Bundle"
Write-Host "[setup] dest   : $Dest"

# --- Verify checksum -----------------------------------------------------------
$sumFile = "$Bundle.sha256"
if (Test-Path $sumFile) {
  $expected = ((Get-Content $sumFile -Raw).Trim() -split '\s+')[0]
  $actual = (Get-FileHash -Algorithm SHA256 -Path $Bundle).Hash
  if ($expected -ne $actual) {
    throw "Checksum mismatch!`n  expected $expected`n  actual   $actual"
  }
  Write-Host "[setup] checksum: OK"
} else {
  Write-Warning "No .sha256 file next to bundle; skipping integrity check."
}

# --- Prerequisites -------------------------------------------------------------
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw "Node.js not found. Pre-install Node 24.x on this machine." }
$nodeVersion = (& node --version)
Write-Host "[setup] node   : $nodeVersion"
if ($nodeVersion -notmatch '^v24\.') { Write-Warning "Node $nodeVersion is not v24.x (.nvmrc=24)." }

$py = Get-Command python -ErrorAction SilentlyContinue
if (-not $py) { Write-Warning "python not found on PATH (needed by /api/generate)." }
else { Write-Host "[setup] python : $((& python --version) 2>&1)" }

$edgeCandidates = @(
  'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
  'C:\Program Files\Microsoft\Edge\Application\msedge.exe'
)
$edge = $edgeCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if ($edge) { Write-Host "[setup] edge   : $edge" }
else { Write-Warning "Microsoft Edge not found; set VIVLIOSTYLE_EXECUTABLE_BROWSER manually for PDF export." }

# --- Extract -------------------------------------------------------------------
if (-not (Test-Path $Dest)) { New-Item -ItemType Directory -Path $Dest | Out-Null }
Write-Host "[setup] extracting..."
& tar --extract --gzip --file "$Bundle" --directory "$Dest"
if ($LASTEXITCODE -ne 0) { throw "tar extract failed (exit $LASTEXITCODE)" }

# --- appconfig.json ------------------------------------------------------------
# Generate the runtime config from the committed example, filling in the
# detected Edge path. Operators edit this file (port/paths/etc.) afterwards.
$cfgFile = Join-Path $Dest 'appconfig.json'
$cfgExample = Join-Path $Dest 'appconfig.example.json'
if (-not (Test-Path $cfgFile)) {
  if (Test-Path $cfgExample) {
    $cfg = Get-Content $cfgExample -Raw | ConvertFrom-Json
    if ($edge) { $cfg.pdf.executableBrowser = $edge }
    $cfg | ConvertTo-Json -Depth 10 | Out-File -FilePath $cfgFile -Encoding utf8
    Write-Host "[setup] wrote $cfgFile (review port/paths before production)"
  } else {
    Write-Warning "appconfig.example.json not found; skipping appconfig.json generation."
  }
} else {
  Write-Host "[setup] appconfig.json exists: $cfgFile (left untouched)"
}

# --- Build (offline) -----------------------------------------------------------
Push-Location $Dest
try {
  Write-Host "[setup] building (npm run build) — no network required..."
  & npm run build
  if ($LASTEXITCODE -ne 0) { throw "build failed (exit $LASTEXITCODE)" }
  Write-Host "[setup] build: OK (server/dist, web/dist ready)"

  if ($Start) {
    Write-Host "[setup] starting server (Ctrl+C to stop)..."
    $env:NODE_ENV = 'production'
    & npm start -w server
  } else {
    Write-Host ""
    Write-Host "[setup] DONE. Start with:  cd `"$Dest`"; `$env:NODE_ENV='production'; npm start -w server"
  }
}
finally {
  Pop-Location
}
