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

  変更検知キー = sha256( pnpm-lock.yaml ‖ packageManager ‖ 各 requirements.txt )。算出は
  共通ライブラリ Get-LockContentKey に集約（content-key.ps1）。
  .pnpm-store は pnpm-lock.yaml が、pnpm.tgz は packageManager が、ms-playwright は
  lockfile 内に解決された @playwright/test 版（=chromium revision）が、python-wheelhouse は
  pdf-to-svg / graph-editor の requirements.txt が、それぞれ規定する。
  よってこの1キーで4点すべての変化を覆える。Release 側に bundle.key（このハッシュ）を保存し、
  現在キーと一致したら重量物は据え置く（タグ移動と説明更新のみ）。

  コミット毎フック（.husky/post-commit）からは **-TagOnly で**呼ぶ。フックが行うのは
  タグ移動（＝ソース更新）だけで、重量物の再生成（pip download / pnpm install という
  依存解決器の実行）はフックから決して走らせない — コミットに紛れた requirements.txt /
  lockfile の編集 1 つで外部コードの取得・実行まで無人到達するため（所見 F20）。
  他人の PR をマージしてコミットするだけで成立するので、フック経路は依存解決器を持たない。
  重量物の更新は公開担当者が本スクリプトを引数なしで**明示実行**して行う。

  真正性の根拠（所見 F14）: 重量物には RSA-SHA256 の分離署名（<bundle>.sig）を添え、
  ソースの不変コミット ID と各 sha256 を offline\pinned-release.txt へ書き出す。この pin と
  公開鍵 offline\bundle-signing.pub.xml は offline/ フォルダごと手渡しで配布先へ運ばれる。
  Release へ並べる .sha256 は**配信元と同じ場所から取る値**なので転送破損の検知にしかならず、
  すり替えの検知にはならない（配布先はこの sidecar を信頼しない）。

.PARAMETER Tag
  公開先のローリングタグ。既定 offline-bundle-v1。

.PARAMETER Force
  変更検知を無視して常に重量物を再生成・再アップロードする。

.PARAMETER SkipRegen
  重量物の再生成（pnpm install / corepack pack / playwright install）を省略し、
  既存のディスク上の成果物をそのまま固めてアップロードする（重量物更新が必要な場合のみ有効）。

.PARAMETER TagOnly
  タグ移動（ソース更新）だけを行う。依存解決器（pip download / pnpm install / playwright
  install）も重量物のアップロードも一切行わず、変更検知で重量物の更新が必要と判明した場合は
  **タグも動かさずに終了**する（旧バンドル×新ソースの不整合ペアを配らないため）。
  post-commit フック専用。

.PARAMETER SigningKey
  分離署名に使う RSA 秘密鍵（XML 形式）のパス。既定
  %USERPROFILE%\.offline-signing\bundle-signing.key.xml。鍵が無ければ重量物の公開は
  失敗する（署名失敗＝公開失敗。鍵の新規作成は offline\new-bundle-signing-key.bat）。

.EXAMPLE
  pwsh -File offline/publish-offline-bundle.ps1
#>
[CmdletBinding()]
param(
  [string]$Tag = 'offline-bundle-v1',
  [switch]$Force,
  [switch]$SkipRegen,
  [switch]$TagOnly,
  [string]$SigningKey = (Join-Path $env:USERPROFILE '.offline-signing\bundle-signing.key.xml')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ---- 共通ライブラリ（content-key 算出 / tar 解決 / 完全性検証） ----
. (Join-Path $PSScriptRoot 'lib\content-key.ps1')
. (Join-Path $PSScriptRoot 'lib\verify.ps1')

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

# tar 解決（System32\tar.exe 優先）は共通ライブラリの Resolve-Tar を使う。

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

# content-key は行末非依存（CR 除去で LF 正規化）の SHA256。共通ライブラリ Get-LockContentKey で算出。
$currentKey = Get-LockContentKey -LockFile $LockFile -PackageManager $packageManager
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

# -TagOnly（post-commit フック経路）は依存解決器を一切起動しない。重量物の更新が要ると
# 判明した時点で**タグも動かさずに**終了する: ここでタグだけ進めると「新ソース（新
# lockfile / 新 requirements）× 旧重量物」の不整合ペアを配ることになるため。
# 公開担当者は表示に従って引数なしの明示実行へ切り替える（所見 F20）。
if ($TagOnly -and $bundleChanged) {
  Write-Host '[skip] 重量物の更新が必要ですが -TagOnly のため何もしません（タグも動かしません）。'
  Write-Host '       依存解決器（pip download / pnpm install）はコミットフックからは実行しません。'
  Write-Host '       公開担当者は offline\publish-offline-bundle.bat を引数なしで実行してください。'
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
  exit 0
}
if ($bundleChanged) {
  Write-Host '[info] 重量物を更新します（-Force / 初回 / 変更検知）。'
} else {
  Write-Host '[info] 重量物は最新の Release と一致。ソース（タグ）のみ更新します。'
}

# ---- 重量物の生成（更新が必要な場合のみ） ----
$Store      = Join-Path $RepoRoot '.pnpm-store'
$PnpmTgz    = Join-Path $RepoRoot 'pnpm.tgz'
$MsPw       = Join-Path $RepoRoot 'ms-playwright'
$Wheelhouse = Join-Path $RepoRoot 'python-wheelhouse'
$GitTools   = Join-Path $RepoRoot 'git-tools'
$MermaidJs  = Join-Path $RepoRoot 'docs\_build\vendor\mermaid.min.js'
$MermaidElk = Join-Path $RepoRoot 'docs\_build\vendor\mermaid-layout-elk.min.js'
$NativePb   = Join-Path $RepoRoot 'native-prebuilds'
$BundleName = 'offline-deps-bundle.tar.gz'
$Bundle     = Join-Path $RepoRoot $BundleName
$Sha        = "$Bundle.sha256"
$SigFile    = "$Bundle.sig"
$KeyFile    = Join-Path $RepoRoot 'bundle.key'
$PinFile    = Join-Path $PSScriptRoot 'pinned-release.txt'
$PubKeyFile = Join-Path $PSScriptRoot 'bundle-signing.pub.xml'
$sizeMB     = $null
$bundleHash = $null

# 署名鍵は重い再生成の**前**に確認する（署名できない状態で 1 時間かけて固めない）。
# 署名失敗＝公開失敗（fail closed）。鍵の作成は offline\new-bundle-signing-key.bat。
$signingKeyXml = $null
if ($bundleChanged) {
  if (-not (Test-Path -LiteralPath $SigningKey)) {
    Write-Error ("[error] 署名鍵がありません: $SigningKey`n" +
      '  offline\new-bundle-signing-key.bat を 1 回実行して鍵ペアを作成してください（署名の無い重量物は公開しません）。')
    exit 1
  }
  if (-not (Test-Path -LiteralPath $PubKeyFile)) {
    Write-Error ("[error] 公開鍵が offline/ にありません: $PubKeyFile`n" +
      '  配布先はこのファイルだけを真正性の根拠にするため、コミットして offline/ ごと運ぶ必要があります。')
    exit 1
  }
  $signingKeyXml = Get-Content -LiteralPath $SigningKey -Raw
}

if ($bundleChanged) {
  $TarExe = Resolve-Tar
  if (-not $SkipRegen) {
    Require-Cmd 'corepack'

    Write-Host '[1/4] 依存を同梱ストアへ充填（pnpm fetch でロックファイル基準の完全充填）...'
    $env:COREPACK_ENABLE_DOWNLOAD_PROMPT = '0'
    # `pnpm install --store-dir` は node_modules が既に揃っていると no-op になり、後から
    # 追加された依存(特に dev)を store へ入れ損ねる(パッケージはグローバルストア経由で
    # node_modules に hardlink 済みのため再取得されない)。結果、key は一致するのに store の
    # 中身が不完全なバンドルが出来、オフライン機の `--offline` install が `knip 等が無い`で
    # 失敗する。`pnpm fetch` はロックファイル基準で全依存を store へ落とす(node_modules 非
    # 依存)ため store の完全性を担保できる。fetch は cwd の node_modules を消そうとするので、
    # ロックファイルと各 manifest だけを置いた一時 dir で実行し、本体の node_modules は触らない。
    $fetchTmp = Join-Path $env:TEMP ('offline-fetch-' + [System.Guid]::NewGuid().ToString('N').Substring(0, 8))
    New-Item -ItemType Directory -Path $fetchTmp | Out-Null
    try {
      Copy-Item (Join-Path $RepoRoot 'pnpm-lock.yaml') $fetchTmp
      foreach ($f in @('pnpm-workspace.yaml', 'package.json')) {
        $src = Join-Path $RepoRoot $f
        if (Test-Path -LiteralPath $src) { Copy-Item $src $fetchTmp }
      }
      # ワークスペース member の manifest をパス保持でコピー(fetch のワークスペース解決用)。
      foreach ($m in @('editor\shared', 'editor\server', 'editor\web', 'pie-chart', 'graph-editor', 'pdf-to-svg')) {
        $src = Join-Path $RepoRoot "$m\package.json"
        if (Test-Path -LiteralPath $src) {
          $dst = Join-Path $fetchTmp $m
          New-Item -ItemType Directory -Path $dst -Force | Out-Null
          Copy-Item $src $dst
        }
      }
      Push-Location $fetchTmp
      & corepack pnpm fetch --store-dir $Store
      $fetchExit = $LASTEXITCODE
      Pop-Location
    }
    finally {
      Remove-Item -Recurse -Force $fetchTmp -ErrorAction SilentlyContinue
    }
    if ($fetchExit -ne 0) { Write-Error '[error] pnpm fetch（ストア充填）に失敗しました。'; exit 1 }

    # node_modules をロックファイルと一致させる([3/4] の playwright exec 等が node_modules を要する)。
    # `--store-dir .pnpm-store` は通常開発のグローバルストアと異なるため、pnpm は既存 `node_modules` の
    # purge 確認を出す。post-commit フックは TTY が無く、既定では `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`
    # で中断して発行全体が落ちる(タグ移動/アップロード未達)。`--config.confirm-modules-purge=false` で
    # 非対話でも purge を進めさせる(`npm_config_*` 環境変数は pnpm 11 では効かないため CLI 設定で明示)。
    & corepack pnpm install --frozen-lockfile --store-dir $Store --config.confirm-modules-purge=false
    if ($LASTEXITCODE -ne 0) { Write-Error '[error] pnpm install に失敗しました。'; exit 1 }

    Write-Host "[2/4] pnpm 本体 tarball を取得（corepack pack pnpm@$pnpmVersion）..."
    # setup-offline.ps1 は `corepack install -g pnpm.tgz` で pnpm を復元するため、
    # corepack pack 形式（pnpm/<ver>/... ＋ .corepack マーカー）で固める必要がある。
    # npm pack 形式（package/... 始まり）は corepack install が拒否する
    # （Invalid archive format; did it get generated by 'corepack pack'?）。
    Get-ChildItem $RepoRoot -Filter 'pnpm-*.tgz' -File -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
    Remove-Item $PnpmTgz -Force -ErrorAction SilentlyContinue
    & corepack pack --output $PnpmTgz "pnpm@$pnpmVersion"
    if ($LASTEXITCODE -ne 0) { Write-Error '[error] corepack pack pnpm に失敗しました。'; exit 1 }
    if (-not (Test-Path $PnpmTgz)) { Write-Error '[error] pnpm.tgz が生成されませんでした。'; exit 1 }

    Write-Host '[3/4] Playwright Chromium を ms-playwright へ配置...'
    $env:PLAYWRIGHT_BROWSERS_PATH = $MsPw
    & corepack pnpm exec playwright install chromium
    if ($LASTEXITCODE -ne 0) { Write-Error '[error] playwright install に失敗しました。'; exit 1 }

    Write-Host '[4/4] Python 依存の wheel を python-wheelhouse へ収集（pip download）...'
    # pdf-to-svg / graph-editor の scripts\build.bat と docs\_build\build_all.bat は、この
    # python-wheelhouse から --no-index でオフライン install する。全 requirements.txt の和を
    # 1 ディレクトリへ収集する。
    $pyExe = $null
    foreach ($cand in @('py', 'python')) {
      if (Get-Command $cand -ErrorAction SilentlyContinue) { $pyExe = $cand; break }
    }
    if (-not $pyExe) { Write-Error '[error] Python が見つかりません（wheel 収集に必要）。'; exit 1 }
    $pyReqs = @('pdf-to-svg\requirements.txt', 'graph-editor\requirements.txt',
      'docs\_build\requirements.txt') |
      ForEach-Object { Join-Path $RepoRoot $_ } | Where-Object { Test-Path -LiteralPath $_ }
    if (-not $pyReqs) { Write-Error '[error] requirements.txt が見つかりません（pdf-to-svg / graph-editor / docs）。'; exit 1 }
    # requirements の許可リスト検査（所見 F20）。pip は requirements ファイル内のオプション行
    # （`--extra-index-url` / `--find-links` / `-e` 等）と直 URL 参照を尊重するため、この 1 行を
    # 混ぜるだけで解決先を攻撃者のインデックスへ差し替えられる。純粋な requirement specifier
    # 以外は一切通さない（許可リスト。危険オプションの列挙＝ブロックリストにはしない）。
    $reqViolations = @()
    foreach ($r in $pyReqs) { $reqViolations += (Test-OfflineRequirementsFile -Path $r) }
    if ($reqViolations.Count -gt 0) {
      Write-Error ("[error] requirements.txt に許可しない行があります:`n  " + ($reqViolations -join "`n  "))
      exit 1
    }
    Remove-Item $Wheelhouse -Recurse -Force -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Path $Wheelhouse | Out-Null
    # `--index-url` を明示して解決先を PyPI 本体へ固定し、`--only-binary=:all:` で sdist を
    # 排除する（sdist は取得しただけでビルド＝setup.py の実行に至る経路を開く）。
    # `--no-input` はプロンプト待ちでフックが固まるのを防ぐ。
    # なお `--no-deps` / `--require-hashes` は入れていない: 現行の requirements.txt は版も
    # ハッシュも固定していないため、入れると wheelhouse が推移依存を欠いて配布先の
    # オフライン install が壊れる。requirements の pin + hash 化は別作業（積み残し）。
    $dlArgs = @('-m', 'pip', 'download', '--no-input', '--disable-pip-version-check',
      '--index-url', 'https://pypi.org/simple', '--only-binary=:all:', '-d', $Wheelhouse)
    foreach ($r in $pyReqs) { $dlArgs += @('-r', $r) }
    & $pyExe @dlArgs
    if ($LASTEXITCODE -ne 0) { Write-Error '[error] pip download に失敗しました。'; exit 1 }
  } else {
    Write-Host '[info] -SkipRegen: 既存のディスク上の重量物をそのまま固めます。'
  }

  # git-tools（PortableGit / TortoiseGit）は air-gapped 環境で git を供給するため同梱する。
  # mermaid.min.js / mermaid-layout-elk.min.js と native-prebuilds（msnodesqlv8 の .node 入り
  # prebuild。npm tarball/.pnpm-store に入らない）は git 管理外（重量物）なので、ここで在庫を確認する。
  foreach ($p in @($Store, $PnpmTgz, $MsPw, $Wheelhouse, $GitTools, $MermaidJs, $MermaidElk, $NativePb)) {
    if (-not (Test-Path $p)) { Write-Error "[error] 重量物が見つかりません: $p（-SkipRegen 指定時は事前生成が必要）"; exit 1 }
  }

  # store の `v*/projects/<hash>` は fetch/install が作る「利用元プロジェクトへの絶対パス
  # symlink」(usage tracker)。バンドルには不要で、(a) 一時 dir 由来だと dangling になり tar が
  # stat 失敗する、(b) 配布先と無関係な絶対パスが混入する。配布先では `pnpm install` が作り直す
  # ため、固める前に除去する。content-addressable な files/ と index.db は残すので store は完全。
  Get-ChildItem -Path $Store -Directory -Filter 'v*' -ErrorAction SilentlyContinue | ForEach-Object {
    $proj = Join-Path $_.FullName 'projects'
    if (Test-Path -LiteralPath $proj) { Remove-Item -Recurse -Force -LiteralPath $proj -ErrorAction SilentlyContinue }
  }

  # ---- パッケージング（重量物のみ。ソースは含めない） ----
  Write-Host "[info] tar -czf $BundleName .pnpm-store pnpm.tgz ms-playwright python-wheelhouse git-tools docs/_build/vendor/mermaid*.js native-prebuilds ..."
  Remove-Item $Bundle -Force -ErrorAction SilentlyContinue
  & $TarExe -czf $Bundle -C $RepoRoot '.pnpm-store' 'pnpm.tgz' 'ms-playwright' 'python-wheelhouse' 'git-tools' 'docs/_build/vendor/mermaid.min.js' 'docs/_build/vendor/mermaid-layout-elk.min.js' 'native-prebuilds'
  if ($LASTEXITCODE -ne 0) { Write-Error '[error] tar に失敗しました。'; exit 1 }

  $sizeMB = [math]::Round((Get-Item $Bundle).Length / 1MB, 1)
  Write-Host "[info] bundle size: ${sizeMB}MB"
  if ((Get-Item $Bundle).Length -ge 2GB) {
    Write-Error '[error] アセットが 2GB（Release 上限）を超えました。分割が必要です。'; exit 1
  }

  # 整合性ハッシュとキーを書き出し。この .sha256 は配信元と同じ場所に並ぶため転送破損の
  # 検知にしか使えない（すり替えの検知には使えない）。真正性は下の分離署名と
  # offline\pinned-release.txt が担う。
  $bundleHash = (Get-FileHash $Bundle -Algorithm SHA256).Hash.ToLower()
  "$bundleHash  $BundleName" | Set-Content -Path $Sha -Encoding ascii -NoNewline
  $currentKey | Set-Content -Path $KeyFile -Encoding ascii -NoNewline

  Write-Host '[info] 重量物へ分離署名（RSA-SHA256）を付与します...'
  $sigB64 = New-DetachedSignatureBase64 -File $Bundle -PrivateKeyXml $signingKeyXml
  $sigB64 | Set-Content -Path $SigFile -Encoding ascii -NoNewline
  # 自分の公開鍵で即座に検証し、鍵の取り違え・書き出し失敗をここで落とす（fail closed）。
  Assert-BundleSignature -File $Bundle -SignaturePath $SigFile -PublicKeyPath $PubKeyFile
  Write-Host '[info] 署名 OK。'
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
- python-wheelhouse … Python ビルド依存の wheel（pdf-to-svg / graph-editor の exe ビルド用）
- git-tools … PortableGit / TortoiseGit（editor のテンプレ版管理に使う git。air-gapped 用）
- native-prebuilds … msnodesqlv8 の Node 24 用 prebuild（editor REST / pie-chart DB 入力のネイティブ .node）

## 取得手順（別端末・gh 不要）
1. 取得中のみリポジトリを Public にする
2. この offline/ フォルダ一式を別端末へ配置
3. ``offline\setup-offline.bat`` を実行（ソース＋重量物を自動取得・展開・構築）

## 変更管理
content key (sha256 of pnpm-lock.yaml + packageManager): ``$currentKey``
重量物に変更が無い限り再アップロードされません（``publish-offline-bundle.ps1`` が自動判定）。
ソース（自動 Source code）はコミット毎にタグ移動で更新されます。

## 完全性・真正性
重量物には分離署名 ``offline-deps-bundle.tar.gz.sig``（RSA-SHA256 / base64）を添えています。
検証に使う公開鍵と、取得すべきソースの**不変コミット ID**・各 sha256 は、リポジトリの
``offline/bundle-signing.pub.xml`` / ``offline/pinned-release.txt`` にあります（この 2 つは
offline/ フォルダごと手渡しで運ぶ前提）。**ここに並ぶ .sha256 は配信元と同じ場所にあるため、
転送破損の検知にしか使えません**（すり替えの検知には使えないので、setup は信頼しません）。
"@
$notesFile = Join-Path $tmp 'notes.md'
$notes | Set-Content -Path $notesFile -Encoding utf8

# ---- 公開コミットの解決とローリングタグ移動ヘルパ ----
# GitHub は公開リリースのタグに Source code (zip/tar.gz) を必ず自動添付し、これは削除できない。
# そこでタグを最新コミットへ動かし、自動 Source code を最新ソースに揃える。ただし「タグ移動」は
# 利用者 (setup-offline) が取得するソースZIP を切り替える操作であり、重量物アセットを差し替える
# 前にタグだけ進むと「新ソース (新 lockfile) × 旧 bundle.key / 旧ストア」の不整合 (lockfile 不整合)
# を生む。よって既存 Release では「アセット upload -> タグ移動」の順に行い、アセットが出揃うまで
# タグを進めない。upload 失敗時はタグが旧コミットのまま残り、ソースと重量物は旧版どうしで整合する。
$targetCommit = (& git rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($targetCommit)) {
  Write-Error '[error] git HEAD を取得できません。git リポジトリ内で実行してください。'; exit 1
}
# タグを HEAD へ強制更新する（`+` で force）。既存リリースはタグ名で紐づくため、タグが動いても
# リリースは維持され、自動 Source code だけが新コミットのツリーから再生成される。
# 新規時はこの push でリモートタグを作る。呼ぶ順序は下の分岐で制御する。
function Move-RollingTag {
  Write-Host "[info] タグ $Tag を $targetCommit へ移動します（自動 Source code を最新ソースへ）..."
  & git push origin "+${targetCommit}:refs/tags/$Tag"
  if ($LASTEXITCODE -ne 0) { Write-Error '[error] タグの移動 (git push) に失敗しました。'; exit 1 }
}

# 重量物アセット（更新時のみ）を Release へ差し替える。L243 から関数化し両分岐で共有する。
function Publish-Assets {
  if (-not $bundleChanged) { return }
  Write-Host '[info] アセットをアップロード（--clobber で差し替え）...'
  & gh release upload $Tag $Bundle $Sha $KeyFile $SigFile --clobber
  if ($LASTEXITCODE -ne 0) { Write-Error '[error] gh release upload に失敗しました。'; exit 1 }
}

# ---- Release 作成/更新（アセットを出してからタグを進める） ----
if (-not $releaseExists) {
  # 初回: タグ作成 -> Release 作成 -> アセット upload。まだ利用者が居ないため順序は無害。
  # （gh release create はタグ名で紐づくため、先にリモートタグを作っておく必要がある。）
  Move-RollingTag
  Write-Host "[info] Release $Tag を新規作成します。"
  & gh release create $Tag --title "Offline deps bundle ($Tag)" --notes-file $notesFile
  if ($LASTEXITCODE -ne 0) { Write-Error '[error] gh release create に失敗しました。'; exit 1 }
  Publish-Assets
} else {
  # 既存: 説明とアセットを先に差し替え、最後にだけタグを HEAD へ進める。これにより利用者が取得する
  # ソース (タグ) と重量物 (アセット) は常に整合ペアになり、upload 途中失敗でも不整合を作らない。
  Write-Host "[info] Release $Tag の説明を更新します。"
  & gh release edit $Tag --notes-file $notesFile | Out-Null
  Publish-Assets
  Move-RollingTag
}

# ---- pin ファイル（offline\pinned-release.txt）の更新 ----
# 配布先はローリングタグではなく**この pin の不変コミット ID**からソースを取り、pin の
# sha256 と突き合わせる（所見 F14）。タグ名は publish のたびに指す先が動くため、「タグで
# 取れた」ことは内容を何も同定しない。
# -TagOnly（post-commit フック）では書かない: フック経路で作業ツリーへ書き出すと、直後の
# コミットに巻き込まれるか dirty のまま残る。pin の更新は明示実行の公開に紐づける。
if (-not $TagOnly) {
  # gh の出力は複数行になりうるため 1 行目だけを取る（配列のまま Trim すると型が崩れる）。
  $nameWithOwner = ((& gh repo view --json nameWithOwner -q .nameWithOwner) | Select-Object -First 1)
  if ($nameWithOwner) { $nameWithOwner = ([string]$nameWithOwner).Trim() }
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($nameWithOwner)) {
    Write-Error '[error] gh repo view でリポジトリ名を取得できません（pin ファイルを更新できません）。'; exit 1
  }
  # ソース zip は「取得側が実際に落とすものと同じ URL」から取り、その sha256 を pin する。
  $srcZipUrl = "https://github.com/$nameWithOwner/archive/$targetCommit.zip"
  $srcZipTmp = Join-Path $tmp 'pinned-source.zip'
  Write-Host "[info] pin 用にソース zip を取得: $srcZipUrl"
  $curlCmd = Get-Command 'curl.exe' -ErrorAction SilentlyContinue
  if ($curlCmd) {
    & $curlCmd.Source -L --fail --retry 3 -o $srcZipTmp $srcZipUrl
    if ($LASTEXITCODE -ne 0) { Write-Error '[error] ソース zip の取得に失敗しました（pin を更新できません）。'; exit 1 }
  } else {
    $oldPref = $ProgressPreference
    $ProgressPreference = 'SilentlyContinue'
    try { Invoke-WebRequest -Uri $srcZipUrl -OutFile $srcZipTmp -UseBasicParsing }
    finally { $ProgressPreference = $oldPref }
  }
  $srcZipHash = (Get-FileHash -LiteralPath $srcZipTmp -Algorithm SHA256).Hash.ToLower()

  # 重量物を更新していない回は、直前の pin の bundle-sha256 を引き継ぐ（バンドルは同一実体
  # のままなのでハッシュも同一。ソース側だけ新しいコミットへ進める）。
  if (-not $bundleHash) {
    try { $bundleHash = (Get-OfflinePin -Path $PinFile).BundleSha256 }
    catch {
      Write-Error ("[error] 重量物を更新していないため既存 pin の bundle-sha256 が要りますが、読めません: $($_.Exception.Message)`n" +
        '  初回は -Force を付けて重量物ごと公開してください。')
      exit 1
    }
  }

  $pinText = @"
# offline 配布物の pin（publish-offline-bundle.ps1 が自動生成。手で編集しない）。
# 配布先の setup はこの値だけを真正性の根拠にする。Release に並ぶ .sha256 は配信元と同じ
# 場所から取る値なので転送破損の検知にしか使えず、すり替えの検知には使えない（所見 F14）。
# このファイルと bundle-signing.pub.xml は offline/ フォルダごと手渡しで配布先へ運ぶ。
source-commit $targetCommit
source-zip-sha256 $srcZipHash
bundle-sha256 $bundleHash
"@
  $pinText | Set-Content -LiteralPath $PinFile -Encoding utf8
  Write-Host "[info] pin を更新: $PinFile（source-commit=$targetCommit）"
  Write-Host '       ※ この pin ファイルを git へコミットしてください（offline/ ごと配布先へ運ぶ前提）。'
}

Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
if ($bundleChanged) {
  Write-Host "[OK] 公開完了: $Tag に $BundleName (${sizeMB}MB) / .sha256 / .sig / bundle.key を反映し、タグを最新ソースへ移動しました。"
} elseif ($TagOnly) {
  Write-Host "[OK] タグのみ更新（-TagOnly）: $Tag を最新コミットへ移動しました（依存解決器は実行していません）。"
} else {
  Write-Host "[OK] ソースのみ更新: タグ $Tag を最新コミットへ移動しました（重量物は据え置き）。"
}
