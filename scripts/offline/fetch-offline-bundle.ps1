#requires -Version 5.1
<#
.SYNOPSIS
  GitHub Releases からオフライン重量物を取得し、リポジトリ直下へ展開する。

.DESCRIPTION
  別端末（Windows x64・GitHub 到達可）で実行する取得スクリプト。
  publish-offline-bundle.ps1 が公開した offline-deps-bundle.tar.gz を
  ダウンロード → sha256 検証 → リポジトリ直下へ展開（.pnpm-store / pnpm.tgz / ms-playwright）する。

  前提: gh CLI が認証済み（private repo のため `gh auth login` が必要）。
  展開後に setup-offline.bat を実行すると完全オフラインで環境構築できる。

.PARAMETER Tag
  取得元のローリングタグ。既定 offline-bundle-v1。

.PARAMETER RunSetup
  展開後に setup-offline.bat を自動実行する。

.EXAMPLE
  pwsh -File scripts/offline/fetch-offline-bundle.ps1 -RunSetup
#>
[CmdletBinding()]
param(
  [string]$Tag = 'offline-bundle-v1',
  [switch]$RunSetup
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Set-Location $RepoRoot
Write-Host "[info] repo root: $RepoRoot"

if (-not (Get-Command 'gh' -ErrorAction SilentlyContinue)) {
  Write-Error '[error] gh CLI が見つかりません。https://cli.github.com/ からインストールし `gh auth login` してください。'; exit 1
}
if (-not (Get-Command 'tar' -ErrorAction SilentlyContinue)) {
  Write-Error '[error] tar が見つかりません（Windows 10/11 標準の tar.exe が必要）。'; exit 1
}

$BundleName = 'offline-deps-bundle.tar.gz'
$Bundle     = Join-Path $RepoRoot $BundleName
$Sha        = "$Bundle.sha256"

Write-Host "[1/3] Release $Tag から重量物をダウンロード..."
& gh release download $Tag --pattern "$BundleName" --pattern "$BundleName.sha256" --dir $RepoRoot --clobber
if ($LASTEXITCODE -ne 0) { Write-Error "[error] ダウンロードに失敗しました（タグ/認証/ネットワークを確認）。"; exit 1 }
if (-not (Test-Path $Bundle)) { Write-Error "[error] $BundleName が取得できませんでした。"; exit 1 }

Write-Host '[2/3] sha256 で整合性検証...'
if (Test-Path $Sha) {
  $expected = ((Get-Content $Sha -Raw).Trim() -split '\s+')[0].ToLower()
  $actual   = (Get-FileHash $Bundle -Algorithm SHA256).Hash.ToLower()
  if ($expected -ne $actual) {
    Write-Error "[error] sha256 不一致。ダウンロード破損の可能性。`n  expected: $expected`n  actual:   $actual"; exit 1
  }
  Write-Host "[info] sha256 OK: $actual"
} else {
  Write-Warning '[warn] .sha256 が見つかりません。整合性検証をスキップします。'
}

Write-Host '[3/3] リポジトリ直下へ展開（.pnpm-store / pnpm.tgz / ms-playwright）...'
& tar -xzf $Bundle -C $RepoRoot
if ($LASTEXITCODE -ne 0) { Write-Error '[error] 展開に失敗しました。'; exit 1 }

foreach ($p in @('.pnpm-store', 'pnpm.tgz', 'ms-playwright')) {
  if (-not (Test-Path (Join-Path $RepoRoot $p))) { Write-Error "[error] 展開後に $p が見つかりません。バンドルが不完全です。"; exit 1 }
}

Write-Host "[OK] 重量物を展開しました。"
if ($RunSetup) {
  Write-Host '[info] setup-offline.bat を実行します...'
  & (Join-Path $RepoRoot 'setup-offline.bat')
} else {
  Write-Host '  次に setup-offline.bat を実行してください（依存復元・ビルド・Playwright 配置）。'
}
