<#
.SYNOPSIS
  2026-10-fonts-to-css の移行を元に戻す。

.DESCRIPTION
  既定は確認モード。-Apply を付けたときだけ実行する。処理順:
    1. 移行コミット(作者 system、件名に [fonts-to-css])を git revert する。すでに revert 済みなら
       飛ばす(rollback 自身の Revert コミットは移行コミットとして拾わない)
    2. assets.migrated-<日付> を assets へ改名して戻す
    3. 移行で作った css\fonts と js のうち、assets.migrated-<日付> に同じ相対パス・同じ SHA256 の
       ファイルがあるものだけ削除する。移行後に置かれたファイルは消さず、一覧を表示して残す。
       空になったフォルダだけ消す
    4. <dataRoot>\.fonts-to-css-backup-<日付>\ に退避した作業コピー(drafts / pending / reviews の
       CSS)を元の場所へ戻す。退避に無いファイルは触らない。移行後にこれらを編集していた場合、
       その編集は退避時点の内容で上書きされる
    5. appconfig.json.bak-<日付> があれば appconfig.json へ戻す
  git revert が競合したときは revert --abort で元の状態へ戻してから中止する。
  実行前に editor サーバを止め、戻したあとは旧版の editor を配置して起動すること。

.PARAMETER DataRoot
  data リポジトリの場所(省略時は migrate.ps1 と同じ規則: 環境変数 DATA_ROOT → ユーザー環境変数
  DATA_ROOT → appconfig の paths.dataRoot → 既定)。

.PARAMETER Date
  戻す移行の日付(yyyyMMdd)。省略時は assets.migrated-* が 1 つだけならそれを使う。

.PARAMETER Apply
  実際に戻す。付けなければ確認モード。
#>
param([string]$DataRoot, [string]$Date, [switch]$Apply)

$ErrorActionPreference = 'Stop'
$editorDir = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path))
$workspace = Split-Path -Parent $editorDir
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

function Get-FileHashHex([string]$p) { (Get-FileHash -Algorithm SHA256 -LiteralPath $p).Hash }

# ── 1. 置き場の解決(migrate.ps1 と同じ規則) ──
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
if (-not $DataRoot) {
  $DataRoot = $env:DATA_ROOT
  if (-not $DataRoot) { $DataRoot = [Environment]::GetEnvironmentVariable('DATA_ROOT', 'User') }
  if (-not $DataRoot) { $DataRoot = Get-CfgPath 'dataRoot' }
  if ($DataRoot) { $DataRoot = Resolve-EditorPath $DataRoot }
  else { $DataRoot = Join-Path (Split-Path -Parent $workspace) 'editor-data' }
}
$cssDir = if ($env:CSS_DIR) { Resolve-EditorPath $env:CSS_DIR }
  elseif (Get-CfgPath 'cssDir') { Resolve-EditorPath (Get-CfgPath 'cssDir') }
  else { Join-Path $DataRoot 'css' }
$jsDir = Join-Path $DataRoot 'js'

# ── 2. 戻す対象の特定 ──
$migrated = @(Get-ChildItem -LiteralPath $DataRoot -Directory -Filter 'assets.migrated-*')
if ($Date) { $migrated = @($migrated | Where-Object { $_.Name -eq "assets.migrated-$Date" }) }
if ($migrated.Count -ne 1) { throw "戻す対象の assets.migrated-* が 1 つに決まりません。-Date で指定してください。" }
$stamp = $migrated[0].Name.Substring('assets.migrated-'.Length)

# 移行コミットだけを選ぶ。rollback 自身の revert コミットも件名に [fonts-to-css] を含むので、
# Revert で始まる件名は除く。すでに revert 済み(This reverts commit <sha>)なら再 revert しない。
$commit = $null
$alreadyReverted = $false
foreach ($line in (Invoke-Git log --author=system --grep '\[fonts-to-css\]' --format='%H %s')) {
  $sha, $subject = $line -split ' ', 2
  if ($subject -like 'Revert *') { continue }
  $commit = $sha
  break
}
if ($commit -and (Invoke-Git log --grep "This reverts commit $commit" --format=%H -1)) { $alreadyReverted = $true }

# css\fonts と js は、退避した旧 assets に同一内容がある分だけ消す。
$deletes = @(); $keeps = @()
foreach ($pair in @(@{ Dir = (Join-Path $cssDir 'fonts'); Old = (Join-Path $migrated[0].FullName 'fonts') },
                    @{ Dir = $jsDir; Old = (Join-Path $migrated[0].FullName 'js') })) {
  if (-not (Test-Path -LiteralPath $pair.Dir)) { continue }
  foreach ($f in Get-ChildItem -LiteralPath $pair.Dir -Recurse -File) {
    $rel = $f.FullName.Substring($pair.Dir.Length).TrimStart('\')
    $old = Join-Path $pair.Old $rel
    if ((Test-Path -LiteralPath $old) -and ((Get-FileHashHex $old) -eq (Get-FileHashHex $f.FullName))) { $deletes += $f.FullName }
    else { $keeps += $f.FullName }
  }
}

# 作業コピーの退避。
$backupRoot = Join-Path $DataRoot ".fonts-to-css-backup-$stamp"
$manifestPath = Join-Path $backupRoot 'manifest.tsv'
$restores = @()
if (Test-Path -LiteralPath $manifestPath) {
  foreach ($line in [IO.File]::ReadAllLines($manifestPath, $utf8NoBom)) {
    $parts = $line -split "`t", 2
    if ($parts.Count -ne 2) { continue }
    $src = Join-Path $backupRoot $parts[0]
    if (Test-Path -LiteralPath $src) { $restores += @{ From = $src; To = $parts[1] } }
  }
}
$bak = "$appConfigPath.bak-$stamp"

Write-Host "dataRoot: $DataRoot"
if (-not $commit) { Write-Host 'revert するコミット: (なし)' }
elseif ($alreadyReverted) { Write-Host "revert するコミット: $commit(revert 済みのため飛ばします)" }
else { Write-Host "revert するコミット: $commit" }
Write-Host "改名して戻す: $($migrated[0].FullName) -> assets"
Write-Host "削除するファイル(退避した旧 assets と同一内容): $($deletes.Count) 件"
$deletes | ForEach-Object { Write-Host "  $_" }
if ($keeps.Count -gt 0) {
  Write-Host "【残す】旧 assets に同一内容が無いファイル(移行後に置かれたもの)。消さずに残します: $($keeps.Count) 件"
  $keeps | ForEach-Object { Write-Host "  $_" }
}
Write-Host "退避から戻す作業コピー: $($restores.Count) 件"
$restores | ForEach-Object { Write-Host "  $($_.To)" }
Write-Host "appconfig を戻す: $(if (Test-Path -LiteralPath $bak) { $bak } else { '(バックアップなし)' })"
if (-not $Apply) { Write-Host '確認モードのため何も変えていません。実行するには -Apply を付けてください。'; return }

# ── 3. 適用 ──
if ($commit -and -not $alreadyReverted) {
  try {
    Invoke-Git -c user.name=system -c user.email=system@editor.local revert --no-edit $commit | Out-Null
  } catch {
    # 競合したまま止まると REVERTING 状態と競合マーカーが残るので、元の状態へ戻してから中止する。
    try { Invoke-Git revert --abort | Out-Null } catch { Write-Warning 'git revert --abort にも失敗しました。手動で確認してください。' }
    throw
  }
}
Rename-Item -LiteralPath $migrated[0].FullName -NewName 'assets'
foreach ($p in $deletes) { Remove-Item -LiteralPath $p -Force }
foreach ($root in (Join-Path $cssDir 'fonts'), $jsDir) {
  if (-not (Test-Path -LiteralPath $root)) { continue }
  # 深いフォルダから順に、空になったものだけ消す。
  Get-ChildItem -LiteralPath $root -Recurse -Directory | Sort-Object { $_.FullName.Length } -Descending | ForEach-Object {
    if (-not (Get-ChildItem -LiteralPath $_.FullName -Force)) { Remove-Item -LiteralPath $_.FullName -Force }
  }
  if (-not (Get-ChildItem -LiteralPath $root -Force)) { Remove-Item -LiteralPath $root -Force }
}
foreach ($r in $restores) {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $r.To) | Out-Null
  Copy-Item -LiteralPath $r.From -Destination $r.To -Force
}
if (Test-Path -LiteralPath $bak) { Copy-Item -LiteralPath $bak -Destination $appConfigPath -Force }
Write-Host '元に戻しました。旧版の editor を配置して起動してください。'
