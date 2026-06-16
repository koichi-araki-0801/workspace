#requires -Version 5.1
<#
.SYNOPSIS
  別端末（Windows x64）で、ソースコードと重量物を GitHub Releases から「gh CLI 不要」で
  自動取得し、完全オフライン動作する開発環境を一括構築する（スタンドアロン・ブートストラップ）。

.DESCRIPTION
  この offline/ フォルダ一式だけを別端末へ配置して実行すれば、以下を全自動で行う:
    1. ソース ZIP を HTTPS 直取得（tag アーカイブ）→ 親（リポジトリ直下）へ展開（offline/ 自身は除外）
    2. 重量物バンドル（.pnpm-store / pnpm.tgz / ms-playwright）を HTTPS 直取得 → sha256 検証
       → lockfile 整合チェック（bundle.key 比較）→ 直下へ展開
    3. 同梱 pnpm を corepack 登録 → 依存をオフライン install → ビルド → Playwright を配置
    4. ダウンロードしたアーカイブ群を bk/ へ退避（同名があれば削除してから移動）

  従来の fetch-offline-bundle.ps1 / fetch-offline-bundle-http.ps1 / setup-offline.bat（2段運用）を
  本スクリプト 1 本へ統合したもの。取得は HTTPS 直のみ（gh 不要）。

  前提: 取得中のみリポジトリが Public。tar（Windows 10/11 標準）。Node.js 24+（corepack 同梱）。

.PARAMETER Owner
  GitHub オーナー名。既定 koichi-araki-0801。

.PARAMETER Repo
  リポジトリ名。既定 workspace。

.PARAMETER Tag
  取得元のローリングタグ。既定 offline-bundle-v1。

.PARAMETER SkipBuild
  取得・展開のみ行い、依存 install / build / Playwright 配置を省略する。

.EXAMPLE
  pwsh -File offline/setup-offline.ps1
#>
[CmdletBinding()]
param(
  [string]$Owner = 'koichi-araki-0801',
  [string]$Repo  = 'workspace',
  [string]$Tag   = 'offline-bundle-v1',
  [switch]$SkipBuild
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# offline/ の親をリポジトリ直下（ROOT）とみなす。スタンドアロン時はここへソースを展開する。
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Write-Host "[info] repo root: $RepoRoot"

# tar は Windows 標準（System32\tar.exe = BSD tar）を明示優先する。
# Git Bash 等の MSYS tar が PATH 先頭にあると、`-C C:\...` を rsh の host:path と誤認し
# 「Cannot connect to C:」で失敗するため（フックは sh 経由で起動され PATH が混ざりうる）。
function Resolve-Tar {
  $sys = Join-Path $env:SystemRoot 'System32\tar.exe'
  if (Test-Path $sys) { return $sys }
  $c = Get-Command 'tar.exe' -ErrorAction SilentlyContinue
  if ($c) { return $c.Source }
  $c = Get-Command 'tar' -ErrorAction SilentlyContinue
  if ($c) { return $c.Source }
  Write-Error '[error] tar が見つかりません（Windows 10/11 標準の tar.exe が必要）。'; exit 1
}
$TarExe = Resolve-Tar

$BundleName = 'offline-deps-bundle.tar.gz'
$Bundle     = Join-Path $RepoRoot $BundleName
$Sha        = "$Bundle.sha256"
$KeyFile    = Join-Path $RepoRoot 'bundle.key'
$AssetBase  = "https://github.com/$Owner/$Repo/releases/download/$Tag"
$SrcZipUrl  = "https://github.com/$Owner/$Repo/archive/refs/tags/$Tag.zip"

# 作業用 temp（ソース ZIP の DL・展開先）
$Work   = Join-Path ([System.IO.Path]::GetTempPath()) ("offline-setup-" + [System.Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $Work -Force | Out-Null
$SrcZip = Join-Path $Work "$Repo-$Tag-source.zip"

# curl.exe があればストリーミングDL（大容量を効率取得）、無ければ Invoke-WebRequest にフォールバック
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

# ---- [1/6] ソース ZIP を HTTPS 直取得（gh 不要） ----
Write-Host "[1/6] ソースコードを Release tag $Tag から HTTPS 直取得（gh 不要）..."
try {
  Download-File $SrcZipUrl $SrcZip
} catch {
  Write-Error "[error] $($_.Exception.Message)`n  リポジトリが Public 公開中か、タグ/ネットワークを確認してください。"; exit 1
}

# ---- [2/6] ソースを ROOT へ展開（offline/ 自身は上書きしない） ----
Write-Host '[2/6] ソースをリポジトリ直下へ展開（offline/ は除外）...'
$ExtractDir = Join-Path $Work 'src'
New-Item -ItemType Directory -Path $ExtractDir -Force | Out-Null
Expand-Archive -Path $SrcZip -DestinationPath $ExtractDir -Force
# GitHub の tag アーカイブは "<repo>-<tag>/" を 1 段かませる。その単一トップフォルダを取る。
$inner = Get-ChildItem -Path $ExtractDir -Directory | Select-Object -First 1
if (-not $inner) { Write-Error '[error] ソース ZIP の展開結果が想定外です（トップフォルダなし）。'; exit 1 }
foreach ($item in Get-ChildItem -LiteralPath $inner.FullName -Force) {
  # 実行中の offline/（このスクリプト自身を含む）は上書きしない。中身は同一なので除外で問題なし。
  if ($item.Name -ieq 'offline') { continue }
  Copy-Item -LiteralPath $item.FullName -Destination $RepoRoot -Recurse -Force
}

# ---- [3/6] 重量物バンドルを HTTPS 直取得 ----
Write-Host "[3/6] 重量物バンドルを Release $Tag から HTTPS 直取得..."
try {
  Download-File "$AssetBase/$BundleName"        $Bundle
  Download-File "$AssetBase/$BundleName.sha256" $Sha
  Download-File "$AssetBase/bundle.key"         $KeyFile
} catch {
  Write-Error "[error] $($_.Exception.Message)`n  リポジトリが Public 公開中か、タグ/ネットワークを確認してください。"; exit 1
}
if (-not (Test-Path $Bundle)) { Write-Error "[error] $BundleName が取得できませんでした。"; exit 1 }

# sha256 検証
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

# lockfile 整合チェック（ソースのブランチとバンドルが対応するか）
$LockFile = Join-Path $RepoRoot 'pnpm-lock.yaml'
$PkgJson  = Join-Path $RepoRoot 'package.json'
if ((Test-Path $KeyFile) -and (Test-Path $LockFile) -and (Test-Path $PkgJson)) {
  # publish-offline-bundle.ps1 の Get-ContentKey と同一ロジック。
  # 行末非依存にするため CR(0x0D) を除去して LF 正規化してから測る
  # （Windows working tree=CRLF と GitHub アーカイブ=LF の差を吸収）。
  $pkg = Get-Content $PkgJson -Raw | ConvertFrom-Json
  $packageManager = [string]$pkg.packageManager
  $rawLock = [System.IO.File]::ReadAllBytes($LockFile)
  $lb = New-Object System.Collections.Generic.List[byte] ($rawLock.Length)
  foreach ($x in $rawLock) { if ($x -ne 13) { $lb.Add($x) } }
  $lockBytes = $lb.ToArray()
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
    Write-Warning "[warn] lockfile 不整合の可能性。ソースとバンドルが対応していません。`n  code (local) : $localKey`n  bundle.key   : $publishedKey`n  → --frozen-lockfile が失敗する場合はタグを揃えて取り直してください。"
  }
} else {
  Write-Warning '[warn] bundle.key / pnpm-lock.yaml / package.json のいずれかが無く、lockfile 整合チェックをスキップします。'
}

# ---- [4/6] 重量物を ROOT へ展開 ----
Write-Host '[4/6] 重量物を直下へ展開（.pnpm-store / pnpm.tgz / ms-playwright）...'
& $TarExe -xzf $Bundle -C $RepoRoot
if ($LASTEXITCODE -ne 0) { Write-Error '[error] 展開に失敗しました。'; exit 1 }
foreach ($p in @('.pnpm-store', 'pnpm.tgz', 'ms-playwright')) {
  if (-not (Test-Path (Join-Path $RepoRoot $p))) { Write-Error "[error] 展開後に $p が見つかりません。バンドルが不完全です。"; exit 1 }
}

# ---- [5/6] オフライン環境構築 ----
if (-not $SkipBuild) {
  if (-not (Get-Command 'corepack' -ErrorAction SilentlyContinue)) {
    Write-Error '[error] corepack が見つかりません。Node.js 24+ をインストールしてください。'; exit 1
  }
  $env:COREPACK_ENABLE_DOWNLOAD_PROMPT = '0'   # 同梱 pnpm を使う。DL プロンプト抑止
  $env:CI = 'true'                             # 対話確認の抑止
  Push-Location $RepoRoot
  try {
    Write-Host '[5/6] 環境構築: 同梱 pnpm を corepack 登録 → クリーン → オフライン install → build → Playwright 配置...'

    & corepack install -g (Join-Path $RepoRoot 'pnpm.tgz')
    if ($LASTEXITCODE -ne 0) { Write-Error '[error] corepack install に失敗しました（Node.js 24+ を確認）。'; exit 1 }

    # node_modules / dist を一掃し、毎回ストアからクリーンインストール（重量物は温存）。
    $purge = @(
      'node_modules',
      'editor\shared\node_modules', 'editor\server\node_modules', 'editor\web\node_modules',
      'graph2\node_modules', 'graph-editor\node_modules',
      'editor\shared\dist', 'editor\server\dist', 'editor\web\dist'
    )
    foreach ($d in $purge) {
      $full = Join-Path $RepoRoot $d
      if (Test-Path $full) { Remove-Item -LiteralPath $full -Recurse -Force -ErrorAction SilentlyContinue }
    }
    $tsbi = Join-Path $RepoRoot 'editor\web\tsconfig.tsbuildinfo'
    if (Test-Path $tsbi) { Remove-Item -LiteralPath $tsbi -Force -ErrorAction SilentlyContinue }

    & corepack pnpm install --offline --frozen-lockfile --store-dir (Join-Path $RepoRoot '.pnpm-store')
    if ($LASTEXITCODE -ne 0) { Write-Error '[error] オフライン install に失敗しました。'; exit 1 }

    & corepack pnpm build
    if ($LASTEXITCODE -ne 0) { Write-Error '[error] build に失敗しました。'; exit 1 }

    # %LOCALAPPDATA% はユーザー毎に解決されるため、ユーザー名が違っても Playwright が発見できる。
    $msSrc = Join-Path $RepoRoot 'ms-playwright'
    $msDst = Join-Path $env:LOCALAPPDATA 'ms-playwright'
    if (Test-Path $msSrc) {
      & xcopy /E /I /Y /Q $msSrc $msDst | Out-Null
      if ($LASTEXITCODE -ne 0) {
        Write-Warning "[warn] ms-playwright のコピーに失敗。E2E 時は $msSrc を $msDst へ手動コピーしてください。"
      } else {
        Write-Host "       -> $msDst"
      }
    }
  } finally { Pop-Location }
} else {
  Write-Host '[5/6] -SkipBuild: 取得・展開のみ。環境構築をスキップしました。'
}

# ---- [6/6] ダウンロードしたアーカイブを bk/ へ退避（同名は削除してから移動） ----
Write-Host '[6/6] ダウンロード物を bk/ へ退避（同名があれば削除してから移動）...'
$Bk = Join-Path $RepoRoot 'bk'
New-Item -ItemType Directory -Path $Bk -Force | Out-Null
function Move-ToBk([string]$src) {
  if (-not (Test-Path -LiteralPath $src)) { return }
  $dst = Join-Path $Bk (Split-Path $src -Leaf)
  if (Test-Path -LiteralPath $dst) { Remove-Item -LiteralPath $dst -Recurse -Force -ErrorAction SilentlyContinue }
  # 一時的なファイルロック（AV スキャン等）に備え、軽くリトライしてから移す。
  for ($i = 1; $i -le 3; $i++) {
    try { Move-Item -LiteralPath $src -Destination $dst -Force; break }
    catch { if ($i -eq 3) { throw }; Start-Sleep -Milliseconds 400 }
  }
  Write-Host "       -> bk\$(Split-Path $src -Leaf)"
}
$toMove = @($SrcZip, $Bundle, $Sha, $KeyFile)   # ソースZIP(temp) + 直下のバンドル一式
foreach ($f in $toMove) { Move-ToBk $f }
# ダウンロード物が直下に残っていないことを保証（残れば 1 度だけ再退避を試みる）。
$leftover = $toMove | Where-Object { Test-Path -LiteralPath $_ }
if ($leftover) {
  Start-Sleep -Milliseconds 500
  foreach ($f in $leftover) { Move-ToBk $f }
  $leftover = $toMove | Where-Object { Test-Path -LiteralPath $_ }
  if ($leftover) { Write-Warning "[warn] bk へ退避できなかったファイルがあります: $($leftover -join ', ')" }
}

Remove-Item -LiteralPath $Work -Recurse -Force -ErrorAction SilentlyContinue

Write-Host ''
if ($SkipBuild) {
  Write-Host '[OK] 取得・展開完了（build はスキップ）。'
} else {
  Write-Host '[OK] セットアップ完了。'
  Write-Host '  - 型チェック: corepack pnpm typecheck'
  Write-Host '  - テスト:     corepack pnpm test'
  Write-Host '  - E2E:        corepack pnpm test:e2e'
  Write-Host '  - 開発サーバ: corepack pnpm dev'
  Write-Host '  ( corepack enable を一度実行すれば、以後は pnpm だけで実行可能 )'
  Write-Host ''
  Write-Host '  PDF 出力はシステムの Microsoft Edge を自動使用します（追加ブラウザ不要）。'
}
