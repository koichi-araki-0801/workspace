<#
.SYNOPSIS
  editor の data リポジトリに、ファンド別画像の置き場(images)を用意する。

.DESCRIPTION
  既定は確認モードで、置き場の解決結果・行う変更・既に置かれた画像の点検結果を表示するだけで
  何も変えない。-Apply を付けたときだけ実行する。処理順:
    1. .gitignore に /images/ が無ければ追記する(画像を置く前に git の追跡外にしておく)
    2. <imagesDir> が無ければ作る
    3. .gitignore の変更を system 名義で 1 コミットする(件名末尾に [fund-images])
  既に置かれた画像は点検して報告するだけで、動かしも消しもしない。SVG の中身の検査はサーバ
  (TypeScript 実装)が正なので、ここでは行わない。違反はサーバログの警告で確認する。
  次の場合は中止する: editor サーバが動いている、dataRoot が git リポジトリでない、旧構成の
  assets が残っている(先に 2026-10-fonts-to-css を流す)、imagesDir が確定領域(templates /
  filled / css / sync)の内側にある、確定領域に未コミットの変更がある。
  ただし未コミットの変更が「.gitignore に /images/ の 1 行が追記されただけ」のときは中止せず、
  その差分をコミットに含める(新版のサーバが承認時に先に追記した場合)。

.PARAMETER DataRoot
  data リポジトリの場所。省略時は -DataRoot → 環境変数 DATA_ROOT(プロセス → ユーザー) →
  appconfig の paths.dataRoot → 既定の順で決める(2026-10-fonts-to-css と同じ規則)。

.PARAMETER Apply
  実際に変更する。付けなければ確認モード。

.PARAMETER Port
  稼働確認に使う editor サーバのポート(既定 24680)。

.EXAMPLE
  editor\patches\2026-10-fund-images\apply.bat
  確認モードで、何が変わるかと、置かれた画像の点検結果を表示する。

.EXAMPLE
  editor\patches\2026-10-fund-images\apply.bat -Apply
  置き場を用意する(サーバを止めてから)。
#>
param(
  [string]$DataRoot,
  [switch]$Apply,
  [int]$Port = 24680
)

$ErrorActionPreference = 'Stop'
$editorDir = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path))
$workspace = Split-Path -Parent $editorDir
$utf8NoBom = New-Object System.Text.UTF8Encoding $false
$confirmedAreas = 'templates', 'filled', 'css', 'sync'
$allowedExt = '.svg', '.png', '.jpg', '.jpeg'

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

function Test-TemplateToken([string]$s) {
  # shared/src/domain/template.ts の isValidTemplateToken と同じ規則の写し(パッチは TypeScript を
  # 呼べないため)。片方を変えたらもう片方も変える。
  if ($s.Length -eq 0 -or $s.Length -gt 200) { return $false }
  if ($s -match '[/\\:*?"<>|_]') { return $false }
  if ($s -match '[\x00-\x1f]') { return $false }
  if ($s.Contains('..')) { return $false }
  if ($s -ne $s.Trim() -or $s.EndsWith('.')) { return $false }
  if ($s -match '^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$') { return $false }
  return $true
}

function Test-FundImageName([string]$name) {
  # 命名の約束 <fund>_<画像名>.<拡張子>。fund はファイル名規約の 1 トークン。
  $stem = [IO.Path]::GetFileNameWithoutExtension($name)
  $cut = $stem.IndexOf('_')
  if ($cut -le 0 -or $cut -eq $stem.Length - 1) { return $false }
  return (Test-TemplateToken $stem.Substring(0, $cut))
}

# ── 1. 置き場の解決(2026-10-fonts-to-css の migrate.ps1 と同じ規則。共通 lib は作らない) ──
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

# images は IMAGES_DIR → appconfig の paths.imagesDir → <dataRoot>\images(サーバの config.ts と同じ順)。
$imagesSource = '既定(dataRoot\images)'
$imagesDir = Join-Path $DataRoot 'images'
if ($env:IMAGES_DIR) { $imagesDir = Resolve-EditorPath $env:IMAGES_DIR; $imagesSource = '環境変数 IMAGES_DIR' }
elseif (Get-CfgPath 'imagesDir') {
  $imagesDir = Resolve-EditorPath (Get-CfgPath 'imagesDir'); $imagesSource = 'appconfig の paths.imagesDir'
}
$imagesFull = [IO.Path]::GetFullPath($imagesDir).TrimEnd('\')

Write-Host "dataRoot : $DataRoot ($source)"
Write-Host "imagesDir: $imagesFull ($imagesSource)"
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
if (Test-Path -LiteralPath (Join-Path $DataRoot 'assets')) {
  throw ("$DataRoot\assets が残っています。フォント置き場の移行が済んでいない(または元に戻した)環境です。" +
    "先に editor\patches\2026-10-fonts-to-css\migrate.bat を流してください。")
}
foreach ($a in $confirmedAreas) {
  $area = [IO.Path]::GetFullPath((Join-Path $DataRoot $a)).TrimEnd('\')
  if ($imagesFull -ieq $area -or $imagesFull.StartsWith($area + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw ("imagesDir($imagesFull)が確定領域 $a の内側にあります。画像が承認コミットへ巻き込まれるため" +
      "中止しました。環境変数 IMAGES_DIR / appconfig の paths.imagesDir を見直してください。")
  }
}

function Test-OnlyImagesLineAdded {
  # 新版のサーバ(gitRepo.ts の ensureGitignore)は承認時に足りない必須行を末尾へ足す。足したのが
  # /images/ の 1 行だけなら、それはこのパッチがする変更と同じなので取り込んで進める。
  $lines = @(Invoke-Git diff HEAD --unified=0 --no-color -- .gitignore)
  $changes = @($lines | Where-Object { $_ -match '^[+-]' -and $_ -notmatch '^(\+\+\+|---)( |$)' })
  return ($changes.Count -eq 1 -and $changes[0] -ceq '+/images/')
}

# 見るのは確定領域(承認コミットの対象)だけ。css/fonts は git 管理外の置き場なので除く。
$dirty = @(Invoke-Git status --porcelain -- .gitignore .gitattributes templates filled css sync ':(exclude)css/fonts')
$pendingIgnoreOnly = $false
if ($dirty.Count -gt 0) {
  if ($dirty.Count -eq 1 -and $dirty[0] -match '^[ M]{2} \.gitignore$' -and (Test-OnlyImagesLineAdded)) {
    $pendingIgnoreOnly = $true
  } else {
    throw ("dataRoot の git に未コミットの変更があります。先にコミットまたは破棄してください:`n" +
      ($dirty -join "`n"))
  }
}

# ── 3. 計画と点検 ──
$gitignorePath = Join-Path $DataRoot '.gitignore'
$ignoreLines = if (Test-Path -LiteralPath $gitignorePath) { @([IO.File]::ReadAllLines($gitignorePath) | ForEach-Object { $_.Trim() }) } else { @() }
$needsIgnore = -not ($ignoreLines -contains '/images/')
$needsDir = -not (Test-Path -LiteralPath $imagesFull)

$report = @()
if (-not $needsDir) {
  foreach ($f in Get-ChildItem -LiteralPath $imagesFull -Recurse -File) {
    if ($f.DirectoryName.TrimEnd('\') -ine $imagesFull) {
      $report += "[subfolder] $($f.FullName) (images 直下以外は配信されません)"; continue
    }
    if ($allowedExt -notcontains $f.Extension.ToLowerInvariant()) {
      $report += "[extension] $($f.FullName) (許可外の拡張子は配信されません。.svg .png .jpg .jpeg)"; continue
    }
    if (-not (Test-FundImageName $f.Name)) {
      $report += "[naming] $($f.FullName) (命名 <fund>_<名前>.<拡張子> に合いません。配信はされます)"
    }
  }
}

Write-Host ".gitignore に /images/ を追記: $needsIgnore"
if ($pendingIgnoreOnly) { Write-Host '  (/images/ の 1 行が未コミットで追記済みです。この差分をコミットします)' }
Write-Host "images フォルダを作成: $needsDir"
if ($report.Count -gt 0) {
  Write-Host "【報告】置かれている画像の点検($($report.Count) 件。書き換えません):"
  $report | ForEach-Object { Write-Host "  $_" }
}
Write-Host 'SVG の中身の検査はサーバが行います。違反した SVG は表示されず、サーバログに警告が出ます。'
if (-not $Apply) { Write-Host ''; Write-Host '確認モードのため何も変えていません。実行するには -Apply を付けてください。'; return }

# ── 4. 適用 ──
if ($needsIgnore) {
  $current = if (Test-Path -LiteralPath $gitignorePath) { [IO.File]::ReadAllText($gitignorePath) } else { '' }
  if ($current -ne '' -and -not $current.EndsWith("`n")) { $current += "`n" }
  [IO.File]::WriteAllText($gitignorePath, $current + "/images/`n", $utf8NoBom)
}
if ($needsDir) { New-Item -ItemType Directory -Force -Path $imagesFull | Out-Null }
Invoke-Git add -- .gitignore | Out-Null
$staged = Invoke-Git diff --cached --name-only -- .gitignore
if ($staged) {
  # 末尾の [fund-images] は rollback.ps1 が git log --grep で探す ASCII の目印(日本語を
  # 引数で渡すと PowerShell 5.1 の文字コード変換で一致しなくなる)。
  Invoke-Git -c user.name=system -c user.email=system@editor.local commit -q -m '移行: 画像の置き場を追加 [fund-images]' -- .gitignore | Out-Null
  Write-Host '.gitignore の変更を system 名義でコミットしました。'
}
Write-Host '完了しました。editor を起動してください。'
