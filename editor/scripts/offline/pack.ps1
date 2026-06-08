#requires -Version 5.1
<#
.SYNOPSIS
  Build an offline bundle of this repo (incl. node_modules) for air-gapped install.

.DESCRIPTION
  Run this on an ONLINE machine whose OS/arch matches the target (Windows x64, Node 24).
  It performs a clean `npm ci` (dev deps included, so the offline machine can build),
  verifies the platform-specific native binaries are present, then packs the whole repo
  into a single .tgz alongside a SHA256 checksum.

  Browser note: PDF generation uses the system Microsoft Edge on the target, so no
  Chromium/Playwright browser is bundled here.

.PARAMETER OutDir
  Directory to write the bundle into. Default: <repo>\dist-offline

.EXAMPLE
  pwsh -File scripts/offline/pack.ps1
#>
[CmdletBinding()]
param(
  [string]$OutDir
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# Repo root = two levels up from this script (scripts/offline/ -> repo).
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
if (-not $OutDir) { $OutDir = Join-Path $repoRoot 'dist-offline' }

Write-Host "[pack] repo root : $repoRoot"
Write-Host "[pack] output    : $OutDir"

# --- Sanity: arch + Node version ----------------------------------------------
if ($env:PROCESSOR_ARCHITECTURE -ne 'AMD64') {
  Write-Warning "Host arch is $env:PROCESSOR_ARCHITECTURE, not AMD64 (x64). Native binaries must match the target."
}
$nodeVersion = (& node --version)
Write-Host "[pack] node      : $nodeVersion"
if ($nodeVersion -notmatch '^v24\.') {
  Write-Warning "Node $nodeVersion is not v24.x (.nvmrc=24). Match the target runtime."
}

# --- Clean install (dev + prod) ------------------------------------------------
Push-Location $repoRoot
try {
  Write-Host "[pack] running: npm ci"
  & npm ci
  if ($LASTEXITCODE -ne 0) { throw "npm ci failed (exit $LASTEXITCODE)" }

  # --- Verify platform-specific native binaries were fetched -------------------
  $required = @(
    'node_modules\@biomejs\cli-win32-x64',
    'node_modules\@esbuild\win32-x64',
    'node_modules\@rollup\rollup-win32-x64-msvc',
    'node_modules\lightningcss-win32-x64-msvc',
    'node_modules\playwright-core'
  )
  $missing = @()
  foreach ($r in $required) {
    if (-not (Test-Path (Join-Path $repoRoot $r))) { $missing += $r }
  }
  if ($missing.Count -gt 0) {
    Write-Warning ("Expected native packages not found (target may differ):`n  " + ($missing -join "`n  "))
  } else {
    Write-Host "[pack] native binaries: OK"
  }

  # --- Build the bundle --------------------------------------------------------
  if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir | Out-Null }
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $tgz = Join-Path $OutDir "editor-offline-$stamp.tgz"

  # Pack repo contents but exclude transient/output dirs (node_modules IS included).
  Write-Host "[pack] creating tarball (this may take a while)..."
  & tar --create --gzip `
    --exclude='./dist-offline' `
    --exclude='./.git' `
    --exclude='./.tmp' `
    --exclude='./logs' `
    --file "$tgz" `
    --directory "$repoRoot" .
  if ($LASTEXITCODE -ne 0) { throw "tar failed (exit $LASTEXITCODE)" }

  # --- Checksum ----------------------------------------------------------------
  $hash = (Get-FileHash -Algorithm SHA256 -Path $tgz).Hash
  $sumFile = "$tgz.sha256"
  "$hash  $(Split-Path $tgz -Leaf)" | Out-File -FilePath $sumFile -Encoding ascii

  $sizeMb = [math]::Round((Get-Item $tgz).Length / 1MB, 1)
  Write-Host ""
  Write-Host "[pack] DONE"
  Write-Host "[pack]   bundle : $tgz ($sizeMb MB)"
  Write-Host "[pack]   sha256 : $hash"
  Write-Host "[pack]   verify on target with: scripts/offline/setup.ps1 -Bundle <tgz>"
}
finally {
  Pop-Location
}
