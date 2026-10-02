<#
.SYNOPSIS
  2026-10-fund-images の変更(.gitignore の /images/ と追跡の解除)を元に戻す。

.DESCRIPTION
  既定は確認モード。-Apply を付けたときだけ実行する。目印 [fund-images] を持つ移行コミット
  (Revert で始まる件名は除く)を git revert する。すでに revert 済みなら何もしない。
  移行で追跡を外したファイル(revert が戻すパス)が作業ツリーにあると git revert が上書きを拒む
  ので、revert の前に <dataRoot>\.rollback-tmp-<yyyyMMdd>\ へ退避し、revert の後に SHA256 で比べる。
  同じなら退避を消し、違えば退避に残して報告する。同じ日の退避に同じパスのファイルが既にあれば、
  何も変えずに中止する。
  git revert が失敗したときは revert --abort で元の状態へ戻し、退避したファイルも元へ戻してから
  中止し、git の出力を表示する。
  images フォルダと中の画像は消さない(別ツールが置いた git 管理外のもので、戻せないため)。
  新版のサーバは承認時に /images/ を再び追記するので、戻す意味があるのはサーバも旧版へ戻す
  場合に限る。
  git は環境変数 GIT_BIN があればそれを使う。

.PARAMETER DataRoot
  data リポジトリの場所(省略時は apply.ps1 と同じ規則)。

.PARAMETER Apply
  実際に戻す。付けなければ確認モード。
#>
param([string]$DataRoot, [switch]$Apply)

$ErrorActionPreference = 'Stop'
$editorDir = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path))
$workspace = Split-Path -Parent $editorDir
$utf8NoBom = New-Object System.Text.UTF8Encoding $false
# git の場所はサーバ(gitRepo.ts)と同じく GIT_BIN を優先する(PATH に git が無い端末向け)。
$gitExe = if ($env:GIT_BIN) { $env:GIT_BIN } else { 'git' }
# -DataRoot の相対パスは PowerShell の今の場所を基準に絶対パスへ直す。Invoke-GitUtf8 が起動する git と
# .NET のファイル操作は PowerShell の今の場所を引き継がない(プロセスの作業フォルダは別)ため。
if ($DataRoot) { $DataRoot = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($DataRoot) }

function Resolve-EditorPath([string]$p) {
  # サーバ(config.ts の toPath)は相対パスを editor/ 基準で解決するので合わせる。
  if ([IO.Path]::IsPathRooted($p)) { return $p }
  return [IO.Path]::GetFullPath((Join-Path $editorDir $p))
}

function Resolve-PlacePath([string]$p, [string]$label) {
  # apply.ps1 と同じく、パスとして読めない値は出どころ($label)を添えて止める。
  try { return [IO.Path]::GetFullPath((Resolve-EditorPath $p)) }
  catch { throw "$label の値 '$p' はパスとして読めません($($_.Exception.Message))。直してから再実行してください。" }
}

function Invoke-Git {
  # stderr の扱いは apply.ps1 と同じ(成功時の警告は捨て、失敗時だけ例外に載せる)。
  $ErrorActionPreference = 'Continue'
  $all = @(& $gitExe -C $DataRoot @args 2>&1)
  if ($LASTEXITCODE -ne 0) {
    $err = ($all | Where-Object { $_ -is [Management.Automation.ErrorRecord] } | ForEach-Object { $_.ToString() }) -join "`n"
    throw "git $($args -join ' ') が失敗しました(終了コード $LASTEXITCODE)。`n$err"
  }
  return @($all | Where-Object { $_ -isnot [Management.Automation.ErrorRecord] })
}

function ConvertTo-ProcessArgument([string]$a) {
  # .NET Framework の ProcessStartInfo は引数を 1 本の文字列で受けるので、C ランタイムの規則で囲む。
  if ($a -ne '' -and $a -notmatch '[\s"]') { return $a }
  return '"' + (($a -replace '(\\*)"', '$1$1\"') -replace '(\\+)$', '$1$1') + '"'
}

function Invoke-GitUtf8 {
  # PowerShell 5.1 はネイティブコマンドの出力をコンソールのコードページで読むので、日本語のパスが
  # 化ける。revert が戻すパスの一覧は、出力を UTF-8 として自前で読む。
  param([Parameter(Mandatory = $true)][string[]]$GitArgs)
  $psi = New-Object Diagnostics.ProcessStartInfo
  $psi.FileName = $gitExe
  $psi.Arguments = ((@('-C', $DataRoot) + $GitArgs) | ForEach-Object { ConvertTo-ProcessArgument $_ }) -join ' '
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.StandardOutputEncoding = $utf8NoBom
  $psi.StandardErrorEncoding = $utf8NoBom
  $proc = [Diagnostics.Process]::Start($psi)
  $errTask = $proc.StandardError.ReadToEndAsync()
  $out = $proc.StandardOutput.ReadToEnd()
  $proc.WaitForExit()
  if ($proc.ExitCode -ne 0) {
    throw "git $($GitArgs -join ' ') が失敗しました(終了コード $($proc.ExitCode))。`n$($errTask.Result)"
  }
  return $out
}

function Get-FileHashHex([string]$p) { (Get-FileHash -Algorithm SHA256 -LiteralPath $p).Hash }

function Remove-EmptyDirs([string]$root) {
  # 深いフォルダから順に、空になったものだけ消す(中身の残るフォルダは消さない)。
  if (-not (Test-Path -LiteralPath $root)) { return }
  Get-ChildItem -LiteralPath $root -Recurse -Directory -Force | Sort-Object { $_.FullName.Length } -Descending | ForEach-Object {
    if (-not (Get-ChildItem -LiteralPath $_.FullName -Force)) { Remove-Item -LiteralPath $_.FullName -Force }
  }
  if (-not (Get-ChildItem -LiteralPath $root -Force)) { Remove-Item -LiteralPath $root -Force }
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
  $DataRoot = $env:DATA_ROOT; $source = '環境変数 DATA_ROOT'
  if (-not $DataRoot) {
    $DataRoot = [Environment]::GetEnvironmentVariable('DATA_ROOT', 'User'); $source = 'ユーザー環境変数 DATA_ROOT'
  }
  if (-not $DataRoot) { $DataRoot = Get-CfgPath 'dataRoot'; $source = 'appconfig の paths.dataRoot' }
  if ($DataRoot) { $DataRoot = Resolve-PlacePath $DataRoot $source }
  else { $DataRoot = Join-Path (Split-Path -Parent $workspace) 'editor-data' }
}
# 8.3 形式の短い名前のままだと、apply.ps1 と表示や退避先の名前が食い違う。フォルダがあれば長い名前へ
# 揃える。
if (Test-Path -LiteralPath $DataRoot -PathType Container) { $DataRoot = (Get-Item -LiteralPath $DataRoot).FullName }
$imagesDir = if ($env:IMAGES_DIR) { Resolve-PlacePath $env:IMAGES_DIR '環境変数 IMAGES_DIR' }
  elseif (Get-CfgPath 'imagesDir') { Resolve-PlacePath (Get-CfgPath 'imagesDir') 'appconfig の paths.imagesDir' }
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

# revert が戻すパス(移行コミットで削除扱いになったもの = 追跡を外したファイル)。同じパスに作業
# ツリーのファイルがあると、git revert は .gitignore 済みの置き場では黙って上書きし(終了コード 0)、
# それ以外(js など)では上書きを拒む。どちらでも作業ツリーの内容を失わないよう、戻すパスにある
# ファイルはすべて revert の前に退避する。
$toStash = @()
if ($commit -and -not $alreadyReverted) {
  $restorePaths = @((Invoke-GitUtf8 -GitArgs @('diff-tree', '-r', '-z', '--no-commit-id', '--name-only', '--diff-filter=D', $commit)).Split([char]0) |
    Where-Object { $_ -ne '' })
  $toStash = @($restorePaths | Where-Object { Test-Path -LiteralPath (Join-Path $DataRoot ($_ -replace '/', '\')) -PathType Leaf })
}
$stashRoot = Join-Path $DataRoot ('.rollback-tmp-' + (Get-Date -Format 'yyyyMMdd'))
# 同じ日の退避に同じパスのファイルがあると、前回の rollback で残したもの(戻した版と内容が違った
# もの)を黙って上書きしてしまう。何も変えずに中止して片付けを求める。
$stashClash = @($toStash | Where-Object { Test-Path -LiteralPath (Join-Path $stashRoot ($_ -replace '/', '\')) })
if ($stashClash.Count -gt 0) {
  throw ("同じ日の退避が既にあります($stashRoot)。前回の rollback で残したファイルと見比べて片付けてから" +
    "再実行してください:`n$(($stashClash | ForEach-Object { "  $_" }) -join "`n")")
}

Write-Host "dataRoot: $DataRoot"
if (-not $commit) { Write-Host 'revert するコミット: (なし)' }
elseif ($alreadyReverted) { Write-Host "revert するコミット: $commit(revert 済みのため飛ばします)" }
else { Write-Host "revert するコミット: $commit" }
Write-Host "revert の前に退避するファイル(追跡を戻すパスにあるもの。revert 後に同じ内容なら消します): $($toStash.Count) 件"
$toStash | ForEach-Object { Write-Host "  $_" }
Write-Host "images フォルダ($imagesDir)と中の画像は消しません。不要なら手で消してください。"
if (-not $Apply) { Write-Host '確認モードのため何も変えていません。実行するには -Apply を付けてください。'; return }

# ── 3. 適用 ──
$stashKept = @()
if ($commit -and -not $alreadyReverted) {
  $moved = @()
  foreach ($rel in $toStash) {
    $src = Join-Path $DataRoot ($rel -replace '/', '\')
    $dst = Join-Path $stashRoot ($rel -replace '/', '\')
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dst) | Out-Null
    Move-Item -LiteralPath $src -Destination $dst -Force
    $moved += $rel
  }
  try {
    Invoke-Git -c user.name=system -c user.email=system@editor.local revert --no-edit $commit | Out-Null
  } catch {
    # 競合したまま止まると REVERTING 状態と競合マーカーが残るので、元の状態へ戻してから中止する。
    # 退避したファイルも元の場所へ戻す(流す前の作業ツリーに揃える)。
    try { Invoke-Git revert --abort | Out-Null } catch { Write-Warning 'git revert --abort にも失敗しました。手動で確認してください。' }
    foreach ($rel in $moved) {
      $back = Join-Path $DataRoot ($rel -replace '/', '\')
      New-Item -ItemType Directory -Force -Path (Split-Path -Parent $back) | Out-Null
      Move-Item -LiteralPath (Join-Path $stashRoot ($rel -replace '/', '\')) -Destination $back -Force
    }
    Remove-EmptyDirs $stashRoot
    throw
  }
  foreach ($rel in $moved) {
    $restored = Join-Path $DataRoot ($rel -replace '/', '\')
    $kept = Join-Path $stashRoot ($rel -replace '/', '\')
    if ((Test-Path -LiteralPath $restored) -and ((Get-FileHashHex $restored) -eq (Get-FileHashHex $kept))) {
      Remove-Item -LiteralPath $kept -Force
    } else { $stashKept += $kept }
  }
  Remove-EmptyDirs $stashRoot
}
if ($stashKept.Count -gt 0) {
  Write-Host '【報告】revert が戻した版と内容が違うため、退避に残しました(必要なら手で見比べてください):'
  $stashKept | ForEach-Object { Write-Host "  $_" }
}
Write-Host '元に戻しました。サーバも旧版へ戻す場合だけ意味があります(新版は承認時に /images/ を再び追記します)。'
