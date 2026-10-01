<#
.SYNOPSIS
  2026-10-fund-images の変更(.gitignore の /images/)を元に戻す。

.DESCRIPTION
  既定は確認モード。-Apply を付けたときだけ実行する。目印 [fund-images] を持つ移行コミット
  (Revert で始まる件名は除く)を git revert する。すでに revert 済みなら何もしない。
  git revert が失敗したときは revert --abort で元の状態へ戻してから中止し、git の出力を表示する。
  images フォルダと中の画像は消さない(別ツールが置いた git 管理外のもので、戻せないため)。
  新版のサーバは承認時に /images/ を再び追記するので、戻す意味があるのはサーバも旧版へ戻す
  場合に限る。

.PARAMETER DataRoot
  data リポジトリの場所(省略時は apply.ps1 と同じ規則)。

.PARAMETER Apply
  実際に戻す。付けなければ確認モード。
#>
param([string]$DataRoot, [switch]$Apply)

$ErrorActionPreference = 'Stop'
$editorDir = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path))
$workspace = Split-Path -Parent $editorDir

function Resolve-EditorPath([string]$p) {
  # サーバ(config.ts の toPath)は相対パスを editor/ 基準で解決するので合わせる。
  if ([IO.Path]::IsPathRooted($p)) { return $p }
  return [IO.Path]::GetFullPath((Join-Path $editorDir $p))
}

function Invoke-Git {
  # stderr の扱いは apply.ps1 と同じ(成功時の警告は捨て、失敗時だけ例外に載せる)。
  $ErrorActionPreference = 'Continue'
  $all = @(& git -C $DataRoot @args 2>&1)
  if ($LASTEXITCODE -ne 0) {
    $err = ($all | Where-Object { $_ -is [Management.Automation.ErrorRecord] } | ForEach-Object { $_.ToString() }) -join "`n"
    throw "git $($args -join ' ') が失敗しました(終了コード $LASTEXITCODE)。`n$err"
  }
  return @($all | Where-Object { $_ -isnot [Management.Automation.ErrorRecord] })
}

# ── 1. 置き場の解決(apply.ps1 と同じ規則) ──
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
$imagesDir = if ($env:IMAGES_DIR) { Resolve-EditorPath $env:IMAGES_DIR }
  elseif (Get-CfgPath 'imagesDir') { Resolve-EditorPath (Get-CfgPath 'imagesDir') }
  else { Join-Path $DataRoot 'images' }

# ── 2. 戻す対象の特定 ──
# rollback 自身の revert コミットも件名に [fund-images] を含むので、Revert で始まる件名は除く。
# すでに revert 済み(This reverts commit <sha>)なら再 revert しない。
$commit = $null
foreach ($line in (Invoke-Git log --author=system --grep '\[fund-images\]' --format='%H %s')) {
  $sha, $subject = $line -split ' ', 2
  if ($subject -like 'Revert *') { continue }
  $commit = $sha
  break
}
$alreadyReverted = [bool]($commit -and (Invoke-Git log --grep "This reverts commit $commit" --format=%H -1))

Write-Host "dataRoot: $DataRoot"
if (-not $commit) { Write-Host 'revert するコミット: (なし)' }
elseif ($alreadyReverted) { Write-Host "revert するコミット: $commit(revert 済みのため飛ばします)" }
else { Write-Host "revert するコミット: $commit" }
Write-Host "images フォルダ($imagesDir)と中の画像は消しません。不要なら手で消してください。"
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
Write-Host '元に戻しました。サーバも旧版へ戻す場合だけ意味があります(新版は承認時に /images/ を再び追記します)。'
