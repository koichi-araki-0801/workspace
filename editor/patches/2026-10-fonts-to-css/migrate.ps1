<#
.SYNOPSIS
  editor の data リポジトリを新構成へ移す(フォント: assets\fonts → css\fonts、js: assets\js → js)。

.DESCRIPTION
  既定は確認モードで、移動元・移動先、書き換える CSS、報告事項を表示するだけで何も変えない。
  -Apply を付けたときだけ実行する。処理順:
    1. .gitignore に /css/fonts/ を追記する(フォントが承認コミットへ巻き込まれないよう、移動より先)
    2. assets\fonts → <cssDir>\fonts、assets\js → <dataRoot>\js をコピーし、SHA256 で照合してから
       旧 assets\ を assets.migrated-<yyyyMMdd> へ改名して残す(共有フォルダでの途中失敗に備える)
    3. CSS の url( 直後の ../fonts/ を fonts/ に直す(css\*.css と、承認前の作業コピー
       drafts\*.css・pending\*.css・reviews\<id>\body.css)
    4. appconfig の paths.assetsDir を paths.jsDir(<旧 assetsDir>\js)へ書き換える
    5. 確定領域の変更(css/*.css と .gitignore)を system 名義で 1 コミットする
  作業コピー(drafts / pending / reviews)の CSS は git 管理外なので、書き換え前に
  <dataRoot>\.fonts-to-css-backup-<yyyyMMdd>\ へ退避する(rollback.ps1 がここから戻す)。
  置き場(dataRoot・drafts・pending・reviews・css・旧 assets)はサーバと同じ順(環境変数 →
  appconfig → dataRoot 配下の既定)で決め、出典を表示する。
  templates / filled の HTML 内の fonts/ 参照と、url(css/…) を持つ CSS は報告だけする。
  サーバ稼働中、または dataRoot の git に未コミットの変更があるときは中止する。

.PARAMETER DataRoot
  data リポジトリの場所。省略時は init-data-repo.ps1 と同じ規則(環境変数 DATA_ROOT → ユーザー
  環境変数 DATA_ROOT → 既定)で決める。

.PARAMETER Apply
  実際に変更する。付けなければ確認モード。

.PARAMETER Port
  稼働確認に使う editor サーバのポート(既定 24680)。

.EXAMPLE
  editor\patches\2026-10-fonts-to-css\migrate.bat
  確認モードで、何が変わるかを表示する。

.EXAMPLE
  editor\patches\2026-10-fonts-to-css\migrate.bat -Apply
  移行を実行する(サーバを止めてから)。
#>
param(
  [string]$DataRoot,
  [switch]$Apply,
  [int]$Port = 24680
)

$ErrorActionPreference = 'Stop'
$editorDir = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path))
$workspace = Split-Path -Parent $editorDir
$stamp = Get-Date -Format 'yyyyMMdd'
$utf8NoBom = New-Object System.Text.UTF8Encoding $false

function Resolve-EditorPath([string]$p) {
  # サーバ(config.ts の toPath)は相対パスを editor/ 基準で解決するので合わせる。
  if ([IO.Path]::IsPathRooted($p)) { return $p }
  return [IO.Path]::GetFullPath((Join-Path $editorDir $p))
}

function Invoke-Git {
  # git は LF→CRLF 変換などの警告を stderr へ出す。$ErrorActionPreference = 'Stop' のままだと
  # PowerShell 5.1 がそれを例外にするので、stderr は自前で受けて終了コードで失敗を判定する。
  # 成功時の警告は捨て、失敗時だけ原因として例外メッセージへ載せる。
  $ErrorActionPreference = 'Continue'
  $all = @(& git -C $DataRoot @args 2>&1)
  if ($LASTEXITCODE -ne 0) {
    $err = ($all | Where-Object { $_ -is [Management.Automation.ErrorRecord] } | ForEach-Object { $_.ToString() }) -join "`n"
    throw "git $($args -join ' ') が失敗しました(終了コード $LASTEXITCODE)。`n$err"
  }
  return @($all | Where-Object { $_ -isnot [Management.Automation.ErrorRecord] })
}

# ── 1. 置き場の解決(サーバの config.ts と同じ順: 環境変数 → appconfig → 既定) ──
$appConfigPath = if ($env:APP_CONFIG) { $env:APP_CONFIG } else { Join-Path $editorDir 'appconfig.json' }
$appConfig = $null
if (Test-Path -LiteralPath $appConfigPath) {
  $appConfig = Get-Content -Raw -Encoding UTF8 -LiteralPath $appConfigPath | ConvertFrom-Json
}
$cfgPaths = if ($appConfig -and $appConfig.paths) { $appConfig.paths } else { $null }

function Get-CfgPath([string]$key) {
  if ($cfgPaths -and $cfgPaths.PSObject.Properties[$key] -and $cfgPaths.$key) { return [string]$cfgPaths.$key }
  return $null
}

# -DataRoot 引数が最優先。なければ DATA_ROOT(プロセス → ユーザー)→ appconfig の paths.dataRoot
# → 既定(サーバの既定と同じ editor の 2 つ上の editor-data)。
$source = '-DataRoot 引数'
if (-not $DataRoot) {
  $DataRoot = $env:DATA_ROOT; $source = '環境変数 DATA_ROOT'
  if (-not $DataRoot) {
    $DataRoot = [Environment]::GetEnvironmentVariable('DATA_ROOT', 'User'); $source = 'ユーザー環境変数 DATA_ROOT'
  }
  if (-not $DataRoot) { $DataRoot = Get-CfgPath 'dataRoot'; $source = 'appconfig の paths.dataRoot' }
  if ($DataRoot) { $DataRoot = Resolve-EditorPath $DataRoot }
  else { $DataRoot = Join-Path (Split-Path -Parent $workspace) 'editor-data'; $source = '既定' }
}

# dataRoot 配下の置き場は 環境変数 → appconfig → <dataRoot>\<sub> の順で決め、出典を返す。
function Resolve-Place([string]$envName, [string]$key, [string]$sub) {
  $e = [Environment]::GetEnvironmentVariable($envName)
  if ($e) { return @{ Path = (Resolve-EditorPath $e); Source = "環境変数 $envName" } }
  $c = Get-CfgPath $key
  if ($c) { return @{ Path = (Resolve-EditorPath $c); Source = "appconfig の paths.$key" } }
  return @{ Path = (Join-Path $DataRoot $sub); Source = "既定(dataRoot\$sub)" }
}
$cssPlace = Resolve-Place 'CSS_DIR' 'cssDir' 'css'
$assetsPlace = Resolve-Place 'ASSETS_DIR' 'assetsDir' 'assets'
$draftsPlace = Resolve-Place 'DRAFTS_DIR' 'draftsDir' 'drafts'
$pendingPlace = Resolve-Place 'PENDING_DIR' 'pendingDir' 'pending'
$reviewsPlace = Resolve-Place 'REVIEWS_DIR' 'reviewsDir' 'reviews'
$cssDir = $cssPlace.Path
$assetsDir = $assetsPlace.Path
$jsDir = Join-Path $DataRoot 'js'

Write-Host "dataRoot : $DataRoot ($source)"
Write-Host "cssDir   : $cssDir ($($cssPlace.Source))"
Write-Host "旧 assets: $assetsDir ($($assetsPlace.Source))"
Write-Host "jsDir    : $jsDir"
Write-Host "drafts   : $($draftsPlace.Path) ($($draftsPlace.Source))"
Write-Host "pending  : $($pendingPlace.Path) ($($pendingPlace.Source))"
Write-Host "reviews  : $($reviewsPlace.Path) ($($reviewsPlace.Source))"
Write-Host ("モード   : " + $(if ($Apply) { '適用(-Apply)' } else { '確認(何も変えません)' }))
Write-Host ''

# ── 2. 実行条件 ──
$listening = $false
try {
  $client = New-Object Net.Sockets.TcpClient
  $listening = $client.ConnectAsync('127.0.0.1', $Port).Wait(500)
  $client.Close()
} catch { $listening = $false }
if ($listening) { throw "editor サーバがポート $Port で動いています。停止してから実行してください。" }
if (-not (Test-Path -LiteralPath (Join-Path $DataRoot '.git'))) { throw "$DataRoot は git リポジトリではありません。" }
# 見るのは確定領域(承認コミットの対象)だけ。js\ や assets.migrated-* のような追跡外の
# フォルダまで見ると、移行後の再実行が「未コミットの変更あり」で止まってしまう。
$dirty = Invoke-Git status --porcelain -- .gitignore .gitattributes templates filled css sync
if ($dirty) {
  throw ("dataRoot の git に未コミットの変更があります。先にコミットまたは破棄してください。`n" +
    "前回の移行が途中で止まった可能性もあります。git -C `"$DataRoot`" diff で確認し、パッチの変更" +
    "(.gitignore の /css/fonts/ 行と ../fonts/ → fonts/ の書き換え)だけなら、system 名義でコミットして" +
    "から再実行してください:`n$($dirty -join "`n")")
}

# ── 3. 計画 ──
function Get-FileHashHex([string]$p) { (Get-FileHash -Algorithm SHA256 -LiteralPath $p).Hash }

$moves = @()
foreach ($pair in @(@{ From = (Join-Path $assetsDir 'fonts'); To = (Join-Path $cssDir 'fonts') },
                    @{ From = (Join-Path $assetsDir 'js'); To = $jsDir })) {
  if (-not (Test-Path -LiteralPath $pair.From)) { continue }
  foreach ($f in Get-ChildItem -LiteralPath $pair.From -Recurse -File) {
    $rel = $f.FullName.Substring($pair.From.Length).TrimStart('\')
    $dest = Join-Path $pair.To $rel
    if (Test-Path -LiteralPath $dest) {
      if ((Get-FileHashHex $dest) -ne (Get-FileHashHex $f.FullName)) {
        throw "競合: $dest に別の内容があります(移動元 $($f.FullName))。どちらを残すか決めてから再実行してください。"
      }
      continue
    }
    $moves += @{ From = $f.FullName; To = $dest }
  }
}

$rewriteRe = '(?i)(url\(\s*["'']?)\.\./fonts/'
$confirmedCss = @(Get-ChildItem -LiteralPath $cssDir -Filter '*.css' -File -ErrorAction SilentlyContinue)
$workCss = @()
foreach ($p in $draftsPlace, $pendingPlace) {
  $workCss += Get-ChildItem -LiteralPath $p.Path -Filter '*.css' -File -ErrorAction SilentlyContinue
}
$workCss += Get-ChildItem -LiteralPath $reviewsPlace.Path -Filter 'body.css' -File -Recurse -ErrorAction SilentlyContinue
$cssTargets = @($confirmedCss) + @($workCss)
$rewrites = @($cssTargets | Where-Object { (Get-Content -Raw -Encoding UTF8 -LiteralPath $_.FullName) -match $rewriteRe })
# 作業コピーは git 管理外で revert できないので、書き換える前に退避して rollback の復元元にする。
$workRewrites = @($rewrites | Where-Object { $workCss.FullName -contains $_.FullName })
$backupRoot = Join-Path $DataRoot ".fonts-to-css-backup-$stamp"

$reportHtml = @()
foreach ($d in 'templates', 'filled') {
  foreach ($f in Get-ChildItem -LiteralPath (Join-Path $DataRoot $d) -Filter '*.html' -File -ErrorAction SilentlyContinue) {
    if ((Get-Content -Raw -Encoding UTF8 -LiteralPath $f.FullName) -match '(?i)(url\(\s*["'']?|(href|src)\s*=\s*["'']?)fonts/') {
      $reportHtml += $f.FullName
    }
  }
}
$reportCssCss = @($cssTargets | Where-Object { (Get-Content -Raw -Encoding UTF8 -LiteralPath $_.FullName) -match '(?i)url\(\s*["'']?css/' })
$gitignorePath = Join-Path $DataRoot '.gitignore'
$needsIgnore = -not ((Get-Content -LiteralPath $gitignorePath -ErrorAction SilentlyContinue) -contains '/css/fonts/')
$needsConfig = [bool]($cfgPaths -and $cfgPaths.assetsDir)

Write-Host "コピーするファイル: $($moves.Count) 件"
$moves | ForEach-Object { Write-Host "  $($_.From) -> $($_.To)" }
Write-Host "../fonts/ を書き換える CSS: $($rewrites.Count) 件"
$rewrites | ForEach-Object { Write-Host "  $($_.FullName)" }
if ($workRewrites.Count -gt 0) { Write-Host "うち作業コピー $($workRewrites.Count) 件は書き換え前に $backupRoot へ退避します。" }
Write-Host ".gitignore に /css/fonts/ を追記: $needsIgnore"
Write-Host "appconfig の paths.assetsDir を paths.jsDir へ: $needsConfig"
if ($env:ASSETS_DIR) { Write-Host "※ 環境変数 ASSETS_DIR が設定されています。JS_DIR=$jsDir に置き換えてください(パッチは環境変数を変えません)。" }
if ($reportHtml.Count -gt 0) {
  Write-Host "【報告】HTML 内に fonts/ 参照があります(移行後は配信されません。承認経路で css/fonts/ へ直してください):"
  $reportHtml | ForEach-Object { Write-Host "  $_" }
}
if ($reportCssCss.Count -gt 0) {
  Write-Host "【報告】url(css/…) を持つ CSS があります(新しい規則では css/css/ になります):"
  $reportCssCss | ForEach-Object { Write-Host "  $($_.FullName)" }
}
if (-not $Apply) { Write-Host ''; Write-Host '確認モードのため何も変えていません。実行するには -Apply を付けてください。'; return }

# ── 4. 適用 ──
if ($needsIgnore) {
  $current = if (Test-Path -LiteralPath $gitignorePath) { [IO.File]::ReadAllText($gitignorePath) } else { '' }
  if ($current -ne '' -and -not $current.EndsWith("`n")) { $current += "`n" }
  [IO.File]::WriteAllText($gitignorePath, $current + "/css/fonts/`n", $utf8NoBom)
}
foreach ($m in $moves) {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $m.To) | Out-Null
  Copy-Item -LiteralPath $m.From -Destination $m.To
  if ((Get-FileHashHex $m.To) -ne (Get-FileHashHex $m.From)) { throw "照合に失敗しました: $($m.To)" }
}
if ((Test-Path -LiteralPath $assetsDir) -and ($moves.Count -gt 0 -or (Test-Path -LiteralPath (Join-Path $assetsDir 'fonts')) -or (Test-Path -LiteralPath (Join-Path $assetsDir 'js')))) {
  Rename-Item -LiteralPath $assetsDir -NewName ("{0}.migrated-{1}" -f (Split-Path -Leaf $assetsDir), $stamp)
}
if ($workRewrites.Count -gt 0) {
  # マニフェストは「退避先の相対パス<TAB>元の絶対パス」。dataRoot の外にある置き場は _external 配下へ
  # 置く(ドライブのコロンは除く)。既存の退避は上書きしない(最初の状態を残すため)。
  New-Item -ItemType Directory -Force -Path $backupRoot | Out-Null
  $manifestPath = Join-Path $backupRoot 'manifest.tsv'
  $entries = @{}
  if (Test-Path -LiteralPath $manifestPath) {
    foreach ($line in [IO.File]::ReadAllLines($manifestPath, $utf8NoBom)) {
      $parts = $line -split "`t", 2
      if ($parts.Count -eq 2) { $entries[$parts[0]] = $parts[1] }
    }
  }
  $prefix = $DataRoot.TrimEnd('\') + '\'
  foreach ($f in $workRewrites) {
    $full = $f.FullName
    $rel = if ($full.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { $full.Substring($prefix.Length) }
      else { '_external\' + ($full -replace ':', '' -replace '^\\\\', 'unc\') }
    $dest = Join-Path $backupRoot $rel
    if (-not (Test-Path -LiteralPath $dest)) {
      New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dest) | Out-Null
      Copy-Item -LiteralPath $full -Destination $dest
    }
    $entries[$rel] = $full
  }
  [IO.File]::WriteAllLines($manifestPath, [string[]]@($entries.Keys | Sort-Object | ForEach-Object { "$_`t$($entries[$_])" }), $utf8NoBom)
}
foreach ($f in $rewrites) {
  $text = [IO.File]::ReadAllText($f.FullName)
  [IO.File]::WriteAllText($f.FullName, ($text -replace $rewriteRe, '${1}fonts/'), $utf8NoBom)
}
if ($needsConfig) {
  Copy-Item -LiteralPath $appConfigPath -Destination "$appConfigPath.bak-$stamp"
  $newJs = Join-Path (Resolve-EditorPath $cfgPaths.assetsDir) 'js'
  $cfgPaths.PSObject.Properties.Remove('assetsDir')
  $cfgPaths | Add-Member -NotePropertyName 'jsDir' -NotePropertyValue $newJs -Force
  [IO.File]::WriteAllText($appConfigPath, ($appConfig | ConvertTo-Json -Depth 10), $utf8NoBom)
}
Invoke-Git add -- .gitignore css | Out-Null
$staged = Invoke-Git diff --cached --name-only
if ($staged) {
  # 末尾の [fonts-to-css] は rollback.ps1 が git log --grep で探す ASCII の目印(日本語を
  # 引数で渡すと PowerShell 5.1 の文字コード変換で一致しなくなる)。
  Invoke-Git -c user.name=system -c user.email=system@editor.local commit -q -m '移行: フォント置き場の移設(assets/fonts → css/fonts) [fonts-to-css]'
  Write-Host '確定領域の変更を system 名義でコミットしました。'
}
Write-Host '移行が完了しました。editor を起動してください。'
