<#
.SYNOPSIS
インストール済み Node のバージョンを見てパッケージマネージャを出し分ける pie-chart ランチャ。

.DESCRIPTION
`node --version` のメジャー番号で実行系を判定し、コマンドをそのまま委譲する:
  - 24 系(>= 23) -> pnpm   ... 開発機(pnpm ワークスペース)向け
  - それ以外(20 系含む) -> npm ... 古い環境(pnpm 無し)向け
これにより pie-chart を **1 フォルダのまま** 新旧どちらの環境でも動かせる(切り出し複製は不要)。
ソース・設定は両環境で共通。差し替えが必要なのは「どの PM で叩くか」だけ、という整理。

第 1 引数は `install` か package.json の script 名(check/test/batch/verify/cli/build:exe 等)。
残りの引数は script へそのまま転送する(`<pm> run <script> -- <args>`)。

.EXAMPLE
run.bat install

.EXAMPLE
run.bat batch

.EXAMPLE
run.bat cli one --sample asset_gbca_pdf_like --output-file out/test.svg
#>
[CmdletBinding()]
param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$CmdArgs
)

$ErrorActionPreference = 'Stop'
# どこから起動してもこの .ps1 のあるフォルダ(= pie-chart)基準で動かす。
Set-Location $PSScriptRoot

# ── 1. Node バージョン判定 ──
$nv = (& node --version) 2>$null
if ($nv -notmatch '^v(\d+)\.') {
  Write-Error "node が見つからない、またはバージョンを判定できません: '$nv'"
  exit 1
}
$major = [int]$Matches[1]

# ── 2. PM 選択(24 系 -> pnpm / それ以外 -> npm) ──
if ($major -ge 23) { $pm = 'pnpm' } else { $pm = 'npm' }
if (-not (Get-Command $pm -ErrorAction SilentlyContinue)) {
  Write-Error "Node $major 系のため '$pm' を使う想定ですが、'$pm' が PATH にありません。"
  exit 1
}
Write-Host "[run] node $nv (major $major) -> $pm"

# ── 3. コマンド委譲 ──
if (-not $CmdArgs -or $CmdArgs.Count -eq 0) {
  Write-Host "usage: run.bat <install|check|test|batch|verify|cli|build:exe|...> [args]"
  exit 0
}
$cmd = $CmdArgs[0]
$rest = if ($CmdArgs.Count -gt 1) { $CmdArgs[1..($CmdArgs.Count - 1)] } else { @() }

if ($cmd -eq 'install') {
  & $pm install @rest
}
elseif ($rest.Count -gt 0) {
  # script へ追加引数を渡す場合は `--` で区切る(pnpm/npm 共通)。
  & $pm run $cmd -- @rest
}
else {
  & $pm run $cmd
}
exit $LASTEXITCODE
