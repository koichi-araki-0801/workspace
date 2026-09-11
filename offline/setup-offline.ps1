#requires -Version 5.1
<#
.SYNOPSIS
  git clone 済みのリポジトリに、オフライン重量物バンドルを展開して開発環境を構築する。

.DESCRIPTION
  重量物（.pnpm-store / pnpm.tgz / ms-playwright / python-wheelhouse / git-tools /
  docs の mermaid JS / native-prebuilds）は git に入れず GitHub Releases（タグ offline-bundle-v1）に
  置いてある。本スクリプトは次を 1 本で行う:
    0. 直下に source.zip があれば展開段: .sha256 照合 → 前回の MANIFEST に載るファイルを削除 →
       直下へ展開 → bk\ へ退避 → 新しい setup-offline.ps1 を -SkipSourceExtract で再実行して
       以降を任せる（自分自身が展開で新しくなるため）。
    1. バンドルの確認。リポジトリ直下または bk\ に offline-deps-bundle.tar.gz と bundle.key が
       同じ場所に揃っていればそれを使う。無ければ fetch-offline-bundle.bat を案内して中止する
       （取得を肩代わりしない。取得はネットに出られる端末で先に行うものであり、ここで肩代わりすると
       「ネットに出ない」前提が崩れてネットに出られない端末で原因の見えにくい失敗になる）。
    2. 展開 → bundle.key と手元の pnpm-lock.yaml / packageManager / requirements / manifest から
       算出する content-key の一致検査。不一致は「ソースと重量物が別の組」なので中止する
       （続けても pnpm install --offline が落ちるだけで、原因が見えにくくなる）。
    3. 同梱 pnpm を corepack 登録 → node_modules / dist を消してオフライン install → build →
       Playwright 配置 → msnodesqlv8 prebuild 配置 → PortableGit 展開。
    4. 直下に置かれていたバンドルを bk\ へ退避する（bk\ のものを使った回は動かさない）。

  ソースコードは取得しない（git clone が前提）。バンドルの真正性は検証しない: 配布担当だけが
  Release を更新でき、配布先は同じ所有者の Public リポジトリを clone している前提で受け入れる。
  content-key の不一致は改ざんではなく「依存を変えたのに publish していない」状態で、
  配布担当に local-only\offline-publish\publish-offline-bundle.bat の実行を依頼する。

.PARAMETER SkipBuild
  展開・整合検査のみ行い、install / build / Playwright 配置を省略する。

.PARAMETER InstallTortoiseGit
  TortoiseGit の MSI を msiexec /qn（サイレント・昇格）で導入する。既定では導入しない。

.PARAMETER SkipSourceExtract
  展開段を飛ばす（再実行時に自動で付く。手で付ける必要はない）。

.EXAMPLE
  offline\setup-offline.bat
.EXAMPLE
  offline\setup-offline.bat -SkipBuild
#>
[CmdletBinding()]
param(
  [switch]$SkipBuild,
  [switch]$InstallTortoiseGit,
  [switch]$SkipSourceExtract
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'lib\content-key.ps1')
. (Join-Path $PSScriptRoot 'lib\verify.ps1')
. (Join-Path $PSScriptRoot 'lib\git-tools.ps1')
. (Join-Path $PSScriptRoot 'lib\source.ps1')

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Bk       = Join-Path $RepoRoot 'bk'
Write-Host "[info] repo root: $RepoRoot"
# ネットワークドライブ上では pnpm の symlink/hardlink 構成が成立しないため開始前に止める。
Assert-LocalRepoRoot -Path $RepoRoot

# ---- [0/5] ソース ZIP の展開（直下に source.zip があり、.git が無いときだけ） ----
# 展開で自分自身（このスクリプトと dot-source 済みの lib）が新しくなる。PowerShell は起動時に
# 全文を読んでいるので実行中の処理は落ちないが、構築は新しい版に任せたいので、展開が済んだら
# 新しい setup-offline.ps1 を再実行してその終了コードで終わる。再実行側は -SkipSourceExtract
# 付きで呼ばれ、この段に入らない（再帰防止）。
# .git の有無で経路を分けるのは、clone 端末（README-offline 手順 A）の直下へ手順 B-1 の
# fetch -Source で source.zip が残っていることがあるため。.git があるなら、その source.zip は
# 遮断端末へ運ぶための取得物であり、clone 端末自身の構築には使わない（展開すると未コミットの
# 作業ツリーが Release 版で上書きされる）。「遮断端末には .git が無い」という spec 2 章の前提を
# この条件で機械的に表明する。
$SourceZip = Join-Path $RepoRoot 'source.zip'
$hasSourceZip = Test-Path -LiteralPath $SourceZip
$hasGit = Test-Path -LiteralPath (Join-Path $RepoRoot '.git')
if (-not $SkipSourceExtract -and $hasSourceZip -and $hasGit) {
  Write-Warning ("[warn] 直下に source.zip がありますが、このフォルダは git clone（.git あり）なので展開段は飛ばします。`n" +
    '       source.zip / source.zip.sha256 は遮断端末へ運ぶための取得物です（このフォルダの構築には使いません）。')
} elseif (-not $SkipSourceExtract -and $hasSourceZip) {
  Write-Host '[0/5] ソース ZIP を展開...'
  try {
    $r = Invoke-SourceExtractStage -RepoRoot $RepoRoot -Bk $Bk
  } catch {
    Write-Error ("[error] $($_.Exception.Message)`n" +
      "  source.zip と source.zip.sha256 を fetch-offline-bundle.bat -Source で取り直してください。`n" +
      "  照合エラー以外（展開の途中で止まった等）なら、直下または bk\ の source.zip をエクスプローラで`n" +
      '  「すべて展開」してこのフォルダへ上書きし、offline\setup-offline.bat を実行し直してください。')
    exit 1
  }
  Write-Host "[info] 展開しました（前の版の削除: $($r.Removed) 件$(if ($r.FirstRun) { '、初回扱い' })）。新しい setup を続行します..."
  # `$args` は PowerShell の自動変数なので使わない。
  $reexec = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot 'setup-offline.ps1'), '-SkipSourceExtract')
  if ($SkipBuild) { $reexec += '-SkipBuild' }
  if ($InstallTortoiseGit) { $reexec += '-InstallTortoiseGit' }
  & powershell @reexec
  exit $LASTEXITCODE
}
$sourceCommit = Read-SourceCommit -RepoRoot $RepoRoot
if ($sourceCommit) { Write-Host "[info] source commit: $sourceCommit" }

$TarExe     = Resolve-Tar
$BundleName = 'offline-deps-bundle.tar.gz'
$LockFile   = Join-Path $RepoRoot 'pnpm-lock.yaml'
$PkgJson    = Join-Path $RepoRoot 'package.json'
foreach ($f in @($LockFile, $PkgJson)) {
  if (-not (Test-Path -LiteralPath $f)) {
    Write-Error "[error] $f がありません。リポジトリを git clone した直下で実行してください。"; exit 1
  }
}

# ---- [1/5] バンドルの確認（取得はしない） ----
Write-Host '[1/5] バンドルを確認...'
# リポジトリ直下 → bk\ の順で、バンドルと bundle.key が同じディレクトリに揃っている組だけを使う。
# 取得は fetch-offline-bundle.bat の担当。ここで肩代わりすると「ネットに出ない」前提が崩れ、
# ネットに出られない端末で原因の見えにくい失敗になる。
$local = Find-LocalBundlePair -Directories @($RepoRoot, $Bk) -BundleName $BundleName
if (-not $local) {
  Write-Error ("[error] リポジトリ直下にも bk\ にも $BundleName と bundle.key の組がありません。" +
    "`n  ネットに出られる端末で offline\fetch-offline-bundle.bat を実行して取得し、" +
    "`n  3 ファイル（$BundleName / $BundleName.sha256 / bundle.key）をリポジトリ直下に置いてから再実行してください。")
  exit 1
}
$Bundle  = $local.Bundle
$KeyFile = $local.Key
# 直下のバンドルを使った回だけ、完了後に bk\ へ退避する（bk\ のものはそのまま）。
$fromRoot = ((Split-Path $Bundle -Parent).TrimEnd('\') -eq $RepoRoot.TrimEnd('\'))
Write-Host "[info] 手元のバンドルを使います: $Bundle"

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
    "`n  bundle.key に対応するコミットへ checkout し直してください。" +
    "`n  遮断端末で source.zip を持ち込んだ場合は、その ZIP が古い（依存を変えたのに publish していない、" +
    "`n  または古い ZIP を持ち込んだ）可能性もあります。$(if ($sourceCommit) { "source commit: $sourceCommit" })")
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
    # 効く。install 前だと purge/再構成で消える）。editor の既定は DB モードなので、ここが欠けると
    # setup は成功したのに起動できない端末ができる。3 段（prebuild と install 先の有無 / 版一致 /
    # 展開と require 疎通）のどれかで失敗したら setup を失敗にする。
    $pbTar = Get-ChildItem (Join-Path $RepoRoot 'native-prebuilds\msnodesqlv8-*.tar.gz') -ErrorAction SilentlyContinue | Select-Object -First 1
    $pbPkg = Get-ChildItem (Join-Path $RepoRoot 'node_modules\.pnpm\msnodesqlv8@*\node_modules\msnodesqlv8') -Directory -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($pbTar -and $pbPkg) {
      # lockfile の版だけ上げて prebuild の差し替えを忘れる事故の検知（native-prebuilds\manifest.txt 参照）。
      $instVer = (Get-Content (Join-Path $pbPkg.FullName 'package.json') -Raw | ConvertFrom-Json).version
      if ($pbTar.Name -notlike "*v$instVer*") {
        Write-Error "[error] msnodesqlv8 の install 版($instVer)と prebuild($($pbTar.Name))の版が不一致。native-prebuilds の差し替えが必要です。"; exit 1
      }
      & (Resolve-Tar) -xzf $pbTar.FullName -C $pbPkg.FullName
      if ($LASTEXITCODE -ne 0) {
        Write-Error '[error] msnodesqlv8 prebuild の展開に失敗しました。'; exit 1
      } else {
        # ABI 不一致・破損はロードで露見するため require で疎通確認する（editor/server から解決）。
        # EAP=Stop のため stderr リダイレクトは使わず、node 側 try/catch で exit code のみ返す。
        Push-Location (Join-Path $RepoRoot 'editor\server')
        & node -e "try{require('msnodesqlv8');process.exit(0)}catch(e){process.exit(1)}"
        $reqOk = ($LASTEXITCODE -eq 0)
        Pop-Location
        if ($reqOk) { Write-Host '[info] msnodesqlv8 ネイティブ .node を配置（require OK）。' }
        else { Write-Error '[error] msnodesqlv8 の require に失敗しました。Node の ABI（24.x=137）と prebuild の対応を確認してください。'; exit 1 }
      }
    } else {
      Write-Error '[error] msnodesqlv8 prebuild または install 先が見つからず、ネイティブ .node を配置できませんでした。'; exit 1
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
  Write-Host '[4/5] -SkipBuild: 展開・整合検査のみ。環境構築をスキップしました。'
}

# editor のテンプレ版管理は git CLI を使う。同梱 PortableGit を展開して PATH/GIT_BIN を通す。
Install-GitTools -RepoRoot $RepoRoot -InstallTortoiseGit:$InstallTortoiseGit

# ---- [5/5] 直下のバンドルを bk\ へ退避（bk\ のものを使った回は動かさない） ----
if ($fromRoot) {
  Write-Host '[5/5] 直下のバンドルを bk/ へ退避...'
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
