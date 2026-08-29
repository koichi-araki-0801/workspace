#requires -Version 5.1
<#
.SYNOPSIS
  すでに手元に揃っている重量物バンドル（GitHub から取得済み）だけを使い、
  ネットワークへ一切接続せずに開発環境を構築する（完全オフライン・構築専用）。

.DESCRIPTION
  setup-offline.ps1 が「取得（HTTPS DL）＋展開＋構築」を行うのに対し、本スクリプトは
  取得を一切行わず、以下のローカル資材が既に存在する前提で「展開＋構築」だけを行う:
    - offline-deps-bundle.tar.gz（+ .sig。あればこれを検証して展開する）
      もしくは展開済みの .pnpm-store / pnpm.tgz / ms-playwright 一式 + 検証済み receipt
      （過去に署名検証を通した記録。receipt が無い展開済み資材は受け入れない）
    - bundle.key（ソースと資材の対応チェックに使う。真正性の根拠ではない）

  資材はリポジトリ直下、無ければ bk\ も探索する。処理内容:
    1. ローカル資材の探索（.tar.gz もしくは展開済みディレクトリ）
    2. 検証（**すべて致命**）: バンドル実体があれば offline\pinned-release.txt の sha256 と
       突き合わせ、offline\bundle-signing.pub.xml で分離署名 .sig を検証する。バンドルが無く
       展開済みのみの再実行は、過去の署名検証を示す receipt を必須にする（無ければ中止）。
    3. バンドル実体があるなら、展開済みツリーが在っても必ず再展開して receipt を記録する
       （検証したバイト列＝実際に使うバイト列を一致させる）。展開後に bundle.key を突き合わせる
    4. 同梱 pnpm を corepack 登録 → クリーン → オフライン install → build → Playwright 配置

  ★ 本スクリプトは外部へ通信しない（DL なし）。資材が無ければエラーで止める。

  完全性・真正性: 期待値は資材の隣に落ちている ``.sha256`` ではなく、
  手渡しで運ばれる ``offline\pinned-release.txt`` から取る（資材を差し替えられる者は隣の
  sidecar も差し替えられるため、あれは転送破損の検知にしかならない）。検証材料の欠落は
  警告ではなく**エラー**で止める。

.PARAMETER SkipBuild
  展開のみ行い、install / build / Playwright 配置を省略する。

.PARAMETER DangerouslySkipVerification
  非常口。sha256 / 署名 / lockfile 整合の検証をすべて省略する。検証材料が壊れて手元の資材が
  正しいと判っている場合の一時退避用で、通常運用では使わない（.bat の案内にも載せない）。

.PARAMETER InstallTortoiseGit
  TortoiseGit の MSI を ``msiexec /qn``（サイレント・昇格）で導入する。既定では導入しない
  （黙って昇格インストールを走らせないための明示 opt-in）。

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File offline\setup-offline-local.ps1
#>
[CmdletBinding()]
param(
  [switch]$SkipBuild,
  [switch]$DangerouslySkipVerification,
  [switch]$InstallTortoiseGit
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# 共通ライブラリ（content-key 算出 / tar 解決 / 完全性検証 / git ツール導入）。
. (Join-Path $PSScriptRoot 'lib\content-key.ps1')
. (Join-Path $PSScriptRoot 'lib\verify.ps1')
. (Join-Path $PSScriptRoot 'lib\git-tools.ps1')

# offline/ の親をリポジトリ直下（ROOT）とみなす。
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Bk       = Join-Path $RepoRoot 'bk'
Write-Host "[info] repo root: $RepoRoot"
Write-Host "[info] mode     : 完全オフライン（取得なし・ローカル資材のみ）"
# ネットワークドライブ上では pnpm の symlink/hardlink 構成が成立しないため開始前に止める。
Assert-LocalRepoRoot -Path $RepoRoot

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

# ---- [2/4] 検証 + [3/4] 展開（すべて致命。材料が欠けていても止まる） ----
# 主防御: バンドル実体があるなら、展開済みツリーが在っても必ず検証してから再展開する
# （検証したバイト列＝実際に使うバイト列を一致させる）。展開済みツリーを信用して展開を
# 省くと、「検証したのはバンドル、install/build が使うのは差し替え済みの別物」という穴が
# 開く。バンドルが無く展開済みのみの再実行には、過去に署名検証を通した receipt を必須に
# する（receipt が無い野良の展開済み資材は fail closed で止める）。
$PinFile    = Join-Path $PSScriptRoot 'pinned-release.txt'
$PubKeyFile = Join-Path $PSScriptRoot 'bundle-signing.pub.xml'

# バンドル展開の共通処理（展開 → 必須成果物の存在確認）。
function Expand-Bundle([string]$BundlePath) {
  $TarExe = Resolve-Tar
  & $TarExe -xzf $BundlePath -C $RepoRoot
  if ($LASTEXITCODE -ne 0) { Write-Error '[error] 展開に失敗しました。'; exit 1 }
  foreach ($p in @('.pnpm-store', 'pnpm.tgz', 'ms-playwright', 'python-wheelhouse', 'git-tools',
      'docs\_build\vendor\mermaid.min.js', 'docs\_build\vendor\mermaid-layout-elk.min.js',
      'native-prebuilds\manifest.txt')) {
    if (-not (Test-Path (Join-Path $RepoRoot $p))) {
      Write-Error "[error] 展開後に $p が見つかりません。バンドルが不完全です。"; exit 1
    }
  }
}

if ($DangerouslySkipVerification) {
  Write-Warning '[2/4] -DangerouslySkipVerification: 検証をすべて省略します（通常運用では使わないでください）。'
  # 非常口を通った証跡は残さない。receipt を消して次回の通常実行で必ず再検証させる。
  Remove-VerificationReceipt -Directory $RepoRoot
  if ($ExtractedOk) {
    Write-Host '[3/4] 展開済みのため展開をスキップ（無検証）。'
  } else {
    Write-Host '[3/4] バンドルを直下へ展開（無検証）...'
    Expand-Bundle $Bundle
  }
} elseif ($Bundle) {
  # 期待値は手渡しで運ばれた offline/ の pin から取る。資材の隣の .sha256 は「資材を差し
  # 替えられる者が同じ場所へ置ける値」なので判定には使わない。
  Write-Host '[2/4] 検証（pin の sha256 / 分離署名）...'
  $pin = Get-OfflinePin -Path $PinFile
  Assert-FileSha256 -File $Bundle -ExpectedSha256 $pin.BundleSha256 -Label 'bundle'
  # 分離署名は資材の隣（無ければ bk\）から探す。欠落は警告でなくエラー。
  $SigPath = "$Bundle.sig"
  if (-not (Test-Path -LiteralPath $SigPath)) { $SigPath = Find-Local "$BundleName.sig" }
  if (-not $SigPath) {
    Write-Error ("[error] 分離署名 $BundleName.sig がありません（リポジトリ直下 / bk\ を確認）。`n" +
      '  署名の無い重量物は受け入れません。')
    exit 1
  }
  Assert-BundleSignature -File $Bundle -SignaturePath $SigPath -PublicKeyPath $PubKeyFile
  Write-Host '[info] 分離署名 OK（offline/ 同梱の公開鍵で検証）。'

  # 主防御: 検証済みバンドルから必ず展開する（$ExtractedOk でも再展開。上のブロック説明参照）。
  Write-Host '[3/4] 検証済みバンドルを直下へ展開（既存の展開済みツリーがあっても再展開）...'
  Expand-Bundle $Bundle
  # 検証と展開を通ったツリーにだけ receipt を書く（次回バンドル無しの再実行のゲート）。
  New-VerificationReceipt -Directory $RepoRoot -BundleSha256 $pin.BundleSha256
} else {
  # バンドル実体が無く展開済みのみ。過去に署名検証を通した receipt を必須にする。
  Write-Host '[2/4] 検証（展開済み資材の receipt 照合）...'
  $pin = Get-OfflinePin -Path $PinFile
  if (-not (Test-VerificationReceipt -Directory $RepoRoot -ExpectedBundleSha256 $pin.BundleSha256)) {
    Write-Error @"
[error] 展開済み資材のみでの再実行には、過去に署名検証を通した記録（receipt）が必要です。
  この作業ツリーには検証済み receipt が無い（または pin と一致しません）。資材が正規リリースの
  署名済みバンドルから展開されたことを確認できないため、install / build へは進みません。
  対処: 署名付き $BundleName（と $BundleName.sig）をリポジトリ直下（または bk\）へ置いて再実行してください。
"@
    exit 1
  }
  Write-Host '[info] receipt OK（過去に署名検証を通した資材）。'
  Write-Host '[3/4] 展開済みのため展開をスキップ。'
}

# ---- [3.5/4] lockfile 整合チェック（展開後＝git-tools\manifest.txt が在る状態で測る） ----
# content-key は publish / setup と同一ロジック（共通ライブラリ Get-LockContentKey）。manifest が
# content key 入力に含まれるため、展開後に比較しないと publish 側とズレる（上の [2/4] 参照）。
if (-not $DangerouslySkipVerification) {
  $KeyFile  = Find-Local 'bundle.key'
  $LockFile = Join-Path $RepoRoot 'pnpm-lock.yaml'
  $PkgJson  = Join-Path $RepoRoot 'package.json'
  # 材料の欠落も不一致も致命にする。ここを警告で流すと「ソースと資材が
  # 対応していない環境」がそのままビルドへ進み、原因の見えない失敗になる。
  if (-not ($KeyFile -and (Test-Path $LockFile) -and (Test-Path $PkgJson))) {
    Write-Error ('[error] bundle.key / pnpm-lock.yaml / package.json のいずれかがありません（整合を確かめられません）。' +
      "`n  bundle.key はバンドルと同じ場所（リポジトリ直下 / bk\）へ置いてください。")
    exit 1
  }
  $packageManager = Get-PackageManagerString $PkgJson
  $localKey = Get-LockContentKey -LockFile $LockFile -PackageManager $packageManager
  $publishedKey = (Get-Content $KeyFile -Raw).Trim().ToLower()
  if ($localKey -ne $publishedKey) {
    Write-Error ("[error] lockfile 不整合: 資材とソースが対応していません。`n  code (local) : $localKey" +
      "`n  bundle.key   : $publishedKey`n  同一リリースの資材とソースで揃え直してください。")
    exit 1
  }
  Write-Host "[info] lockfile key 一致: $localKey"
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
}

# ---- git ツール（PortableGit / TortoiseGit）の展開・導入 ----
# editor のテンプレ版管理は git CLI を使う。air-gapped 環境向けに同梱した PortableGit を
# 展開して PATH/GIT_BIN を通す。実行するバイナリの選択・検証・PATH の扱いは共通ライブラリへ
# 集約（setup-offline.ps1 と同一経路。「片方だけ直る」事故を防ぐ）。
Install-GitTools -RepoRoot $RepoRoot -InstallTortoiseGit:$InstallTortoiseGit

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
