#requires -Version 5.1
<#
.SYNOPSIS
  git clone 済みのリポジトリに、オフライン重量物バンドルを展開して開発環境を構築する。

.DESCRIPTION
  重量物（.pnpm-store / pnpm.tgz / ms-playwright / python-wheelhouse / git-tools /
  docs の mermaid JS / native-prebuilds）は git に入れず GitHub Releases（タグ offline-bundle-v1）に
  置いてある。本スクリプトは次を 1 本で行う:
    1. バンドルの用意。リポジトリ直下または bk\ に offline-deps-bundle.tar.gz と bundle.key が
       同じ場所に揃っていればそれを使う（取得しない）。揃っていなければ Release から HTTPS で
       直取得する（gh 不要。リポジトリは Public）。取得は一時ディレクトリで行い、Release の
       .sha256 と突き合わせた検証が通ってからだけ直下へ移す（検証前・失敗した取得物を直下に残さない）。
    2. 展開 → bundle.key と手元の pnpm-lock.yaml / packageManager / requirements / manifest から
       算出する content-key の一致検査。不一致は「ソースと重量物が別の組」なので中止する
       （続けても pnpm install --offline が落ちるだけで、原因が見えにくくなる）。
    3. 同梱 pnpm を corepack 登録 → node_modules / dist を消してオフライン install → build →
       Playwright 配置 → msnodesqlv8 prebuild 配置 → PortableGit 展開。
    4. 取得物を bk\ へ退避する。

  ソースコードは取得しない（git clone が前提）。バンドルの真正性は検証しない: 配布担当だけが
  Release を更新でき、配布先は同じ所有者の Public リポジトリを clone している前提で受け入れる。
  content-key の不一致は改ざんではなく「依存を変えたのに publish していない」状態で、
  配布担当に local-only\offline-publish\publish-offline-bundle.bat の実行を依頼する。

.PARAMETER Owner
  GitHub オーナー名。既定 koichi-araki-0801。

.PARAMETER Repo
  リポジトリ名。既定 workspace。

.PARAMETER Tag
  重量物アセットの取得元タグ。既定 offline-bundle-v1。

.PARAMETER SkipBuild
  取得・展開・整合検査のみ行い、install / build / Playwright 配置を省略する。

.PARAMETER InstallTortoiseGit
  TortoiseGit の MSI を msiexec /qn（サイレント・昇格）で導入する。既定では導入しない。

.EXAMPLE
  offline\setup-offline.bat
.EXAMPLE
  offline\setup-offline.bat -SkipBuild
#>
[CmdletBinding()]
param(
  [string]$Owner = 'koichi-araki-0801',
  [string]$Repo  = 'workspace',
  [string]$Tag   = 'offline-bundle-v1',
  [switch]$SkipBuild,
  [switch]$InstallTortoiseGit
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'lib\content-key.ps1')
. (Join-Path $PSScriptRoot 'lib\verify.ps1')
. (Join-Path $PSScriptRoot 'lib\git-tools.ps1')

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Bk       = Join-Path $RepoRoot 'bk'
Write-Host "[info] repo root: $RepoRoot"
# ネットワークドライブ上では pnpm の symlink/hardlink 構成が成立しないため開始前に止める。
Assert-LocalRepoRoot -Path $RepoRoot

$TarExe     = Resolve-Tar
$BundleName = 'offline-deps-bundle.tar.gz'
$AssetBase  = "https://github.com/$Owner/$Repo/releases/download/$Tag"
$LockFile   = Join-Path $RepoRoot 'pnpm-lock.yaml'
$PkgJson    = Join-Path $RepoRoot 'package.json'
foreach ($f in @($LockFile, $PkgJson)) {
  if (-not (Test-Path -LiteralPath $f)) {
    Write-Error "[error] $f がありません。リポジトリを git clone した直下で実行してください。"; exit 1
  }
}

# リポジトリ直下 → bk\ の順で、バンドルと bundle.key が同じディレクトリに揃っている組だけを
# 使う（直下の新しいバンドルと bk\ の古い鍵のような取り違えを避ける）。
function Find-LocalBundlePair {
  foreach ($dir in @($RepoRoot, $Bk)) {
    $b = Join-Path $dir $BundleName
    $k = Join-Path $dir 'bundle.key'
    if ((Test-Path -LiteralPath $b) -and (Test-Path -LiteralPath $k)) {
      return @{ Bundle = $b; Key = $k }
    }
  }
  return $null
}

# curl.exe があればストリーミング DL、無ければ Invoke-WebRequest（PS5.1 の進捗描画は大容量で極端に遅い）。
$curl = Get-Command 'curl.exe' -ErrorAction SilentlyContinue
function Download-File([string]$url, [string]$dest) {
  Write-Host "       <- $url"
  if ($curl) {
    & $curl.Source -L --fail --retry 3 -o $dest $url
    if ($LASTEXITCODE -ne 0) { throw "ダウンロードに失敗: $url" }
  } else {
    $old = $ProgressPreference
    $ProgressPreference = 'SilentlyContinue'
    try { Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing }
    finally { $ProgressPreference = $old }
  }
}

# ---- [1/5] バンドルの用意（手元優先、無ければ Release から取得） ----
Write-Host '[1/5] バンドルを確認...'
$local = Find-LocalBundlePair
$downloaded = $false
if ($local) {
  $Bundle  = $local.Bundle
  $KeyFile = $local.Key
  Write-Host "[info] 手元のバンドルを使います: $Bundle"
} else {
  Write-Host "[info] 手元にバンドルが無いため Release $Tag から HTTPS で取得します..."
  # 取得はリポジトリ直下ではなく一時ディレクトリで行う。直下へ先に置くと、検証失敗で
  # スクリプトが止まった後もファイルが残り、次回実行が「手元のバンドルを使う」経路で
  # .sha256 検証を経ないままそれを使ってしまう。
  $Work     = Join-Path ([IO.Path]::GetTempPath()) ('offline-setup-' + [Guid]::NewGuid().ToString('N'))
  $WorkFile = Join-Path $Work $BundleName
  $WorkKey  = Join-Path $Work 'bundle.key'
  $WorkSha  = "$WorkFile.sha256"
  New-Item -ItemType Directory -Path $Work -Force | Out-Null
  try {
    Download-File "$AssetBase/$BundleName"        $WorkFile
    Download-File "$AssetBase/$BundleName.sha256" $WorkSha
    Download-File "$AssetBase/bundle.key"         $WorkKey
    # Release に並ぶ .sha256 で転送破損を検知する（形式: "<sha256>  <ファイル名>"）。
    $expected = ((Get-Content -LiteralPath $WorkSha -Raw).Trim() -split '\s+')[0]
    if (-not $expected -or $expected -notmatch '^[0-9a-fA-F]{64}$') {
      throw '.sha256 の形式が想定外です。'
    }
    Assert-FileSha256 -File $WorkFile -ExpectedSha256 $expected -Label 'bundle'
  } catch {
    Write-Error "[error] $($_.Exception.Message)`n  タグ / ネットワーク / リポジトリの公開状態を確認してください。"
    Remove-Item -LiteralPath $Work -Recurse -Force -ErrorAction SilentlyContinue
    exit 1
  }
  # 検証を通った取得物だけを直下へ移す。
  $Bundle  = Join-Path $RepoRoot $BundleName
  $KeyFile = Join-Path $RepoRoot 'bundle.key'
  Move-Item -LiteralPath $WorkFile -Destination $Bundle          -Force
  Move-Item -LiteralPath $WorkSha  -Destination "$Bundle.sha256" -Force
  Move-Item -LiteralPath $WorkKey  -Destination $KeyFile         -Force
  Remove-Item -LiteralPath $Work -Recurse -Force -ErrorAction SilentlyContinue
  $downloaded = $true
}

# ---- [2/5] 展開 ----
Write-Host '[2/5] 重量物を直下へ展開...'
& $TarExe -xzf $Bundle -C $RepoRoot
if ($LASTEXITCODE -ne 0) { Write-Error '[error] 展開に失敗しました。'; exit 1 }
foreach ($p in @('.pnpm-store', 'pnpm.tgz', 'ms-playwright', 'python-wheelhouse', 'git-tools',
    'docs\_build\vendor\mermaid.min.js', 'docs\_build\vendor\mermaid-layout-elk.min.js',
    'native-prebuilds\manifest.txt')) {
  if (-not (Test-Path (Join-Path $RepoRoot $p))) { Write-Error "[error] 展開後に $p が見つかりません。バンドルが不完全です。"; exit 1 }
}

# ---- [3/5] content-key の一致検査（展開後 = git-tools\manifest.txt が在る状態で測る） ----
# content-key の入力に git-tools\manifest.txt（バンドル同梱・git 管理外）が含まれるため、
# 展開前に測ると manifest を欠いて publish 側と必ずズレる。
Write-Host '[3/5] bundle.key と手元のソースの整合を検査...'
$packageManager = Get-PackageManagerString $PkgJson
$localKey = Get-LockContentKey -LockFile $LockFile -PackageManager $packageManager
$publishedKey = (Get-Content -LiteralPath $KeyFile -Raw).Trim().ToLower()
if ($localKey -ne $publishedKey) {
  Write-Error ("[error] ソースと重量物が対応していません。`n  code (local) : $localKey" +
    "`n  bundle.key   : $publishedKey`n  依存を変えたのに Release を更新していない可能性があります。" +
    "`n  配布担当に local-only\offline-publish\publish-offline-bundle.bat の実行を依頼するか、" +
    "`n  bundle.key に対応するコミットへ checkout し直してください。")
  exit 1
}
Write-Host "[info] content-key 一致: $localKey"

# ---- [4/5] オフライン環境構築 ----
if (-not $SkipBuild) {
  if (-not (Get-Command 'corepack' -ErrorAction SilentlyContinue)) {
    Write-Error '[error] corepack が見つかりません。Node.js 24+ をインストールしてください。'; exit 1
  }
  $env:COREPACK_ENABLE_DOWNLOAD_PROMPT = '0'   # 同梱 pnpm を使う。DL プロンプト抑止
  $env:CI = 'true'                             # 対話確認の抑止
  Push-Location $RepoRoot
  try {
    Write-Host '[4/5] 環境構築: 同梱 pnpm を corepack 登録 → クリーン → オフライン install → build → Playwright 配置...'

    & corepack install -g (Join-Path $RepoRoot 'pnpm.tgz')
    if ($LASTEXITCODE -ne 0) { Write-Error '[error] corepack install に失敗しました（Node.js 24+ を確認）。'; exit 1 }

    # node_modules / dist を一掃し、毎回ストアからクリーンインストール（重量物は温存）。
    $purge = @(
      'node_modules',
      'editor\shared\node_modules', 'editor\server\node_modules', 'editor\web\node_modules',
      'pie-chart\node_modules',
      'editor\shared\dist', 'editor\server\dist', 'editor\web\dist'
    )
    foreach ($d in $purge) {
      $full = Join-Path $RepoRoot $d
      if (Test-Path $full) { Remove-Item -LiteralPath $full -Recurse -Force -ErrorAction SilentlyContinue }
    }
    # tsbuildinfo は dist の外に残るため個別に消す。特に editor\shared / editor\server の分が
    # 残ると `tsc -b` が「最新」と誤認して shared の dist を再生成せず、build が
    # 「Cannot find module '@editor/shared'」で全滅する（実測）。
    foreach ($f in @('editor\web\tsconfig.tsbuildinfo', 'editor\shared\tsconfig.tsbuildinfo',
        'editor\server\tsconfig.tsbuildinfo')) {
      $tsbi = Join-Path $RepoRoot $f
      if (Test-Path $tsbi) { Remove-Item -LiteralPath $tsbi -Force -ErrorAction SilentlyContinue }
    }

    & corepack pnpm install --offline --frozen-lockfile --store-dir (Join-Path $RepoRoot '.pnpm-store')
    if ($LASTEXITCODE -ne 0) { Write-Error '[error] オフライン install に失敗しました。'; exit 1 }

    # msnodesqlv8 のネイティブ .node を配置する。npm tarball / .pnpm-store にバイナリは入らず
    # install スクリプトも allowBuilds で封止しているため、同梱の公式 prebuild を install 後の
    # .pnpm 実体へ展開する（editor/server と pie-chart は同実体への symlink 参照＝1 箇所で両方に
    # 効く。install 前だと purge/再構成で消える）。REST/DB 入力を使わない構成では無くても動くため
    # 失敗は警告止まりで setup を続行する。
    $pbTar = Get-ChildItem (Join-Path $RepoRoot 'native-prebuilds\msnodesqlv8-*.tar.gz') -ErrorAction SilentlyContinue | Select-Object -First 1
    $pbPkg = Get-ChildItem (Join-Path $RepoRoot 'node_modules\.pnpm\msnodesqlv8@*\node_modules\msnodesqlv8') -Directory -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($pbTar -and $pbPkg) {
      # lockfile の版だけ上げて prebuild の差し替えを忘れる事故の検知（native-prebuilds\manifest.txt 参照）。
      $instVer = (Get-Content (Join-Path $pbPkg.FullName 'package.json') -Raw | ConvertFrom-Json).version
      if ($pbTar.Name -notlike "*v$instVer*") {
        Write-Warning "[warn] msnodesqlv8 の install 版($instVer)と prebuild($($pbTar.Name))の版が不一致。native-prebuilds の差し替えが必要です。"
      }
      & (Resolve-Tar) -xzf $pbTar.FullName -C $pbPkg.FullName
      if ($LASTEXITCODE -ne 0) {
        Write-Warning '[warn] msnodesqlv8 prebuild の展開に失敗（editor REST / pie-chart DB 入力は使用不可）。'
      } else {
        # ABI 不一致・破損はロードで露見するため require で疎通確認する（editor/server から解決）。
        # EAP=Stop のため stderr リダイレクトは使わず、node 側 try/catch で exit code のみ返す。
        Push-Location (Join-Path $RepoRoot 'editor\server')
        & node -e "try{require('msnodesqlv8');process.exit(0)}catch(e){process.exit(1)}"
        $reqOk = ($LASTEXITCODE -eq 0)
        Pop-Location
        if ($reqOk) { Write-Host '[info] msnodesqlv8 ネイティブ .node を配置（require OK）。' }
        else { Write-Warning '[warn] msnodesqlv8 の require に失敗。Node の ABI（24.x=137）と prebuild の対応を確認してください。' }
      }
    } else {
      Write-Warning '[warn] msnodesqlv8 prebuild または install 先が見つからず、ネイティブ .node を配置できませんでした（editor REST / pie-chart DB 入力は使用不可）。'
    }

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
  Write-Host '[4/5] -SkipBuild: 取得・展開・整合検査のみ。環境構築をスキップしました。'
}

# editor のテンプレ版管理は git CLI を使う。同梱 PortableGit を展開して PATH/GIT_BIN を通す。
Install-GitTools -RepoRoot $RepoRoot -InstallTortoiseGit:$InstallTortoiseGit

# ---- [5/5] 取得物を bk\ へ退避（手元のバンドルを使った回は動かさない） ----
if ($downloaded) {
  Write-Host '[5/5] ダウンロード物を bk/ へ退避...'
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
  # 記憶した変数パスへの Test-Path はビルド直後の一時ロックで false を返すことがあるため、
  # 実ディスクの列挙を正として複数パスで掃き出す。
  $names = @($BundleName, "$BundleName.sha256", 'bundle.key')
  for ($pass = 1; $pass -le 3; $pass++) {
    $hits = Get-ChildItem -LiteralPath $RepoRoot -File -Force -ErrorAction SilentlyContinue |
      Where-Object { $names -contains $_.Name }
    if (-not $hits) { break }
    foreach ($fi in $hits) { Move-ToBk $fi.FullName }
    Start-Sleep -Milliseconds 300
  }
} else {
  Write-Host '[5/5] 手元のバンドルを使ったため退避はありません。'
}

Write-Host ''
if ($SkipBuild) {
  Write-Host '[OK] 展開完了（build はスキップ）。'
} else {
  Write-Host '[OK] セットアップ完了。'
  Write-Host '  - 型チェック: corepack pnpm typecheck'
  Write-Host '  - テスト:     corepack pnpm test'
  Write-Host '  - E2E:        corepack pnpm test:e2e'
  Write-Host '  - 開発サーバ: corepack pnpm dev'
  Write-Host '  - エディタ起動: editor\start.bat'
  Write-Host '  ( corepack enable を一度実行すれば、以後は pnpm だけで実行可能 )'
  Write-Host ''
  Write-Host '  PDF 出力はシステムの Microsoft Edge を自動使用します（追加ブラウザ不要）。'
}
