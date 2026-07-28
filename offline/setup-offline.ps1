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

# 共通ライブラリ（content-key 算出 / tar 解決）。
. (Join-Path $PSScriptRoot 'lib\content-key.ps1')

# offline/ の親をリポジトリ直下（ROOT）とみなす。スタンドアロン時はここへソースを展開する。
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Write-Host "[info] repo root: $RepoRoot"

# tar 解決（System32\tar.exe 優先）は共通ライブラリの Resolve-Tar を使う。
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

# lockfile 整合チェックは展開後（[4/6] の後）に行う。content key の入力に
# git-tools\manifest.txt（バンドル同梱・gitignore 対象でソース ZIP に無い）が含まれるため、
# 展開前に測ると manifest を欠いて publish 側と必ずズレる。

# ---- [4/6] 重量物を ROOT へ展開 ----
Write-Host '[4/6] 重量物を直下へ展開（.pnpm-store / pnpm.tgz / ms-playwright / python-wheelhouse / git-tools）...'
& $TarExe -xzf $Bundle -C $RepoRoot
if ($LASTEXITCODE -ne 0) { Write-Error '[error] 展開に失敗しました。'; exit 1 }
foreach ($p in @('.pnpm-store', 'pnpm.tgz', 'ms-playwright', 'python-wheelhouse', 'git-tools',
    'docs\_build\vendor\mermaid.min.js', 'docs\_build\vendor\mermaid-layout-elk.min.js')) {
  if (-not (Test-Path (Join-Path $RepoRoot $p))) { Write-Error "[error] 展開後に $p が見つかりません。バンドルが不完全です。"; exit 1 }
}

# lockfile 整合チェック（展開後＝git-tools\manifest.txt が在る状態でソースとバンドルの対応を測る）
$LockFile = Join-Path $RepoRoot 'pnpm-lock.yaml'
$PkgJson  = Join-Path $RepoRoot 'package.json'
if ((Test-Path $KeyFile) -and (Test-Path $LockFile) -and (Test-Path $PkgJson)) {
  # content-key は publish 側と同一ロジック（共通ライブラリ Get-LockContentKey）。
  $packageManager = Get-PackageManagerString $PkgJson
  $localKey = Get-LockContentKey -LockFile $LockFile -PackageManager $packageManager
  $publishedKey = (Get-Content $KeyFile -Raw).Trim().ToLower()
  if ($localKey -eq $publishedKey) {
    Write-Host "[info] lockfile key 一致: $localKey"
  } else {
    Write-Warning "[warn] lockfile 不整合の可能性。ソースとバンドルが対応していません。`n  code (local) : $localKey`n  bundle.key   : $publishedKey`n  → --frozen-lockfile が失敗する場合はタグを揃えて取り直してください。"
  }
} else {
  Write-Warning '[warn] bundle.key / pnpm-lock.yaml / package.json のいずれかが無く、lockfile 整合チェックをスキップします。'
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
      'pie-chart\node_modules', 'graph-editor\node_modules',
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

# ---- git ツール（PortableGit / TortoiseGit）の展開・導入（任意・ベストエフォート） ----
# editor のテンプレ版管理は git CLI を使う。同梱 PortableGit を展開して PATH/GIT_BIN を通し、
# TortoiseGit（履歴/diff の GUI）を導入する。失敗しても全体は止めない。
$GitTools = Join-Path $RepoRoot 'git-tools'
if (Test-Path $GitTools) {
  Write-Host '[git] PortableGit / TortoiseGit を確認...'
  $pgDir = Join-Path $GitTools 'portablegit'
  $pgExe = Get-ChildItem $GitTools -Filter 'PortableGit-*-64-bit.7z.exe' -File -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if ($pgExe -and -not (Test-Path (Join-Path $pgDir 'cmd\git.exe'))) {
    Write-Host "[git] PortableGit を展開: $($pgExe.Name) -> portablegit\"
    & $pgExe.FullName "-o$pgDir" -y | Out-Null
  }
  $gitExe = Join-Path $pgDir 'cmd\git.exe'
  if (Test-Path $gitExe) {
    $cmdDir = Join-Path $pgDir 'cmd'
    if ($env:Path -notlike "*$cmdDir*") { $env:Path = "$cmdDir;$env:Path" }
    try {
      $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
      if ($userPath -notlike "*$cmdDir*") {
        [Environment]::SetEnvironmentVariable('Path', "$cmdDir;$userPath", 'User')
        Write-Host "[git] ユーザー PATH へ追加: $cmdDir（新しい端末から有効）"
      }
      [Environment]::SetEnvironmentVariable('GIT_BIN', $gitExe, 'User')
      Write-Host "[git] GIT_BIN を設定: $gitExe"
    } catch {
      Write-Warning "[git] ユーザー環境変数の設定に失敗。手動で $cmdDir を PATH へ加えてください。"
    }
    Write-Host "[git] git 利用可能: $(& $gitExe --version)"
  } else {
    Write-Warning '[git] PortableGit の git.exe が見つかりません（展開に失敗した可能性）。'
  }
  $tgMsi = Get-ChildItem $GitTools -Filter 'TortoiseGit-*-64bit.msi' -File -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if ($tgMsi) {
    Write-Host "[git] TortoiseGit を導入（任意・失敗しても続行）: $($tgMsi.Name)"
    try {
      $proc = Start-Process msiexec.exe `
        -ArgumentList @('/i', "`"$($tgMsi.FullName)`"", '/qn', '/norestart') -Wait -PassThru
      if ($proc.ExitCode -ne 0) {
        Write-Warning "[git] TortoiseGit の導入が未完了（ExitCode=$($proc.ExitCode)）。管理者権限で msi を実行してください。"
      } else {
        Write-Host '[git] TortoiseGit を導入しました。'
      }
    } catch {
      Write-Warning "[git] TortoiseGit の導入に失敗。手動で $($tgMsi.Name) を実行してください。"
    }
  }
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

# ソース ZIP（temp ディレクトリ側）を退避。
Move-ToBk $SrcZip

# 直下のダウンロード物は「実ディスクの列挙」で拾って退避する。
# 記憶した変数パスへの Test-Path はビルド直後の一時的なロック等で false を返すことがあり、
# 取りこぼしの原因になるため、Get-ChildItem の列挙結果（実体）を正として複数パスで掃き出す。
$names = @('offline-deps-bundle.tar.gz', 'offline-deps-bundle.tar.gz.sha256', 'bundle.key')
for ($pass = 1; $pass -le 3; $pass++) {
  $hits = Get-ChildItem -LiteralPath $RepoRoot -File -Force -ErrorAction SilentlyContinue |
    Where-Object { $names -contains $_.Name }
  if (-not $hits) { break }
  foreach ($fi in $hits) { Move-ToBk $fi.FullName }
  Start-Sleep -Milliseconds 300
}
$remain = Get-ChildItem -LiteralPath $RepoRoot -File -Force -ErrorAction SilentlyContinue |
  Where-Object { $names -contains $_.Name }
if ($remain) { Write-Warning "[warn] bk へ退避できなかったファイルがあります: $(($remain.Name) -join ', ')" }

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
