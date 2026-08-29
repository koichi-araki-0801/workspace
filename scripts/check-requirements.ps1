<#
.SYNOPSIS
  requirements.txt が「名前 + バージョン指定子」だけで書かれているか検査する。

.DESCRIPTION
  pip は requirements ファイル内のオプション行（`--find-links` / `--index-url` / `-e`）・
  直 URL 参照・ローカルパスをすべて受け取るため、ファイルの編集 1 行で解決先そのものを
  差し替えられる。**pip へ渡すすべての入口**でこの検査を通すこと。
  判定の実体は `offline/lib/verify.ps1` の `Assert-OfflineRequirementsFile`（1 実装）。

.PARAMETER Path
  検査する requirements.txt のパス。

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File check-requirements.ps1 -Path docs\_build\requirements.txt
#>
[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$Path)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\offline\lib\verify.ps1')
try {
  Assert-OfflineRequirementsFile -Path $Path
  exit 0
}
catch {
  Write-Error $_
  exit 1
}
