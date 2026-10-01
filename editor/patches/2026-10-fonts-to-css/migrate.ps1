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
  # PowerShell 5.1 がそれを例外にするので、stderr は捨てて終了コードだけで失敗を判定する。
  $ErrorActionPreference = 'Continue'
  $out = & git -C $DataRoot @args 2>$null
  if ($LASTEXITCODE -ne 0) { throw "git $($args -join ' ') が失敗しました(終了コード $LASTEXITCODE)。" }
  return $out
}

# ── 1. 置き場の解決(init-data-repo.ps1 と同じ規則 + 個別の上書き設定) ──
$source = '-DataRoot 引数'
if (-not $DataRoot) {
  $DataRoot = $env:DATA_ROOT; $source = '環境変数 DATA_ROOT'
  if (-not $DataRoot) {
    $DataRoot = [Environment]::GetEnvironmentVariable('DATA_ROOT', 'User'); $source = 'ユーザー環境変数 DATA_ROOT'
  }
  if ($DataRoot) { $DataRoot = Resolve-EditorPath $DataRoot }
  else { $DataRoot = Join-Path (Split-Path -Parent $workspace) 'editor-data'; $source = '既定' }
}
$appConfigPath = if ($env:APP_CONFIG) { $env:APP_CONFIG } else { Join-Path $editorDir 'appconfig.json' }
$appConfig = $null
if (Test-Path -LiteralPath $appConfigPath) {
  $appConfig = Get-Content -Raw -Encoding UTF8 -LiteralPath $appConfigPath | ConvertFrom-Json
}
$cfgPaths = if ($appConfig -and $appConfig.paths) { $appConfig.paths } else { $null }
$cssDir = if ($env:CSS_DIR) { Resolve-EditorPath $env:CSS_DIR }
  elseif ($cfgPaths -and $cfgPaths.cssDir) { Resolve-EditorPath $cfgPaths.cssDir }
  else { Join-Path $DataRoot 'css' }
$assetsDir = if ($env:ASSETS_DIR) { Resolve-EditorPath $env:ASSETS_DIR }
  elseif ($cfgPaths -and $cfgPaths.assetsDir) { Resolve-EditorPath $cfgPaths.assetsDir }
  else { Join-Path $DataRoot 'assets' }
$jsDir = Join-Path $DataRoot 'js'

Write-Host "dataRoot : $DataRoot ($source)"
Write-Host "cssDir   : $cssDir"
Write-Host "旧 assets: $assetsDir"
Write-Host "jsDir    : $jsDir"
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
if ($dirty) { throw "dataRoot の git に未コミットの変更があります。先にコミットまたは破棄してください:`n$dirty" }

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
$cssTargets = @()
$cssTargets += Get-ChildItem -LiteralPath $cssDir -Filter '*.css' -File -ErrorAction SilentlyContinue
foreach ($d in 'drafts', 'pending') {
  $cssTargets += Get-ChildItem -LiteralPath (Join-Path $DataRoot $d) -Filter '*.css' -File -ErrorAction SilentlyContinue
}
$cssTargets += Get-ChildItem -LiteralPath (Join-Path $DataRoot 'reviews') -Filter 'body.css' -File -Recurse -ErrorAction SilentlyContinue
$rewrites = @($cssTargets | Where-Object { (Get-Content -Raw -Encoding UTF8 -LiteralPath $_.FullName) -match $rewriteRe })

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
