<#
.SYNOPSIS
  2026-10-fonts-to-css の移行を元に戻す。

.DESCRIPTION
  既定は確認モード。-Apply を付けたときだけ実行する。処理順:
    1. 移行コミット(作者 system、件名に [fonts-to-css])を git revert する。すでに revert 済みなら
       飛ばす(rollback 自身の Revert コミットは移行コミットとして拾わない)。移行で追跡を外した
       ファイル(revert が戻すパス)が作業ツリーにあると git revert が上書きを拒むので、revert の
       前に <dataRoot>\.rollback-tmp-<日付>\ へ退避し、revert の後に SHA256 で比べる。同じなら
       退避を消し、違えば退避を残して報告する
    2. assets.migrated-<日付> を assets へ戻す。revert が追跡していた assets を戻した場合は、
       退避名の側にしか無いファイルだけを assets へ移し、同じ内容のものは消し、違うものは残して
       報告する。空になった退避名のフォルダは消す
    3. 移行で作った css\fonts と js のうち、戻した assets に同じ相対パス・同じ SHA256 のファイルが
       あるものだけ削除する。旧 assets と内容が違うファイルと、git が追跡しているファイル(移行前から
       追跡されていて revert で追跡に戻ったもの)は消さず、一覧を表示して残す。空になったフォルダだけ
       消す。assets が戻らない(手で assets を消した、appconfig の片付けだけが動いた)ときは、
       同一内容かを確かめられないので css\fonts と js には触らない
    4. <dataRoot>\.fonts-to-css-backup-<日付>\ に退避した作業コピー(drafts / pending / reviews の
       CSS)を元の場所へ戻す。退避に無いファイルは触らない。移行後にこれらを編集していた場合、
       その編集は退避時点の内容で上書きされる
    5. appconfig.json.bak-<日付>(同じ日に複数あれば最初のもの)があれば appconfig.json へ戻す
  移行コミットが revert 済みの 2 回目以降は、4 と 5 を行わない(1 回目の後に直した内容を上書きしない
  ため)。同じ日の退避(.rollback-tmp-<日付>)に同じパスのファイルが既にあれば、何も変えずに中止する。
  git revert が失敗したときは revert --abort で元の状態へ戻し、退避したファイルも元へ戻してから
  中止する。実行前に editor サーバを止め、戻したあとは旧版の editor を配置して起動すること。
  git は環境変数 GIT_BIN があればそれを使う。

.PARAMETER DataRoot
  data リポジトリの場所(省略時は migrate.ps1 と同じ規則: 環境変数 DATA_ROOT → ユーザー環境変数
  DATA_ROOT → appconfig の paths.dataRoot → 既定)。

.PARAMETER Date
  戻す移行の日付(yyyyMMdd)。省略時は assets.migrated-<日付>・appconfig.json.bak-<日付>・
  .fonts-to-css-backup-<日付> の日付が 1 つに決まればそれを使う。1 つも無ければ移行コミットの
  revert だけを行う。

.PARAMETER Apply
  実際に戻す。付けなければ確認モード。
#>
param([string]$DataRoot, [string]$Date, [switch]$Apply)

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

function Test-InsideEditor([string]$p, [string]$label) {
  # migrate.ps1 と同じ判定(editor 基準で絶対パスにし、<editorDir>\ で始まるか。大文字小文字は区別しない)。
  # パスとして読めない値は、.NET の例外のままだとどの設定か分からないので出どころを添えて止める。
  try { $full = [IO.Path]::GetFullPath((Resolve-EditorPath $p)).TrimEnd('\') + '\' }
  catch { throw "$label の値 '$p' はパスとして読めません($($_.Exception.Message))。直してから再実行してください。" }
  return $full.StartsWith($editorDir.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)
}

function Invoke-Git {
  # git は LF→CRLF 変換などの警告を stderr へ出す。$ErrorActionPreference = 'Stop' のままだと
  # PowerShell 5.1 がそれを例外にするので、stderr は自前で受けて終了コードで失敗を判定する。
  # 成功時の警告は捨て、失敗時だけ原因として例外メッセージへ載せる。
  $ErrorActionPreference = 'Continue'
  $all = @(& $gitExe -C $DataRoot @args 2>&1)
  if ($LASTEXITCODE -ne 0) {
    $err = ($all | Where-Object { $_ -is [Management.Automation.ErrorRecord] } | ForEach-Object { $_.ToString() }) -join "`n"
    throw "git $($args -join ' ') が失敗しました(終了コード $LASTEXITCODE)。`n$err"
  }
  return @($all | Where-Object { $_ -isnot [Management.Automation.ErrorRecord] })
}

function ConvertTo-ProcessArgument([string]$a) {
  # .NET Framework の ProcessStartInfo は引数を 1 本の文字列で受けるので、C ランタイムの規則で囲む
  # (空白・引用符を含む dataRoot や pathspec を 1 引数として渡すため)。
  if ($a -ne '' -and $a -notmatch '[\s"]') { return $a }
  return '"' + (($a -replace '(\\*)"', '$1$1\"') -replace '(\\+)$', '$1$1') + '"'
}

function Invoke-GitUtf8 {
  # PowerShell 5.1 はネイティブコマンドの出力をコンソールのコードページで読むので、日本語のパスが
  # 化ける。revert が戻すパスの一覧は、出力を UTF-8 として自前で読む。
  param([Parameter(Mandatory = $true)][string[]]$GitArgs, [switch]$AllowFailure)
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
  if ($proc.ExitCode -ne 0 -and -not $AllowFailure) {
    throw "git $($GitArgs -join ' ') が失敗しました(終了コード $($proc.ExitCode))。`n$($errTask.Result)"
  }
  return @{ Code = $proc.ExitCode; Out = $out }
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

function Get-TrackedSet([string[]]$extra) {
  # css/fonts と js のうち git が追跡しているファイルの絶対パス(大文字小文字は区別しない)。移行前から
  # 追跡されていたファイルは revert で追跡に戻るので、assets と同じ内容でも「移行が作ったコピー」と
  # みなして消すと、rollback の後に削除の差分が残る。$extra は revert で追跡に戻る見込みのパス。
  $set = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
  $rels = @((Invoke-GitUtf8 -GitArgs @('ls-files', '-z', '--', 'css/fonts', 'js')).Out.Split([char]0) | Where-Object { $_ -ne '' })
  $rels += @($extra | Where-Object { $_ -match '^(css/fonts|js)/' })
  foreach ($r in $rels) { [void]$set.Add((Join-Path $DataRoot ($r -replace '/', '\'))) }
  return , $set
}

function Get-DeletePlan([string]$oldRoot, $tracked) {
  # css\fonts と js のうち、旧 assets($oldRoot)に同じ相対パス・同じ内容があり、git が追跡していない
  # ものだけを消す対象にする。
  $plan = @{ Deletes = @(); Keeps = @(); Tracked = @() }
  foreach ($pair in @(@{ Dir = (Join-Path $cssDir 'fonts'); Old = (Join-Path $oldRoot 'fonts') },
                      @{ Dir = $jsDir; Old = (Join-Path $oldRoot 'js') })) {
    if (-not (Test-Path -LiteralPath $pair.Dir)) { continue }
    foreach ($f in Get-ChildItem -LiteralPath $pair.Dir -Recurse -File) {
      $rel = $f.FullName.Substring($pair.Dir.Length).TrimStart('\')
      $old = Join-Path $pair.Old $rel
      if ($tracked.Contains($f.FullName)) { $plan.Tracked += $f.FullName }
      elseif ((Test-Path -LiteralPath $old) -and ((Get-FileHashHex $old) -eq (Get-FileHashHex $f.FullName))) { $plan.Deletes += $f.FullName }
      else { $plan.Keeps += $f.FullName }
    }
  }
  return $plan
}

# ── 1. 置き場の解決(migrate.ps1 と同じ規則) ──
$appConfigPath = if ($env:APP_CONFIG) { $env:APP_CONFIG } else { Join-Path $editorDir 'appconfig.json' }
$appConfig = $null
if (Test-Path -LiteralPath $appConfigPath) {
  $appConfig = Get-Content -Raw -Encoding UTF8 -LiteralPath $appConfigPath | ConvertFrom-Json
}
$cfgPaths = if ($appConfig -and $appConfig.paths) { $appConfig.paths } else { $null }
function Get-CfgPath([string]$key) {
  # migrate.ps1 と同じく、editor のフォルダの中を指す値(旧例の data/css など)は無視して既定を使う。
  # 1 回目の rollback が戻した移行前の appconfig にはこの値が残っているので、2 回目で旧い場所を
  # 片付けの対象にしないため。
  if ($cfgPaths -and $cfgPaths.PSObject.Properties[$key] -and $cfgPaths.$key) {
    $v = [string]$cfgPaths.$key
    if (-not (Test-InsideEditor $v "appconfig の paths.$key")) { return $v }
  }
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
$assetsDir = Join-Path $DataRoot 'assets'

# ── 2. 戻す対象の特定 ──
# 戻す日付は、移行が残すもの(退避した assets・appconfig のバックアップ・作業コピーの退避)から
# 決める。assets を手で消した環境や、appconfig の片付けだけが動いた環境でも決められるようにする。
$cfgDir = Split-Path -Parent $appConfigPath
$cfgLeaf = Split-Path -Leaf $appConfigPath
$dates = @()
$dates += @(Get-ChildItem -LiteralPath $DataRoot -Directory -Filter 'assets.migrated-*' -ErrorAction SilentlyContinue |
  ForEach-Object { $_.Name.Substring('assets.migrated-'.Length) })
$dates += @(Get-ChildItem -LiteralPath $DataRoot -Directory -Force -Filter '.fonts-to-css-backup-*' -ErrorAction SilentlyContinue |
  ForEach-Object { $_.Name.Substring('.fonts-to-css-backup-'.Length) })
$dates += @(Get-ChildItem -LiteralPath $cfgDir -File -Filter "$cfgLeaf.bak-*" -ErrorAction SilentlyContinue |
  ForEach-Object { if ($_.Name -match '\.bak-(\d{8})(-\d+)?$') { $Matches[1] } })
$dates = @($dates | Sort-Object -Unique)
if ($Date) { $stamp = $Date }
elseif ($dates.Count -eq 1) { $stamp = $dates[0] }
elseif ($dates.Count -eq 0) { $stamp = $null }
else { throw "戻す日付が 1 つに決まりません(候補: $($dates -join ', '))。-Date で指定してください。" }
$migratedDir = if ($stamp) { Join-Path $DataRoot "assets.migrated-$stamp" } else { $null }
$hasMigrated = [bool]($migratedDir -and (Test-Path -LiteralPath $migratedDir))

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

# revert が戻すパス(移行コミットで削除扱いになったもの = 追跡を外したファイル)。同じパスに作業
# ツリーのファイルがあると、git revert は .gitignore 済みの置き場では黙って上書きし(終了コード 0)、
# それ以外(js など)では上書きを拒む。どちらでも作業ツリーの内容を失わないよう、戻すパスにある
# ファイルはすべて revert の前に退避する。
$restorePaths = @()
if ($commit -and -not $alreadyReverted) {
  $restorePaths = @((Invoke-GitUtf8 -GitArgs @('diff-tree', '-r', '-z', '--no-commit-id', '--name-only', '--diff-filter=D', $commit)).Out.Split([char]0) |
    Where-Object { $_ -ne '' })
}
$toStash = @($restorePaths | Where-Object { Test-Path -LiteralPath (Join-Path $DataRoot ($_ -replace '/', '\')) -PathType Leaf })
$stashRoot = Join-Path $DataRoot ('.rollback-tmp-' + $(if ($stamp) { $stamp } else { Get-Date -Format 'yyyyMMdd' }))
# 同じ日の退避に同じパスのファイルがあると、前回の rollback で残したもの(戻した版と内容が違った
# もの)を黙って上書きしてしまう。何も変えずに中止して片付けを求める。
$stashClash = @($toStash | Where-Object { Test-Path -LiteralPath (Join-Path $stashRoot ($_ -replace '/', '\')) })
if ($stashClash.Count -gt 0) {
  throw ("同じ日の退避が既にあります($stashRoot)。前回の rollback で残したファイルと見比べて片付けてから" +
    "再実行してください:`n$(($stashClash | ForEach-Object { "  $_" }) -join "`n")")
}

# css\fonts と js の削除は、戻した assets と同一内容の分だけ。確認モードでは、退避名の assets
# (無ければ今の assets)を基準に見込みを出す(-Apply では戻した後の assets で決め直す)。
$previewRoot = if ($hasMigrated) { $migratedDir } elseif (Test-Path -LiteralPath $assetsDir) { $assetsDir } else { $null }
$preview = if ($previewRoot) { Get-DeletePlan $previewRoot (Get-TrackedSet $restorePaths) }
  else { @{ Deletes = @(); Keeps = @(); Tracked = @() } }

# 作業コピーの退避。
$restores = @()
if ($stamp) {
  $backupRoot = Join-Path $DataRoot ".fonts-to-css-backup-$stamp"
  $manifestPath = Join-Path $backupRoot 'manifest.tsv'
  if (Test-Path -LiteralPath $manifestPath) {
    foreach ($line in [IO.File]::ReadAllLines($manifestPath, $utf8NoBom)) {
      $parts = $line -split "`t", 2
      if ($parts.Count -ne 2) { continue }
      $src = Join-Path $backupRoot $parts[0]
      if (Test-Path -LiteralPath $src) { $restores += @{ From = $src; To = $parts[1] } }
    }
  }
}
# 同じ日に複数あるときは、移行前の状態を持つ最初のもの(-n の付かない名前)から戻す。
$bak = if ($stamp) { "$appConfigPath.bak-$stamp" } else { $null }
$hasBak = [bool]($bak -and (Test-Path -LiteralPath $bak))

Write-Host "dataRoot: $DataRoot"
Write-Host "戻す日付: $(if ($stamp) { $stamp } else { '(決まらないため、移行コミットの revert だけを行います)' })"
if (-not $commit) { Write-Host 'revert するコミット: (なし)' }
elseif ($alreadyReverted) { Write-Host "revert するコミット: $commit(revert 済みのため飛ばします)" }
else { Write-Host "revert するコミット: $commit" }
Write-Host "revert の前に退避するファイル(追跡を戻すパスにあるもの。revert 後に同じ内容なら消します): $($toStash.Count) 件"
$toStash | ForEach-Object { Write-Host "  $_" }
if ($hasMigrated) { Write-Host "戻す: $migratedDir -> assets" }
else { Write-Host '戻す: (assets.migrated-* が無いため、退避名からは戻しません)' }
Write-Host "削除するファイルの見込み(旧 assets と同一内容): $($preview.Deletes.Count) 件"
$preview.Deletes | ForEach-Object { Write-Host "  $_" }
if ($preview.Keeps.Count -gt 0) {
  Write-Host "【残す】旧 assets と内容が違うファイル(移行後に置いた、または git に記録された版と違う)。消さずに残します: $($preview.Keeps.Count) 件"
  $preview.Keeps | ForEach-Object { Write-Host "  $_" }
}
if ($preview.Tracked.Count -gt 0) {
  Write-Host "【残す】git が追跡している(revert で追跡に戻る)ファイル。旧 assets と同じ内容でも消しません: $($preview.Tracked.Count) 件"
  $preview.Tracked | ForEach-Object { Write-Host "  $_" }
}
if ($alreadyReverted) {
  Write-Host '退避から戻す作業コピー・appconfig: (移行コミットが revert 済みのため戻しません)'
} else {
  Write-Host "退避から戻す作業コピー: $($restores.Count) 件"
  $restores | ForEach-Object { Write-Host "  $($_.To)" }
  Write-Host "appconfig を戻す: $(if ($hasBak) { $bak } else { '(バックアップなし)' })"
}
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

$assetsDiffer = @()
if ($hasMigrated) {
  if (-not (Test-Path -LiteralPath $assetsDir)) {
    Rename-Item -LiteralPath $migratedDir -NewName 'assets'
  } else {
    # revert が追跡していた assets を戻した。退避名の側にしか無いものだけを移し、同じものは消す。
    foreach ($f in @(Get-ChildItem -LiteralPath $migratedDir -Recurse -File -Force)) {
      $rel = $f.FullName.Substring($migratedDir.Length).TrimStart('\')
      $dst = Join-Path $assetsDir $rel
      if (-not (Test-Path -LiteralPath $dst)) {
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dst) | Out-Null
        Move-Item -LiteralPath $f.FullName -Destination $dst
      } elseif ((Get-FileHashHex $dst) -eq (Get-FileHashHex $f.FullName)) {
        Remove-Item -LiteralPath $f.FullName -Force
      } else { $assetsDiffer += $f.FullName }
    }
    Remove-EmptyDirs $migratedDir
  }
}

$keeps = @()
$trackedKeeps = @()
if (Test-Path -LiteralPath $assetsDir) {
  # 追跡の集合は revert の後の HEAD で取り直す(移行前から追跡されていたファイルを消さないため)。
  $plan = Get-DeletePlan $assetsDir (Get-TrackedSet @())
  foreach ($p in $plan.Deletes) { Remove-Item -LiteralPath $p -Force }
  $keeps = $plan.Keeps
  $trackedKeeps = $plan.Tracked
  foreach ($root in (Join-Path $cssDir 'fonts'), $jsDir) { Remove-EmptyDirs $root }
}
# 2 回目以降(移行コミットが revert 済み)は戻さない。1 回目の後に直した作業コピーや appconfig を、
# 退避・バックアップの古い内容で上書きしないため。
if (-not $alreadyReverted) {
  foreach ($r in $restores) {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $r.To) | Out-Null
    Copy-Item -LiteralPath $r.From -Destination $r.To -Force
  }
  if ($hasBak) { Copy-Item -LiteralPath $bak -Destination $appConfigPath -Force }
}
if ($stashKept.Count -gt 0) {
  Write-Host '【報告】revert が戻した版と内容が違うため、退避に残しました(必要なら手で見比べてください):'
  $stashKept | ForEach-Object { Write-Host "  $_" }
}
if ($assetsDiffer.Count -gt 0) {
  Write-Host '【報告】戻した assets と内容が違うため、退避名の側に残しました:'
  $assetsDiffer | ForEach-Object { Write-Host "  $_" }
}
if ($keeps.Count -gt 0) {
  Write-Host '【残す】旧 assets と内容が違うファイル(移行後に置いた、または git に記録された版と違う)。消さずに残しました:'
  $keeps | ForEach-Object { Write-Host "  $_" }
}
if ($trackedKeeps.Count -gt 0) {
  Write-Host '【残す】git が追跡しているファイル。旧 assets と同じ内容でも消さずに残しました:'
  $trackedKeeps | ForEach-Object { Write-Host "  $_" }
}
Write-Host '元に戻しました。旧版の editor を配置して起動してください。'
