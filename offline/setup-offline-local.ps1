#requires -Version 5.1
<#
.SYNOPSIS
  すでに手元に揃っている重量物バンドル（GitHub から取得済み）だけを使い、
  ネットワークへ一切接続せずに開発環境を構築する（完全オフライン・構築専用）。

.DESCRIPTION
  setup-offline.ps1 が「取得（HTTPS DL）＋展開＋構築」を行うのに対し、本スクリプトは
  取得を一切行わず、以下のローカル資材が既に存在する前提で「展開＋構築」だけを行う:
    - offline-deps-bundle.tar.gz（未展開ならこれを展開）
      もしくは展開済みの .pnpm-store / pnpm.tgz / ms-playwright（あれば展開を省略）
    - （任意）offline-deps-bundle.tar.gz.sha256 / bundle.key（あれば検証に使う）

  資材はリポジトリ直下、無ければ bk\ も探索する。処理内容:
    1. ローカル資材の探索（.tar.gz もしくは展開済みディレクトリ）
    2. （資材があれば）sha256 検証 + lockfile 整合チェック（警告のみ）
    3. 未展開なら .tar.gz を直下へ展開（.pnpm-store / pnpm.tgz / ms-playwright）
    4. 同梱 pnpm を corepack 登録 → クリーン → オフライン install → build → Playwright 配置

  ★ 本スクリプトは外部へ通信しない（DL なし）。資材が無ければエラーで止める。

.PARAMETER SkipBuild
  展開のみ行い、install / build / Playwright 配置を省略する。

.PARAMETER NoVerify
  sha256 / lockfile 整合チェックを省略する。

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File offline\setup-offline-local.ps1
#>
[CmdletBinding()]
param(
  [switch]$SkipBuild,
  [switch]$NoVerify
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# 共通ライブラリ（content-key 算出 / tar 解決）。
. (Join-Path $PSScriptRoot 'lib\content-key.ps1')

# offline/ の親をリポジトリ直下（ROOT）とみなす。
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Bk       = Join-Path $RepoRoot 'bk'
Write-Host "[info] repo root: $RepoRoot"
Write-Host "[info] mode     : 完全オフライン（取得なし・ローカル資材のみ）"

# tar 解決（System32\tar.exe 優先）は共通ライブラリの Resolve-Tar を使う。

$BundleName = 'offline-deps-bundle.tar.gz'

# RepoRoot 優先、無ければ bk\ から資材を探すヘルパ。
function Find-Local([string]$name) {
  $a = Join-Path $RepoRoot $name
  if (Test-Path -LiteralPath $a) { return $a }
  $b = Join-Path $Bk $name
  if (Test-Path -LiteralPath $b) { return $b }
  return $null
}

# 展開済み資材（直下）が揃っているか。
$ExtractedOk = $true
foreach ($p in @('.pnpm-store', 'pnpm.tgz', 'ms-playwright', 'python-wheelhouse', 'git-tools',
    'native-prebuilds')) {
  if (-not (Test-Path (Join-Path $RepoRoot $p))) { $ExtractedOk = $false }
}

$Bundle = Find-Local $BundleName

# ---- [1/4] ローカル資材の確認 ----
Write-Host '[1/4] ローカル資材を確認...'
if ($ExtractedOk) {
  Write-Host '[info] 展開済み資材（.pnpm-store / pnpm.tgz / ms-playwright）を直下に確認。展開はスキップします。'
} elseif ($Bundle) {
  Write-Host "[info] バンドルを発見: $Bundle"
} else {
  Write-Error @"
[error] オフライン資材が見つかりません。次のいずれかをリポジトリ直下（または bk\）へ配置してください:
  - $BundleName（未展開バンドル）
  - もしくは展開済みの .pnpm-store / pnpm.tgz / ms-playwright 一式
  ※ 取得が必要な場合はオンライン環境で offline\setup-offline.bat を使ってください。
"@
  exit 1
}

# ---- [2/4] 検証（資材があれば。警告のみ） ----
if (-not $NoVerify) {
  Write-Host '[2/4] 検証（sha256 / lockfile 整合）...'

  # sha256（.tar.gz とその .sha256 が両方ある時だけ）
  if ($Bundle) {
    $Sha = "$Bundle.sha256"
    if (-not (Test-Path -LiteralPath $Sha)) { $Sha = Find-Local "$BundleName.sha256" }
    if ($Sha -and (Test-Path -LiteralPath $Sha)) {
      $expected = ((Get-Content $Sha -Raw).Trim() -split '\s+')[0].ToLower()
      $actual   = (Get-FileHash $Bundle -Algorithm SHA256).Hash.ToLower()
      if ($expected -ne $actual) {
        Write-Error "[error] sha256 不一致。バンドル破損の可能性。`n  expected: $expected`n  actual:   $actual"; exit 1
      }
      Write-Host "[info] sha256 OK: $actual"
    } else {
      Write-Warning '[warn] .sha256 が無いため整合性検証をスキップ。'
    }
  }

  # lockfile 整合（bundle.key 比較）は展開後に行う。content key の入力に
  # git-tools\manifest.txt（バンドル同梱・gitignore 対象でソースに無い）が含まれるため、
  # 展開前に測ると manifest を欠いて publish 側と必ずズレる。下の [3.5/4] へ遅延させる。
} else {
  Write-Host '[2/4] -NoVerify: 検証をスキップ。'
}

# ---- [3/4] 展開（未展開のときだけ） ----
if ($ExtractedOk) {
  Write-Host '[3/4] 展開済みのため展開をスキップ。'
} else {
  Write-Host '[3/4] バンドルを直下へ展開（.pnpm-store / pnpm.tgz / ms-playwright / python-wheelhouse）...'
  $TarExe = Resolve-Tar
  & $TarExe -xzf $Bundle -C $RepoRoot
  if ($LASTEXITCODE -ne 0) { Write-Error '[error] 展開に失敗しました。'; exit 1 }
  foreach ($p in @('.pnpm-store', 'pnpm.tgz', 'ms-playwright', 'python-wheelhouse', 'git-tools',
      'docs\_build\vendor\mermaid.min.js', 'docs\_build\vendor\mermaid-layout-elk.min.js',
      'native-prebuilds\manifest.txt')) {
    if (-not (Test-Path (Join-Path $RepoRoot $p))) {
      Write-Error "[error] 展開後に $p が見つかりません。バンドルが不完全です。"; exit 1
    }
  }
}

# ---- [3.5/4] lockfile 整合チェック（展開後＝git-tools\manifest.txt が在る状態で測る） ----
# content-key は publish / setup と同一ロジック（共通ライブラリ Get-LockContentKey）。manifest が
# content key 入力に含まれるため、展開後に比較しないと publish 側とズレる（上の [2/4] 参照）。
if (-not $NoVerify) {
  $KeyFile  = Find-Local 'bundle.key'
  $LockFile = Join-Path $RepoRoot 'pnpm-lock.yaml'
  $PkgJson  = Join-Path $RepoRoot 'package.json'
  if ($KeyFile -and (Test-Path $LockFile) -and (Test-Path $PkgJson)) {
    $packageManager = Get-PackageManagerString $PkgJson
    $localKey = Get-LockContentKey -LockFile $LockFile -PackageManager $packageManager
    $publishedKey = (Get-Content $KeyFile -Raw).Trim().ToLower()
    if ($localKey -eq $publishedKey) {
      Write-Host "[info] lockfile key 一致: $localKey"
    } else {
      Write-Warning "[warn] lockfile 不整合の可能性。資材とソースが対応していません。`n  code (local) : $localKey`n  bundle.key   : $publishedKey`n  → --frozen-lockfile が失敗する場合は同一タグの資材で揃え直してください。"
    }
  } else {
    Write-Warning '[warn] bundle.key / pnpm-lock.yaml / package.json のいずれかが無く、lockfile 整合チェックをスキップ。'
  }
}

# ---- [4/4] オフライン環境構築 ----
if ($SkipBuild) {
  Write-Host '[4/4] -SkipBuild: 展開のみ。環境構築をスキップしました。'
} else {
  if (-not (Get-Command 'corepack' -ErrorAction SilentlyContinue)) {
    Write-Error '[error] corepack が見つかりません。Node.js 24+ をインストールしてください。'; exit 1
  }
  $env:COREPACK_ENABLE_DOWNLOAD_PROMPT = '0'   # 同梱 pnpm を使う。DL プロンプト抑止（=ネット接続させない）
  $env:CI = 'true'                             # 対話確認の抑止
  Push-Location $RepoRoot
  try {
    Write-Host '[4/4] 環境構築: 同梱 pnpm を corepack 登録 → クリーン → オフライン install → build → Playwright 配置...'

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
}

# ---- git ツール（PortableGit / TortoiseGit）の展開・導入（任意・ベストエフォート） ----
# editor のテンプレ版管理は git CLI を使う。air-gapped 環境向けに同梱した PortableGit を
# 展開して PATH へ通し、TortoiseGit（履歴/diff の GUI）を導入する。失敗しても全体は止めない。
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
      # editor サーバは GIT_BIN を最優先で使う（PATH 反映の遅延に依存しない）。
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

Write-Host ''
if ($SkipBuild) {
  Write-Host '[OK] 展開完了（build はスキップ）。'
} else {
  Write-Host '[OK] 完全オフライン構築 完了。'
  Write-Host '  - 型チェック: corepack pnpm typecheck'
  Write-Host '  - テスト:     corepack pnpm test'
  Write-Host '  - E2E:        corepack pnpm test:e2e'
  Write-Host '  - 開発サーバ: corepack pnpm dev'
  Write-Host '  - エディタ起動: editor\start.bat'
  Write-Host '  ( corepack enable を一度実行すれば、以後は pnpm だけで実行可能 )'
  Write-Host ''
  Write-Host '  PDF 出力はシステムの Microsoft Edge を自動使用します（追加ブラウザ不要）。'
}
