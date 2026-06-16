#requires -Version 5.1
<#
.SYNOPSIS
  オフライン重量物（.pnpm-store / pnpm.tgz / ms-playwright）と「ソースコード」を GitHub Releases へ公開する。

.DESCRIPTION
  方針: コードは git 履歴で管理し、node_modules 相当の重量物（約1.2GB）は git に入れず
  GitHub Releases に置く。

  公開のたびに次を行う:
    A) ソース更新: ローリングタグを現在の HEAD へ移動し、GitHub が自動添付する
       ``Source code (zip/tar.gz)`` を最新コミットのツリーへ更新する（常に実行）。
    B) 重量物更新: 変更検知キーに差分がある時だけ重量物を再生成・再アップロードする（冪等）。

  変更検知キー = sha256( pnpm-lock.yaml の内容 ‖ package.json の packageManager 文字列 )。
  .pnpm-store は pnpm-lock.yaml が、pnpm.tgz は packageManager が、ms-playwright は
  lockfile 内に解決された @playwright/test 版（=chromium revision）が、それぞれ規定する。
  よってこの1キーで3点すべての変化を覆える。Release 側に bundle.key（このハッシュ）を保存し、
  現在キーと一致したら重量物は据え置く（タグ移動と説明更新のみ）。

  → コミット毎フック（.husky/post-commit）から呼ぶことで「ソースは毎コミット更新、
     重量物は lockfile 等が変わった時だけ更新」が自動で成立する。

.PARAMETER Tag
  公開先のローリングタグ。既定 offline-bundle-v1。

.PARAMETER Force
  変更検知を無視して常に重量物を再生成・再アップロードする。

.PARAMETER SkipRegen
  重量物の再生成（pnpm install / corepack pack / playwright install）を省略し、
  既存のディスク上の成果物をそのまま固めてアップロードする（重量物更新が必要な場合のみ有効）。

.EXAMPLE
  pwsh -File offline/publish-offline-bundle.ps1
#>
[CmdletBinding()]
param(
  [string]$Tag = 'offline-bundle-v1',
  [switch]$Force,
  [switch]$SkipRegen
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ---- リポジトリルートへ（offline/ の親） ----
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $RepoRoot
Write-Host "[info] repo root: $RepoRoot"

$LockFile = Join-Path $RepoRoot 'pnpm-lock.yaml'
$PkgJson  = Join-Path $RepoRoot 'package.json'
foreach ($f in @($LockFile, $PkgJson)) {
  if (-not (Test-Path $f)) { Write-Error "[error] 必須ファイルが見つかりません: $f"; exit 1 }
}

function Require-Cmd([string]$name) {
  if (-not (Get-Command $name -ErrorAction SilentlyContinue)) {
    Write-Error "[error] '$name' が見つかりません。インストール/認証を確認してください。"; exit 1
  }
}
Require-Cmd 'gh'
Require-Cmd 'git'

# ---- packageManager とキー ----
$pkg = Get-Content $PkgJson -Raw | ConvertFrom-Json
$packageManager = [string]$pkg.packageManager           # 例: pnpm@11.5.3+sha512...
if ([string]::IsNullOrWhiteSpace($packageManager)) {
  Write-Error '[error] package.json に packageManager がありません。'; exit 1
}
if ($packageManager -notmatch '^pnpm@([0-9]+\.[0-9]+\.[0-9]+)') {
  Write-Error "[error] packageManager の形式が想定外: $packageManager"; exit 1
}
$pnpmVersion = $Matches[1]
Write-Host "[info] pnpm version: $pnpmVersion"

function Get-ContentKey {
  $lockBytes = [System.IO.File]::ReadAllBytes($LockFile)
  $pmBytes   = [System.Text.Encoding]::UTF8.GetBytes($packageManager)
  $all = New-Object byte[] ($lockBytes.Length + $pmBytes.Length)
  [System.Array]::Copy($lockBytes, 0, $all, 0, $lockBytes.Length)
  [System.Array]::Copy($pmBytes, 0, $all, $lockBytes.Length, $pmBytes.Length)
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try { ($sha.ComputeHash($all) | ForEach-Object { $_.ToString('x2') }) -join '' }
  finally { $sha.Dispose() }
}
$currentKey = Get-ContentKey
Write-Host "[info] current content key: $currentKey"

# ---- 公開済みキー・Release 有無の取得 ----
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("offline-bundle-" + [System.Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp -Force | Out-Null
$publishedKey = ''
$releaseExists = $false
try {
  gh release view $Tag *> $null
  if ($LASTEXITCODE -eq 0) {
    $releaseExists = $true
    gh release download $Tag --pattern 'bundle.key' --dir $tmp --clobber *> $null
    $kf = Join-Path $tmp 'bundle.key'
    if (Test-Path $kf) { $publishedKey = (Get-Content $kf -Raw).Trim() }
  }
} catch { }
Write-Host "[info] published key: $(if ($publishedKey) { $publishedKey } else { '(none)' })"

# 重量物を更新するか: 強制 / Release 未作成（初回）/ キー不一致 のいずれか。
# 一致時はソース更新（タグ移動＋説明更新）だけ行い、重量物の再生成・再アップロードは省く。
$bundleChanged = $Force -or (-not $releaseExists) -or ($publishedKey -ne $currentKey)
if ($bundleChanged) {
  Write-Host '[info] 重量物を更新します（-Force / 初回 / 変更検知）。'
} else {
  Write-Host '[info] 重量物は最新の Release と一致。ソース（タグ）のみ更新します。'
}

# ---- 重量物の生成（更新が必要な場合のみ） ----
$Store      = Join-Path $RepoRoot '.pnpm-store'
$PnpmTgz    = Join-Path $RepoRoot 'pnpm.tgz'
$MsPw       = Join-Path $RepoRoot 'ms-playwright'
$BundleName = 'offline-deps-bundle.tar.gz'
$Bundle     = Join-Path $RepoRoot $BundleName
$Sha        = "$Bundle.sha256"
$KeyFile    = Join-Path $RepoRoot 'bundle.key'
$sizeMB     = $null

if ($bundleChanged) {
  if (-not $SkipRegen) {
    Require-Cmd 'corepack'
    Require-Cmd 'tar'

    Write-Host '[1/3] 依存を同梱ストアへ充填（corepack pnpm install --frozen-lockfile）...'
    $env:COREPACK_ENABLE_DOWNLOAD_PROMPT = '0'
    & corepack pnpm install --frozen-lockfile --store-dir $Store
    if ($LASTEXITCODE -ne 0) { Write-Error '[error] pnpm install に失敗しました。'; exit 1 }

    Write-Host "[2/3] pnpm 本体 tarball を取得（corepack pack pnpm@$pnpmVersion）..."
    # setup-offline.ps1 は `corepack install -g pnpm.tgz` で pnpm を復元するため、
    # corepack pack 形式（pnpm/<ver>/... ＋ .corepack マーカー）で固める必要がある。
    # npm pack 形式（package/... 始まり）は corepack install が拒否する
    # （Invalid archive format; did it get generated by 'corepack pack'?）。
    Get-ChildItem $RepoRoot -Filter 'pnpm-*.tgz' -File -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
    Remove-Item $PnpmTgz -Force -ErrorAction SilentlyContinue
    & corepack pack --output $PnpmTgz "pnpm@$pnpmVersion"
    if ($LASTEXITCODE -ne 0) { Write-Error '[error] corepack pack pnpm に失敗しました。'; exit 1 }
    if (-not (Test-Path $PnpmTgz)) { Write-Error '[error] pnpm.tgz が生成されませんでした。'; exit 1 }

    Write-Host '[3/3] Playwright Chromium を ms-playwright へ配置...'
    $env:PLAYWRIGHT_BROWSERS_PATH = $MsPw
    & corepack pnpm exec playwright install chromium
    if ($LASTEXITCODE -ne 0) { Write-Error '[error] playwright install に失敗しました。'; exit 1 }
  } else {
    Write-Host '[info] -SkipRegen: 既存のディスク上の重量物をそのまま固めます。'
    Require-Cmd 'tar'
  }

  foreach ($p in @($Store, $PnpmTgz, $MsPw)) {
    if (-not (Test-Path $p)) { Write-Error "[error] 重量物が見つかりません: $p（-SkipRegen 指定時は事前生成が必要）"; exit 1 }
  }

  # ---- パッケージング（重量物のみ。ソースは含めない） ----
  Write-Host "[info] tar -czf $BundleName .pnpm-store pnpm.tgz ms-playwright ..."
  Remove-Item $Bundle -Force -ErrorAction SilentlyContinue
  & tar -czf $Bundle -C $RepoRoot '.pnpm-store' 'pnpm.tgz' 'ms-playwright'
  if ($LASTEXITCODE -ne 0) { Write-Error '[error] tar に失敗しました。'; exit 1 }

  $sizeMB = [math]::Round((Get-Item $Bundle).Length / 1MB, 1)
  Write-Host "[info] bundle size: ${sizeMB}MB"
  if ((Get-Item $Bundle).Length -ge 2GB) {
    Write-Error '[error] アセットが 2GB（Release 上限）を超えました。分割が必要です。'; exit 1
  }

  # 整合性ハッシュとキーを書き出し
  $bundleHash = (Get-FileHash $Bundle -Algorithm SHA256).Hash.ToLower()
  "$bundleHash  $BundleName" | Set-Content -Path $Sha -Encoding ascii -NoNewline
  $currentKey | Set-Content -Path $KeyFile -Encoding ascii -NoNewline
}

# ---- Release 説明（notes） ----
$notes = @"
別端末（Windows x64）でネット不要に環境構築するための **重量物（node_modules 相当）** バンドル。
本 Release のタグは公開のたびに最新コミットへ移動するため、GitHub が自動添付する
``Source code (zip/tar.gz)`` は**最新のソースコード**と一致します（取得は offline/setup-offline.bat が自動化）。

## 同梱（重量物のみ）
- .pnpm-store … 依存オフラインストア（content-addressable）
- pnpm.tgz … pnpm $pnpmVersion 本体（corepack 用）
- ms-playwright … Chromium（E2E 用）

## 取得手順（別端末・gh 不要）
1. 取得中のみリポジトリを Public にする
2. この offline/ フォルダ一式を別端末へ配置
3. ``offline\setup-offline.bat`` を実行（ソース＋重量物を自動取得・展開・構築）

## 変更管理
content key (sha256 of pnpm-lock.yaml + packageManager): ``$currentKey``
重量物に変更が無い限り再アップロードされません（``publish-offline-bundle.ps1`` が自動判定）。
ソース（自動 Source code）はコミット毎にタグ移動で更新されます。
"@
$notesFile = Join-Path $tmp 'notes.md'
$notes | Set-Content -Path $notesFile -Encoding utf8

# ---- ローリングタグを公開コミットへ移動（常に＝ソース更新） ----
# GitHub は公開リリースのタグに Source code (zip/tar.gz) を必ず自動添付し、これは削除できない。
# そこでタグを最新コミットへ動かし、自動 Source code を最新ソースに揃える。
$targetCommit = (& git rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($targetCommit)) {
  Write-Error '[error] git HEAD を取得できません。git リポジトリ内で実行してください。'; exit 1
}
Write-Host "[info] タグ $Tag を $targetCommit へ移動します（自動 Source code を最新ソースへ）..."
# `+` で強制更新。既存リリースはタグ名で紐づくため、タグが動いてもリリースは維持され
# 自動 Source code だけが新コミットのツリーから再生成される。新規時はこの push でリモートタグを作る。
& git push origin "+${targetCommit}:refs/tags/$Tag"
if ($LASTEXITCODE -ne 0) { Write-Error '[error] タグの移動 (git push) に失敗しました。'; exit 1 }

# ---- Release 作成/更新 ----
if (-not $releaseExists) {
  Write-Host "[info] Release $Tag を新規作成します。"
  & gh release create $Tag --title "Offline deps bundle ($Tag)" --notes-file $notesFile
  if ($LASTEXITCODE -ne 0) { Write-Error '[error] gh release create に失敗しました。'; exit 1 }
} else {
  Write-Host "[info] Release $Tag の説明を更新します。"
  & gh release edit $Tag --notes-file $notesFile | Out-Null
}

# ---- アセットのアップロード（重量物更新時のみ） ----
if ($bundleChanged) {
  Write-Host '[info] アセットをアップロード（--clobber で差し替え）...'
  & gh release upload $Tag $Bundle $Sha $KeyFile --clobber
  if ($LASTEXITCODE -ne 0) { Write-Error '[error] gh release upload に失敗しました。'; exit 1 }
}

Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
if ($bundleChanged) {
  Write-Host "[OK] 公開完了: $Tag に $BundleName (${sizeMB}MB) / $BundleName.sha256 / bundle.key を反映し、タグを最新ソースへ移動しました。"
} else {
  Write-Host "[OK] ソースのみ更新: タグ $Tag を最新コミットへ移動しました（重量物は据え置き）。"
}
