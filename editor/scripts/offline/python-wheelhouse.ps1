#requires -Version 5.1
<#
.SYNOPSIS
  Build (online) or install (offline) a pip wheelhouse for the Python template generator.

.DESCRIPTION
  The current generator stub (server/scripts/generate_template.py) uses only the Python
  standard library, so no wheelhouse is needed yet. Once the generator adds pip
  dependencies, list them in server/scripts/requirements.txt and use:

    Online  machine:  this script -Mode download   (collects .whl into ./wheelhouse)
    Offline machine:  this script -Mode install     (installs from ./wheelhouse, no index)

.PARAMETER Mode
  download | install

.PARAMETER Requirements
  Path to requirements.txt. Default: server\scripts\requirements.txt

.PARAMETER Wheelhouse
  Directory holding the .whl files. Default: <repo>\wheelhouse
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][ValidateSet('download', 'install')][string]$Mode,
  [string]$Requirements,
  [string]$Wheelhouse
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# pip receives a requirements file below (download and install). The allowlist guard
# (single implementation in offline/lib/verify.ps1) must run before every pip entry point:
# a single requirements line can otherwise redirect pip's resolution target
# (URL / local path / archive), and --no-index does not stop in-file --find-links.
. (Join-Path $PSScriptRoot '..\..\..\offline\lib\verify.ps1')

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
if (-not $Requirements) { $Requirements = Join-Path $repoRoot 'server\scripts\requirements.txt' }
if (-not $Wheelhouse) { $Wheelhouse = Join-Path $repoRoot 'wheelhouse' }

if (-not (Test-Path $Requirements)) {
  throw "requirements.txt not found at $Requirements. Create it from the real generator's deps first."
}

# Guard the requirements file before either pip download or pip install (see note above).
Assert-OfflineRequirementsFile -Path $Requirements

switch ($Mode) {
  'download' {
    if (-not (Test-Path $Wheelhouse)) { New-Item -ItemType Directory -Path $Wheelhouse | Out-Null }
    Write-Host "[wheelhouse] downloading wheels -> $Wheelhouse"
    & python -m pip download -r $Requirements -d $Wheelhouse
    if ($LASTEXITCODE -ne 0) { throw "pip download failed (exit $LASTEXITCODE)" }
    Write-Host "[wheelhouse] DONE. Transport '$Wheelhouse' with the offline bundle."
  }
  'install' {
    Write-Host "[wheelhouse] installing from $Wheelhouse (no network)"
    & python -m pip install --no-index --find-links $Wheelhouse -r $Requirements
    if ($LASTEXITCODE -ne 0) { throw "pip install failed (exit $LASTEXITCODE)" }
    Write-Host "[wheelhouse] DONE."
  }
}
