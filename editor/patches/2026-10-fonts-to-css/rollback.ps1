<#
.SYNOPSIS
  2026-10-fonts-to-css の移行を元に戻す。

.DESCRIPTION
  既定は確認モード。-Apply を付けたときだけ実行する。処理順:
    1. 移行コミット(作者 system、件名に [fonts-to-css])を git revert する
    2. assets.migrated-<日付> を assets へ改名して戻し、移行で作った css\fonts と js を削除する
    3. appconfig.json.bak-<日付> があれば appconfig.json へ戻す
  実行前に editor サーバを止め、戻したあとは旧版の editor を配置して起動すること。

.PARAMETER DataRoot
  data リポジトリの場所(省略時は migrate.ps1 と同じ規則)。

.PARAMETER Date
  戻す移行の日付(yyyyMMdd)。省略時は assets.migrated-* が 1 つだけならそれを使う。

.PARAMETER Apply
  実際に戻す。付けなければ確認モード。
#>
param([string]$DataRoot, [string]$Date, [switch]$Apply)

$ErrorActionPreference = 'Stop'
$editorDir = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path))
if (-not $DataRoot) {
  $DataRoot = $env:DATA_ROOT
  if (-not $DataRoot) { $DataRoot = [Environment]::GetEnvironmentVariable('DATA_ROOT', 'User') }
  if (-not $DataRoot) { $DataRoot = Join-Path (Split-Path -Parent (Split-Path -Parent $editorDir)) 'editor-data' }
  elseif (-not [IO.Path]::IsPathRooted($DataRoot)) { $DataRoot = [IO.Path]::GetFullPath((Join-Path $editorDir $DataRoot)) }
}
function Invoke-Git {
  # git は LF→CRLF 変換などの警告を stderr へ出す。$ErrorActionPreference = 'Stop' のままだと
  # PowerShell 5.1 がそれを例外にするので、stderr は捨てて終了コードだけで失敗を判定する。
  $ErrorActionPreference = 'Continue'
  $out = & git -C $DataRoot @args 2>$null
  if ($LASTEXITCODE -ne 0) { throw "git $($args -join ' ') が失敗しました(終了コード $LASTEXITCODE)。" }
  return $out
}

$migrated = @(Get-ChildItem -LiteralPath $DataRoot -Directory -Filter 'assets.migrated-*')
if ($Date) { $migrated = @($migrated | Where-Object { $_.Name -eq "assets.migrated-$Date" }) }
if ($migrated.Count -ne 1) { throw "戻す対象の assets.migrated-* が 1 つに決まりません。-Date で指定してください。" }
$commit = Invoke-Git log --author=system --grep '\[fonts-to-css\]' --format=%H -1
$appConfigPath = if ($env:APP_CONFIG) { $env:APP_CONFIG } else { Join-Path $editorDir 'appconfig.json' }
$bak = "$appConfigPath.bak-" + $migrated[0].Name.Substring('assets.migrated-'.Length)

Write-Host "dataRoot: $DataRoot"
Write-Host "revert するコミット: $(if ($commit) { $commit } else { '(なし)' })"
Write-Host "改名して戻す: $($migrated[0].FullName) -> assets"
Write-Host "削除する: $(Join-Path $DataRoot 'css\fonts') と $(Join-Path $DataRoot 'js')"
Write-Host "appconfig を戻す: $(if (Test-Path -LiteralPath $bak) { $bak } else { '(バックアップなし)' })"
if (-not $Apply) { Write-Host '確認モードのため何も変えていません。実行するには -Apply を付けてください。'; return }

if ($commit) { Invoke-Git -c user.name=system -c user.email=system@editor.local revert --no-edit $commit | Out-Null }
Rename-Item -LiteralPath $migrated[0].FullName -NewName 'assets'
foreach ($d in 'css\fonts', 'js') {
  $p = Join-Path $DataRoot $d
  if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Recurse -Force }
}
if (Test-Path -LiteralPath $bak) { Copy-Item -LiteralPath $bak -Destination $appConfigPath -Force }
Write-Host '元に戻しました。旧版の editor を配置して起動してください。'
