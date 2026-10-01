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
    4. appconfig の paths.assetsDir を paths.jsDir(<dataRoot>\js)へ書き換える
    5. 確定領域の変更(css/*.css と .gitignore)を system 名義で 1 コミットする
  作業コピー(drafts / pending / reviews)の CSS は git 管理外なので、書き換え前に
  <dataRoot>\.fonts-to-css-backup-<yyyyMMdd>\ へ退避する(rollback.ps1 がここから戻す)。
  置き場(dataRoot・drafts・pending・reviews・css・旧 assets)はサーバと同じ順(環境変数 →
  appconfig → dataRoot 配下の既定)で決め、出典を表示する。
  templates / filled の HTML 内の fonts/ 参照と、url(css/…) を持つ CSS は報告だけする。
  サーバ稼働中、dataRoot が git リポジトリでない・履歴(HEAD)が無いときは中止する。未コミットの
  変更は 1 件ずつ点検し、このパッチ・init-data-repo・サーバが作るのと同じ形(CSS の ../fonts/ →
  fonts/、.gitignore への必須行の追記、.gitattributes を * text eol=lf にしただけ)なら取り込んで
  同じコミットに含め、それ以外があれば一覧を出して中止する。追跡されているフォント・画像・js
  (css/fonts・images・js・assets)は追跡だけ外す(ファイルは残す)。templates も css も無いときは
  dataRoot の取り違えとみなし、何も変えずに終了コード 2 で終わる。git は環境変数 GIT_BIN が
  あればそれを使う。

.PARAMETER DataRoot
  data リポジトリの場所。省略時は -DataRoot → 環境変数 DATA_ROOT(プロセス → ユーザー) →
  appconfig の paths.dataRoot → 既定の順で決める。

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
# git の場所はサーバ(gitRepo.ts)と同じく GIT_BIN を優先する。PortableGit だけの端末で PATH に git が
# 無くても流せるようにするため。
$gitExe = if ($env:GIT_BIN) { $env:GIT_BIN } else { 'git' }
# -DataRoot の相対パスは PowerShell の今の場所を基準に絶対パスへ直す。Invoke-GitUtf8 が起動する git は
# PowerShell の今の場所を引き継がない(プロセスの作業フォルダは別)ため。
if ($DataRoot) { $DataRoot = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($DataRoot) }

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
  # PowerShell 5.1 はネイティブコマンドの出力をコンソールのコードページで読むので、日本語のパスや
  # ファイルの中身が化ける。未コミットの変更を中身で点検する読み取りは、出力を UTF-8 として自前で
  # 読む(変更を伴う git 呼び出しは Invoke-Git を使う)。
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
  return @{ Code = $proc.ExitCode; Out = $out; Err = $errTask.Result }
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
# templates も css も無い場所は、dataRoot の取り違え(別のフォルダを指している)とみなす。旧構成・
# 新構成の有無では決めない — フォントを使わない正当な環境まで失敗扱いになるため。
if (-not (Test-Path -LiteralPath (Join-Path $DataRoot 'templates')) -and -not (Test-Path -LiteralPath (Join-Path $DataRoot 'css'))) {
  Write-Warning ("$DataRoot に templates も css もありません。dataRoot を取り違えていないか確かめてください" +
    '(-DataRoot で指定できます)。何も変えずに終了します。')
  exit 2
}
if (-not (Test-Path -LiteralPath (Join-Path $DataRoot '.git'))) { throw "$DataRoot は git リポジトリではありません。" }
# HEAD が無い(git init だけした)リポジトリでは `rev-parse --verify -q` が終了コード 1 で終わる。
# それ以外の非 0(128: dubious ownership・リポジトリとして読めない等)を履歴無しとみなすと、誤った
# 案内になるので git の原因をそのまま出して止める。
$headCheck = Invoke-GitUtf8 -GitArgs @('rev-parse', '--verify', '-q', 'HEAD') -AllowFailure
if ($headCheck.Code -eq 1) {
  throw ("$DataRoot の git には履歴(最初のコミット)がありません。editor\scripts\init-data-repo.bat -DataRoot " +
    "`"$DataRoot`" で初回コミット(確定領域だけを記録します)を作ってから再実行してください。")
}
if ($headCheck.Code -ne 0) {
  throw "git rev-parse --verify -q HEAD が失敗しました(終了コード $($headCheck.Code))。`n$($headCheck.Err)"
}

# ── 未コミットの変更の点検 ──
# 手で dataRoot を作り直した直後は必ず未コミットの変更が残る。このパッチ・init-data-repo・サーバが
# 作るのと同じ形の変更だけなら取り込んで同じコミットに含め、それ以外が 1 つでもあれば中止する。
# 見るのは確定領域(承認コミットの対象)だけ。css/fonts は git 管理外の置き場なので除く。比べる前に
# BOM を除き、改行を LF に揃える(構築済み環境の .gitattributes・.gitignore は BOM 付き・CRLF のことがある)。
$requiredIgnore = '/drafts/', '/reviews/', '/pending/', '/notes/', '/css/fonts/', '/images/', '*.tmp-*'
$rewriteRe = '(?i)(url\(\s*["'']?)\.\./fonts/'

function Get-NormalizedText([string]$s) {
  if ($null -eq $s) { return $null }
  return $s.TrimStart([char]0xFEFF).Replace("`r`n", "`n")
}

function Get-HeadText([string]$rel) {
  $r = Invoke-GitUtf8 -GitArgs @('cat-file', '-p', "HEAD:$rel") -AllowFailure
  if ($r.Code -ne 0) { return $null }
  return Get-NormalizedText $r.Out
}

function Get-WorkText([string]$rel) {
  $p = Join-Path $DataRoot ($rel -replace '/', '\')
  if (-not (Test-Path -LiteralPath $p -PathType Leaf)) { return $null }
  return Get-NormalizedText ([IO.File]::ReadAllText($p, $utf8NoBom))
}

function Get-Lines([string]$s) {
  if ($null -eq $s) { return @() }
  # 末尾の空白だけ除く。git は .gitignore の行頭の空白を無視しないので、"  /css/fonts/" を
  # "/css/fonts/" と同じに扱うと、効いていない行を「済み」と取り違える。
  return @($s.Split("`n") | ForEach-Object { $_.TrimEnd() } | Where-Object { $_ -ne '' })
}

function Test-KnownShape([string]$xy, [string]$rel) {
  # 候補は「変更・追加・未追跡」だけ(削除・改名・型の変更はパッチが作らない)。中身を読む前に
  # パスで絞る(templates・filled の大量の変更で 1 件ずつ git を起動しないため)。
  if ($xy -notmatch '^[ MA?][ M?]$') { return $false }
  if ($rel -cne '.gitignore' -and $rel -cne '.gitattributes' -and $rel -cnotmatch '^css/[^/]+\.css$') { return $false }
  $work = Get-WorkText $rel
  if ($null -eq $work) { return $false }
  $head = Get-HeadText $rel
  if ($rel -ceq '.gitignore') {
    # 既存の行を消さず、足したのが init-data-repo・サーバの必須行だけなら同じ形。
    $before = @(Get-Lines $head)
    $after = @(Get-Lines $work)
    foreach ($l in $before) { if ($after -cnotcontains $l) { return $false } }
    foreach ($l in $after) { if ($before -cnotcontains $l -and $requiredIgnore -cnotcontains $l) { return $false } }
    return $true
  }
  if ($rel -ceq '.gitattributes') {
    # サーバ(gitRepo.ts の ensureGitattributes)と同じ直し方: 先頭を正しい行にし、旧い無効行を落とす。
    $others = @(Get-Lines $head | Where-Object { $_ -cne '* text=lf' -and $_ -cne '* text eol=lf' })
    return ((@(Get-Lines $work) -join "`n") -ceq ((@('* text eol=lf') + $others) -join "`n"))
  }
  if ($rel -cmatch '^css/[^/]+\.css$' -and $null -ne $head) {
    # 末尾の改行 1 つの有無は、エディタが保存時に足すことがあるので差分に数えない。
    $want = ($head -replace $rewriteRe, '${1}fonts/') -replace '\n\z', ''
    return (($work -replace '\n\z', '') -ceq $want)
  }
  return $false
}

$statusOut = (Invoke-GitUtf8 -GitArgs @('status', '--porcelain=v1', '-z', '--untracked-files=all', '--',
  '.gitignore', '.gitattributes', 'templates', 'filled', 'css', 'sync', ':(exclude)css/fonts')).Out
$tokens = @($statusOut.Split([char]0) | Where-Object { $_ -ne '' })
$absorbed = @()
$foreign = @()
for ($i = 0; $i -lt $tokens.Count; $i++) {
  $xy = $tokens[$i].Substring(0, 2)
  $rel = $tokens[$i].Substring(3)
  # 改名・複写は元のパスが次の要素に続く(-z の書式)。どちらもパッチは作らない。
  if ($xy[0] -eq 'R' -or $xy[0] -eq 'C') { $i++ }
  if (Test-KnownShape $xy $rel) { $absorbed += $rel; continue }
  $hint = if ($rel -match '^css/[^/]+\.(woff2?|ttf|otf)$') { '(css 直下のフォントは配信されません。css\fonts へ移してください)' } else { '' }
  $foreign += "  $xy $rel$hint"
}
# 適用は index 全体をコミットするので、点検範囲の外でステージ済みの変更も見る。追跡を外す置き場
# (css/fonts・images・js・assets)は後で index から外すので除く。点検範囲の中は上の status が見た。
$stagedTokens = @((Invoke-GitUtf8 -GitArgs @('diff', '--cached', '--name-status', '-z', 'HEAD')).Out.Split([char]0) | Where-Object { $_ -ne '' })
for ($i = 0; $i -lt $stagedTokens.Count; $i++) {
  $code = $stagedTokens[$i]
  # 改名・複写は元と先の 2 つのパスが続く。
  $count = if ($code -match '^[RC]') { 2 } else { 1 }
  $paths = @($stagedTokens[($i + 1)..($i + $count)])
  $i += $count
  foreach ($rel in $paths) {
    if ($rel -ceq '.gitignore' -or $rel -ceq '.gitattributes') { continue }
    if ($rel -cmatch '^(templates|filled|css|sync|images|js|assets)/') { continue }
    $foreign += "  $($code.Substring(0, 1))  $rel(点検範囲の外でステージ済み)"
  }
}
if ($foreign.Count -gt 0) {
  $list = $foreign -join "`n"
  $traces = @(foreach ($n in 'index.lock', 'REVERT_HEAD', 'MERGE_HEAD', 'CHERRY_PICK_HEAD') {
      if (Test-Path -LiteralPath (Join-Path $DataRoot ".git\$n")) { ".git\$n" }
    })
  # 移行コミットが無いのに退避名の assets があれば、前回の -Apply が改名の後で止まった形跡。
  if (-not (Invoke-Git log --author=system --grep '\[fonts-to-css\]' --format=%H -1)) {
    $traces += @(Get-ChildItem -LiteralPath $DataRoot -Directory -Filter 'assets.migrated-*' -ErrorAction SilentlyContinue | ForEach-Object { $_.Name })
  }
  if ($traces.Count -gt 0) {
    throw ("前回のパッチ(または rollback)が途中で止まった形跡があります($($traces -join ', '))。" +
      "git -C `"$DataRoot`" status で状態を確かめ、途中の操作を終えるか戻してから再実行してください。" +
      "次の未コミットの変更は、このパッチが作る形ではありません:`n$list")
  }
  throw ("手作業の変更が残っています。次の未コミットの変更は、このパッチが作る形(CSS の ../fonts/ → " +
    'fonts/ の書き換え・.gitignore への必須行の追記・.gitattributes を * text eol=lf にしただけ)ではない' +
    "ため中止しました。残すなら先にコミットし、要らなければ git -C `"$DataRoot`" checkout -- <ファイル> " +
    "で戻してから再実行してください:`n$list")
}

# 追跡されたフォント・画像・js は、承認コミットのたびに版に残り続け、次の承認者の名前で更新される。
# ファイルは残して追跡だけ外し、同じ system コミットに含める。
$trackedFiles = @((Invoke-GitUtf8 -GitArgs @('ls-files', '-z', '--', 'css/fonts', 'images', 'js', 'assets')).Out.Split([char]0) | Where-Object { $_ -ne '' })
$untrackPlaces = @('css/fonts', 'images', 'js', 'assets' | Where-Object {
    $place = $_
    @($trackedFiles | Where-Object { $_.StartsWith("$place/") }).Count -gt 0
  })

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
$ignoreLines = if (Test-Path -LiteralPath $gitignorePath) { @([IO.File]::ReadAllLines($gitignorePath) | ForEach-Object { $_.TrimEnd() }) } else { @() }
$needsIgnore = -not ($ignoreLines -contains '/css/fonts/')
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
# 取り込む未コミットの変更と、追跡を外すファイル。
if ($absorbed.Count -gt 0) {
  Write-Host "取り込む未コミットの変更(このパッチと同じ形。同じコミットに含めます): $($absorbed.Count) 件"
  $absorbed | ForEach-Object { Write-Host "  $_" }
}
Write-Host "git の追跡から外すファイル(ファイルは残します): $($trackedFiles.Count) 件"
$trackedFiles | ForEach-Object { Write-Host "  $_" }
if (-not $Apply) { Write-Host ''; Write-Host '確認モードのため何も変えていません。実行するには -Apply を付けてください。'; return }

# ── 4. 適用 ──
if ($needsIgnore) {
  $current = if (Test-Path -LiteralPath $gitignorePath) { [IO.File]::ReadAllText($gitignorePath) } else { '' }
  if ($current -ne '' -and -not $current.EndsWith("`n")) { $current += "`n" }
  [IO.File]::WriteAllText($gitignorePath, $current + "/css/fonts/`n", $utf8NoBom)
}
# -f は「index が HEAD とも作業ツリーとも違う」ときの確認を外すだけで、--cached なので作業ツリーの
# ファイルには触れない(手で変更してステージしたフォントでも追跡を外せるようにするため)。
if ($untrackPlaces.Count -gt 0) { Invoke-Git rm -r -q --cached --ignore-unmatch -f -- @untrackPlaces | Out-Null }
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
  $newJs = $jsDir
  $cfgPaths.PSObject.Properties.Remove('assetsDir')
  $cfgPaths | Add-Member -NotePropertyName 'jsDir' -NotePropertyValue $newJs -Force
  [IO.File]::WriteAllText($appConfigPath, ($appConfig | ConvertTo-Json -Depth 10), $utf8NoBom)
}
$addPaths = @('.gitignore')
if (Test-Path -LiteralPath (Join-Path $DataRoot 'css')) { $addPaths += 'css' }
if ($absorbed -contains '.gitattributes') { $addPaths += '.gitattributes' }
Invoke-Git add -- @addPaths | Out-Null
$staged = Invoke-Git diff --cached --name-only
if ($staged) {
  # 末尾の [fonts-to-css] は rollback.ps1 が git log --grep で探す ASCII の目印(日本語を
  # 引数で渡すと PowerShell 5.1 の文字コード変換で一致しなくなる)。
  Invoke-Git -c user.name=system -c user.email=system@editor.local commit -q -m '移行: フォント置き場の移設(assets/fonts → css/fonts) [fonts-to-css]'
  Write-Host '確定領域の変更を system 名義でコミットしました。'
}
Write-Host '移行が完了しました。editor を起動してください。'
