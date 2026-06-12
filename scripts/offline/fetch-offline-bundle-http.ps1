#requires -Version 5.1
<#
.SYNOPSIS
  GitHub Releases の重量物を「gh CLI 不要」で HTTPS 直取得し、リポジトリ直下へ展開する。

.DESCRIPTION
  git も GitHub CLI も無い端末向けの取得スクリプト。リポジトリを一時的に Public 公開した
  状態を前提に、Release アセットの直 URL から匿名でダウンロードする（認証不要）。
  既存 fetch-offline-bundle.ps1 の gh 依存を排し、curl.exe（無ければ Invoke-WebRequest）で取得する。

  処理: offline-deps-bundle.tar.gz / .sha256 / bundle.key をダウンロード
        → sha256 検証 → lockfile 整合チェック（bundle.key 比較）
        → リポジトリ直下へ展開（.pnpm-store / pnpm.tgz / ms-playwright）。
  展開後に setup-offline.bat を実行すると完全オフラインで環境構築できる。

  前提: リポジトリが Public（取得中のみ）。tar（Windows 10/11 標準）。Node.js 24+（setup 用）。

.PARAMETER Owner
  GitHub オーナー名。既定 koichi-araki-0801。

.PARAMETER Repo
  リポジトリ名。既定 workspace。

.PARAMETER Tag
  取得元のローリングタグ。既定 offline-bundle-v1。

.PARAMETER RunSetup
  展開後に setup-offline.bat を自動実行する。

.EXAMPLE
  pwsh -File scripts/offline/fetch-offline-bundle-http.ps1 -RunSetup
#>
[CmdletBinding()]
param(
  [string]$Owner = 'koichi-araki-0801',
  [string]$Repo  = 'workspace',
  [string]$Tag   = 'offline-bundle-v1',
  [switch]$RunSetup
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Set-Location $RepoRoot
Write-Host "[info] repo root: $RepoRoot"

if (-not (Get-Command 'tar' -ErrorAction SilentlyContinue)) {
  Write-Error '[error] tar が見つかりません（Windows 10/11 標準の tar.exe が必要）。'; exit 1
}

$BundleName = 'offline-deps-bundle.tar.gz'
$Bundle     = Join-Path $RepoRoot $BundleName
$Sha        = "$Bundle.sha256"
$KeyFile    = Join-Path $RepoRoot 'bundle.key'
$BaseUrl    = "https://github.com/$Owner/$Repo/releases/download/$Tag"

# curl.exe があればストリーミングDL（455MB を効率取得）、無ければ Invoke-WebRequest にフォールバック
$curl = Get-Command 'curl.exe' -ErrorAction SilentlyContinue
function Download-File([string]$url, [string]$dest) {
  Write-Host "       <- $url"
  if ($curl) {
    & $curl.Source -L --fail --retry 3 -o $dest $url
    if ($LASTEXITCODE -ne 0) { throw "ダウンロードに失敗: $url" }
  } else {
    $old = $ProgressPreference
    $ProgressPreference = 'SilentlyContinue'   # PS5.1 の進捗描画は大容量で極端に遅い
    try { Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing }
    finally { $ProgressPreference = $old }
  }
}

Write-Host "[1/4] Release $Tag から重量物を HTTPS 直取得（gh 不要）..."
try {
  Download-File "$BaseUrl/$BundleName"        $Bundle
  Download-File "$BaseUrl/$BundleName.sha256" $Sha
  Download-File "$BaseUrl/bundle.key"         $KeyFile
} catch {
  Write-Error "[error] $($_.Exception.Message)`n  リポジトリが Public 公開中か、タグ/ネットワークを確認してください。"; exit 1
}
if (-not (Test-Path $Bundle)) { Write-Error "[error] $BundleName が取得できませんでした。"; exit 1 }

Write-Host '[2/4] sha256 で整合性検証...'
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

Write-Host '[3/4] lockfile 整合チェック（コードのブランチとバンドルが対応するか）...'
$LockFile = Join-Path $RepoRoot 'pnpm-lock.yaml'
$PkgJson  = Join-Path $RepoRoot 'package.json'
if ((Test-Path $KeyFile) -and (Test-Path $LockFile) -and (Test-Path $PkgJson)) {
  # publish-offline-bundle.ps1 の Get-ContentKey と同一ロジック
  $pkg = Get-Content $PkgJson -Raw | ConvertFrom-Json
  $packageManager = [string]$pkg.packageManager
  $lockBytes = [System.IO.File]::ReadAllBytes($LockFile)
  $pmBytes   = [System.Text.Encoding]::UTF8.GetBytes($packageManager)
  $all = New-Object byte[] ($lockBytes.Length + $pmBytes.Length)
  [System.Array]::Copy($lockBytes, 0, $all, 0, $lockBytes.Length)
  [System.Array]::Copy($pmBytes, 0, $all, $lockBytes.Length, $pmBytes.Length)
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try { $localKey = (($sha.ComputeHash($all) | ForEach-Object { $_.ToString('x2') }) -join '') }
  finally { $sha.Dispose() }
  $publishedKey = (Get-Content $KeyFile -Raw).Trim().ToLower()
  if ($localKey -eq $publishedKey) {
    Write-Host "[info] lockfile key 一致: $localKey"
  } else {
    Write-Warning "[warn] lockfile 不整合の可能性。コードのブランチとバンドルが対応していません。`n  code (local) : $localKey`n  bundle.key   : $publishedKey`n  → setup-offline.bat の --frozen-lockfile が失敗する場合は、バンドルに対応するブランチの ZIP を取得し直してください。"
  }
} else {
  Write-Warning '[warn] bundle.key / pnpm-lock.yaml / package.json のいずれかが無く、lockfile 整合チェックをスキップします。'
}

Write-Host '[4/4] リポジトリ直下へ展開（.pnpm-store / pnpm.tgz / ms-playwright）...'
& tar -xzf $Bundle -C $RepoRoot
if ($LASTEXITCODE -ne 0) { Write-Error '[error] 展開に失敗しました。'; exit 1 }

foreach ($p in @('.pnpm-store', 'pnpm.tgz', 'ms-playwright')) {
  if (-not (Test-Path (Join-Path $RepoRoot $p))) { Write-Error "[error] 展開後に $p が見つかりません。バンドルが不完全です。"; exit 1 }
}

Write-Host '[OK] 重量物を展開しました。'
if ($RunSetup) {
  Write-Host '[info] setup-offline.bat を実行します...'
  & (Join-Path $RepoRoot 'setup-offline.bat')
} else {
  Write-Host '  次に setup-offline.bat を実行してください（依存復元・ビルド・Playwright 配置）。'
}
