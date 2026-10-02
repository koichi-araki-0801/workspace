<#
.SYNOPSIS
  editor の data リポジトリを新構成へ移す(フォント: assets\fonts → css\fonts、js: assets\js → js)。
  あわせて appconfig に残る旧構成の設定を片付ける。

.DESCRIPTION
  既定は確認モードで、移動元・移動先、書き換える CSS、外す設定、報告事項を表示するだけで何も
  変えない。-Apply を付けたときだけ実行する。処理順:
    1. .gitignore に /css/fonts/ を追記する(フォントが承認コミットへ巻き込まれないよう、移動より先)
    2. 追跡されているフォント・画像・js(css/fonts・images・js・assets)を git の追跡から外す
    3. assets\fonts → <cssDir>\fonts、assets\js → <dataRoot>\js をコピーし、SHA256 で照合してから
       旧 assets\ を中身にかかわらず assets.migrated-<yyyyMMdd> へ改名して残す(共有フォルダでの
       途中失敗に備える。フォントと js 以外のものは移さずに報告する)
    4. CSS の url( 直後の ../fonts/ を fonts/ に直す(css\*.css と、承認前の作業コピー
       drafts\*.css・pending\*.css・reviews\<id>\body.css)
    5. appconfig を片付ける: editor の外を指す paths.assetsDir を paths.jsDir(<dataRoot>\js)へ
       置き換え、editor のフォルダの中を指す置き場の設定(旧例の data/templates など)、旧い仮の
       生成器・偽の生成器を指す python.script、既定と同じ・元から起動できない python.bin /
       python.args を外す。変える前に appconfig.json.bak-<yyyyMMdd> を作る(同じ日の 2 回目以降は
       -2, -3 … を付けて別名で残す)
    6. 確定領域の変更(.gitignore・css・取り込んだ .gitattributes)と追跡の解除を system 名義で
       1 コミットする
  作業コピー(drafts / pending / reviews)の CSS は git 管理外なので、書き換え前に
  <dataRoot>\.fonts-to-css-backup-<yyyyMMdd>\ へ退避する(rollback.ps1 がここから戻す)。
  置き場(dataRoot・drafts・pending・reviews・filled・css・旧 assets)はサーバと同じ順(環境変数 →
  appconfig → dataRoot 配下の既定)で決め、出典を表示する。appconfig の値が editor のフォルダの中を
  指すときは無視して既定を使う。環境変数が editor の中を指すときは報告だけする。
  報告だけするもの: templates / filled の HTML 内の fonts/ 参照、url(css/…) を持つ CSS、editor の
  フォルダの data、配信されない場所のフォント(<dataRoot>\fonts・css 直下・assets.migrated-* 以外の
  assets*)、新版が読まない旧い形式のデータ(配列でないメモ・held の申請・filled の無いこと)。
  移動先などに中身の違う同名のものがあれば、全件を並べてから中止する。
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

function Test-InsideEditor([string]$p, [string]$label) {
  # サーバと同じく editor 基準で絶対パスにしてから、<editorDir>\ で始まるかを見る(大文字小文字は
  # 区別しない)。パスとして読めない値(| などを含む)は .NET の例外のままだとどの設定か分からない
  # ので、出どころ($label)を添えて止める。
  try { $full = [IO.Path]::GetFullPath((Resolve-EditorPath $p)).TrimEnd('\') + '\' }
  catch { throw "$label の値 '$p' はパスとして読めません($($_.Exception.Message))。直してから再実行してください。" }
  return $full.StartsWith($editorDir.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)
}

# editor のフォルダの中を指す置き場の設定(旧例の data/templates など)は旧構成の名残。置き場の解決では
# 無視して dataRoot 配下の既定を使い(旧い場所を移設の対象にしないため)、-Apply で appconfig から
# 外す。tmpDir・logDir・webDist は editor の中に置くのが正しい設定なので対象にしない。
$placeKeys = 'dataRoot', 'templatesDir', 'filledDir', 'cssDir', 'jsDir', 'imagesDir', 'draftsDir',
  'pendingDir', 'reviewsDir', 'syncDir', 'assetsDir'
$insideKeys = @($placeKeys | Where-Object { $v = Get-CfgPath $_; $v -and (Test-InsideEditor $v "appconfig の paths.$_") })
function Get-PlaceCfg([string]$key) {
  if ($insideKeys -contains $key) { return $null }
  return Get-CfgPath $key
}
# 環境変数はパッチが変えられないので、editor の中を指していても報告だけする(解決にはサーバと同じく使う)。
$placeEnvs = 'DATA_ROOT', 'TEMPLATES_DIR', 'FILLED_DIR', 'CSS_DIR', 'JS_DIR', 'IMAGES_DIR', 'DRAFTS_DIR',
  'PENDING_DIR', 'REVIEWS_DIR', 'SYNC_DIR', 'ASSETS_DIR'
$insideEnvs = @(foreach ($n in $placeEnvs) {
    $v = [Environment]::GetEnvironmentVariable($n)
    if ($v -and (Test-InsideEditor $v "環境変数 $n")) { @{ Name = $n; Label = "環境変数 $n"; Value = $v } }
  })
# dataRoot の解決はユーザー環境変数 DATA_ROOT も読むので、同じく報告する(プロセスの DATA_ROOT と同じ
# 値なら上で報告済み)。
$userDataRoot = [Environment]::GetEnvironmentVariable('DATA_ROOT', 'User')
if ($userDataRoot -and $userDataRoot -ne $env:DATA_ROOT -and (Test-InsideEditor $userDataRoot 'ユーザー環境変数 DATA_ROOT')) {
  $insideEnvs += @{ Name = 'DATA_ROOT'; Label = 'ユーザー環境変数 DATA_ROOT'; Value = $userDataRoot }
}

# -DataRoot 引数が最優先。なければ DATA_ROOT(プロセス → ユーザー)→ appconfig の paths.dataRoot
# → 既定(サーバの既定と同じ editor の 2 つ上の editor-data)。
$source = '-DataRoot 引数'
if (-not $DataRoot) {
  $DataRoot = $env:DATA_ROOT; $source = '環境変数 DATA_ROOT'
  if (-not $DataRoot) {
    $DataRoot = [Environment]::GetEnvironmentVariable('DATA_ROOT', 'User'); $source = 'ユーザー環境変数 DATA_ROOT'
  }
  if (-not $DataRoot) { $DataRoot = Get-PlaceCfg 'dataRoot'; $source = 'appconfig の paths.dataRoot' }
  if ($DataRoot) { $DataRoot = Resolve-EditorPath $DataRoot }
  else { $DataRoot = Join-Path (Split-Path -Parent $workspace) 'editor-data'; $source = '既定' }
}
# 8.3 形式の短い名前(…\EDITOR~1 など)のままだと、Get-ChildItem が返す長い名前の FullName から
# 置き場の長さで相対パスを切り出すときに位置がずれ、違う場所へコピーする。フォルダがあれば長い名前へ
# 揃える。
if (Test-Path -LiteralPath $DataRoot -PathType Container) { $DataRoot = (Get-Item -LiteralPath $DataRoot).FullName }

# dataRoot 配下の置き場は 環境変数 → appconfig → <dataRoot>\<sub> の順で決め、出典を返す。
function Resolve-Place([string]$envName, [string]$key, [string]$sub) {
  $e = [Environment]::GetEnvironmentVariable($envName)
  if ($e) { return @{ Path = (Resolve-EditorPath $e); Source = "環境変数 $envName" } }
  $c = Get-PlaceCfg $key
  if ($c) { return @{ Path = (Resolve-EditorPath $c); Source = "appconfig の paths.$key" } }
  return @{ Path = (Join-Path $DataRoot $sub); Source = "既定(dataRoot\$sub)" }
}
$cssPlace = Resolve-Place 'CSS_DIR' 'cssDir' 'css'
$assetsPlace = Resolve-Place 'ASSETS_DIR' 'assetsDir' 'assets'
$draftsPlace = Resolve-Place 'DRAFTS_DIR' 'draftsDir' 'drafts'
$pendingPlace = Resolve-Place 'PENDING_DIR' 'pendingDir' 'pending'
$reviewsPlace = Resolve-Place 'REVIEWS_DIR' 'reviewsDir' 'reviews'
$filledPlace = Resolve-Place 'FILLED_DIR' 'filledDir' 'filled'
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
Write-Host "filled   : $($filledPlace.Path) ($($filledPlace.Source))"
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
  # 末尾の空白(スペース)だけ除く。git は .gitignore の行頭の空白と行末のタブを無視しないので、
  # "  /css/fonts/" や "/css/fonts/<TAB>" を "/css/fonts/" と同じに扱うと、効いていない行を
  # 「済み」と取り違える。
  return @($s.Split("`n") | ForEach-Object { $_.TrimEnd(' ') } | Where-Object { $_ -ne '' })
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
$conflicts = @()
foreach ($pair in @(@{ From = (Join-Path $assetsDir 'fonts'); To = (Join-Path $cssDir 'fonts') },
                    @{ From = (Join-Path $assetsDir 'js'); To = $jsDir })) {
  if (-not (Test-Path -LiteralPath $pair.From)) { continue }
  foreach ($f in Get-ChildItem -LiteralPath $pair.From -Recurse -File) {
    $rel = $f.FullName.Substring($pair.From.Length).TrimStart('\')
    $dest = Join-Path $pair.To $rel
    if (Test-Path -LiteralPath $dest) {
      # 最初の 1 件で止めず全件を集め、報告の後でまとめて中止する(1 件ずつ直して流し直させない)。
      if ((Get-FileHashHex $dest) -ne (Get-FileHashHex $f.FullName)) { $conflicts += "  $dest (移動元 $($f.FullName))" }
      continue
    }
    $moves += @{ From = $f.FullName; To = $dest }
  }
}

# 旧 assets は中身にかかわらず改名して残す(画像の置き場パッチが assets の残りで止まり続けない
# ように)。フォントと js 以外のものは移さないので報告する。
$renameAssets = Test-Path -LiteralPath $assetsDir
$migratedName = '{0}.migrated-{1}' -f (Split-Path -Leaf $assetsDir), $stamp
$assetsOthers = @()
if ($renameAssets) {
  $assetsOthers = @(Get-ChildItem -LiteralPath $assetsDir -Force |
    Where-Object { -not ($_.PSIsContainer -and ('fonts', 'js' -contains $_.Name)) } | ForEach-Object { $_.FullName })
  $migratedPath = Join-Path (Split-Path -Parent $assetsDir) $migratedName
  if (Test-Path -LiteralPath $migratedPath) {
    $conflicts += "  $migratedPath (同じ日の退避が既にあります。旧 assets と見比べて片方を手で片付けてください)"
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
# 末尾は空白だけ除く(git は行末の空白を無視するが、タブは無視しない)。
$ignoreLines = if (Test-Path -LiteralPath $gitignorePath) { @([IO.File]::ReadAllLines($gitignorePath) | ForEach-Object { $_.TrimEnd(' ') }) } else { @() }
$needsIgnore = -not ($ignoreLines -contains '/css/fonts/')
# appconfig の片付け。editor の外を指す paths.assetsDir は paths.jsDir=<dataRoot>\js へ置き換える。
$assetsToJs = [bool]((Get-CfgPath 'assetsDir') -and ($insideKeys -notcontains 'assetsDir'))
$py = if ($appConfig -and $appConfig.PSObject.Properties['python']) { $appConfig.python } else { $null }
$pyRemove = @()
$pyKeep = $null
if ($py) {
  # 既定の起動コマンドは PATH 上の python(引数なし)。それと同じ組、元から起動できない組、
  # py ランチャの組(PATH 上の python へ移す)は外す。絶対パスや他の引数は意図した設定なので残す。
  $binProp = $py.PSObject.Properties['bin']
  $argsProp = $py.PSObject.Properties['args']
  if ($binProp -or $argsProp) {
    $bin = if ($binProp) { [string]$binProp.Value } else { 'python' }
    # if 式の値は 1 要素の配列が文字列へ展開されるので、外側の @() で配列に保つ。
    $pyArgs = @(if ($argsProp) { $argsProp.Value | ForEach-Object { [string]$_ } })
    $noArgs = $pyArgs.Count -eq 0
    $only313 = $pyArgs.Count -eq 1 -and $pyArgs[0] -ceq '-3.13'
    if (($bin -ieq 'python' -and ($noArgs -or $only313)) -or ($bin -ieq 'py' -and $only313)) {
      if ($binProp) { $pyRemove += 'bin' }
      if ($argsProp) { $pyRemove += 'args' }
    } else {
      $pyKeep = "python.bin=$bin, python.args=[$($pyArgs -join ', ')]"
    }
  }
  $scriptProp = $py.PSObject.Properties['script']
  if ($scriptProp -and $scriptProp.Value) {
    # 旧い仮の生成器と現行の偽の生成器は、どちらも既定(偽の生成器)と同じ扱いなので外す。
    try { $scriptFull = [IO.Path]::GetFullPath((Resolve-EditorPath ([string]$scriptProp.Value))) }
    catch {
      throw ("appconfig の python.script の値 '$($scriptProp.Value)' はパスとして読めません" +
        "($($_.Exception.Message))。直してから再実行してください。")
    }
    foreach ($old in 'server\scripts\generate_template.py', 'server\scripts\fake_generate_template.py') {
      if ($scriptFull -ieq (Join-Path $editorDir $old)) { $pyRemove += 'script' }
    }
  }
}
$needsConfig = [bool]($appConfig -and ($assetsToJs -or $insideKeys.Count -gt 0 -or $pyRemove.Count -gt 0))

Write-Host "コピーするファイル: $($moves.Count) 件"
$moves | ForEach-Object { Write-Host "  $($_.From) -> $($_.To)" }
Write-Host "../fonts/ を書き換える CSS: $($rewrites.Count) 件"
$rewrites | ForEach-Object { Write-Host "  $($_.FullName)" }
if ($workRewrites.Count -gt 0) { Write-Host "うち作業コピー $($workRewrites.Count) 件は書き換え前に $backupRoot へ退避します。" }
Write-Host ".gitignore に /css/fonts/ を追記: $needsIgnore"
Write-Host "appconfig を書き換える: $needsConfig"
if ($assetsToJs) { Write-Host "  paths.assetsDir を paths.jsDir=$jsDir へ置き換えます" }
if ($insideKeys.Count -gt 0) {
  Write-Host '  旧構成の置き場の設定を外す(editor のフォルダの中を指しています。外すと dataRoot 配下の既定になります):'
  $insideKeys | ForEach-Object { Write-Host "    paths.$_ = $(Get-CfgPath $_)" }
}
foreach ($k in $pyRemove) { Write-Host "  python.$k を外します(既定の PATH 上の python・偽の生成器と同じ、または旧い指定)" }
if ($pyRemove -contains 'script') { Write-Host '  本番の生成器は環境変数 PY_GENERATE_SCRIPT(または appconfig の python.script)で指してください。' }
if ($pyKeep) { Write-Host "【報告】$pyKeep は既定と違う指定なので残します。PATH 上の Python 3.13 を使うなら手で外してください。" }
if ($env:ASSETS_DIR) {
  Write-Host ("※ 環境変数 ASSETS_DIR が設定されています。新版は読まないので外してください(js の置き場を変えていた" +
    "なら JS_DIR=$jsDir へ。パッチは環境変数を変えません)。")
}
foreach ($e in $insideEnvs) {
  # ASSETS_DIR は旧 assets の置き場の解決に使うので、editor の中でもその場所を移設・改名の対象にする。
  $moveNote = if ($e.Name -eq 'ASSETS_DIR' -and $renameAssets) {
    "旧 assets の置き場として使うので、-Apply でフォントと js を移したうえで、この場所を $migratedName へ改名します。"
  } else { '' }
  Write-Host ("【報告】$($e.Label) が editor のフォルダの中を指しています($($e.Value))。$moveNote" +
    'パッチは環境変数を変えないので、手で外してください。')
}
if ($reportHtml.Count -gt 0) {
  Write-Host "【報告】HTML 内に fonts/ 参照があります(移行後は配信されません。承認経路で css/fonts/ へ直してください):"
  $reportHtml | ForEach-Object { Write-Host "  $_" }
}
if ($reportCssCss.Count -gt 0) {
  Write-Host "【報告】url(css/…) を持つ CSS があります(新しい規則では css/css/ になります):"
  $reportCssCss | ForEach-Object { Write-Host "  $($_.FullName)" }
}
if (Test-Path -LiteralPath (Join-Path $editorDir 'data')) {
  Write-Host ("【報告】editor のフォルダに data が残っています($(Join-Path $editorDir 'data'))。新版は使いません。" +
    '中身は動かさず消さないので、不要なら手で片付けてください。')
}
$misplaced = @()
if (Test-Path -LiteralPath (Join-Path $DataRoot 'fonts')) { $misplaced += "$(Join-Path $DataRoot 'fonts') (フォントは $cssDir\fonts に置きます)" }
$misplaced += @(Get-ChildItem -LiteralPath $cssDir -File -ErrorAction SilentlyContinue |
  Where-Object { '.woff2', '.woff', '.ttf', '.otf' -contains $_.Extension.ToLowerInvariant() } |
  ForEach-Object { "$($_.FullName) (css 直下のフォントは配信されません。$cssDir\fonts に置きます)" })
$misplaced += @(Get-ChildItem -LiteralPath $DataRoot -Directory -Filter 'assets*' -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -ne 'assets' -and $_.Name -notlike 'assets.migrated-*' } |
  ForEach-Object { "$($_.FullName) (assets.migrated-* 以外の assets* は配信されません)" })
if ($misplaced.Count -gt 0) {
  Write-Host '【報告】配信されない場所にフォントや旧い置き場があります(書き換えません):'
  $misplaced | ForEach-Object { Write-Host "  $_" }
}
if ($renameAssets) { Write-Host "旧 assets を改名して残す: $assetsDir -> $migratedName" }
if ($assetsOthers.Count -gt 0) {
  Write-Host "【報告】旧 assets にフォントと js 以外のものがあります(移さずに $migratedName へ残します):"
  $assetsOthers | ForEach-Object { Write-Host "  $_" }
}
# 構築済み環境の断面より前の形式は、新版が読まない(互換処理を外した)ので手で直してもらう。
$oldData = @()
foreach ($f in Get-ChildItem -LiteralPath (Join-Path $DataRoot 'notes') -Filter '*.json' -File -ErrorAction SilentlyContinue) {
  try {
    $obj = ConvertFrom-Json -InputObject ([IO.File]::ReadAllText($f.FullName, $utf8NoBom))
    # 最上位が配列・文字列などのときは、PSObject.Properties が配列の Count や Length を返して件数が
    # 意味を持たないので、ファイル 1 件として報告する。
    if ($obj -isnot [Management.Automation.PSCustomObject]) {
      $oldData += "$($f.FullName) (最上位がオブジェクトではありません。メモの形式(pathKey → 投稿の配列)に直してください)"
      continue
    }
    $bad = @($obj.PSObject.Properties | Where-Object { $_.Value -isnot [array] })
    if ($bad.Count -gt 0) { $oldData += "$($f.FullName) (配列でない値 $($bad.Count) 件。新版は読み捨てます)" }
  } catch { $oldData += "$($f.FullName) (PowerShell で読めないため点検できません。手で確かめてください)" }
}
foreach ($d in Get-ChildItem -LiteralPath $reviewsPlace.Path -Directory -ErrorAction SilentlyContinue) {
  $meta = Join-Path $d.FullName 'meta.json'
  if (-not (Test-Path -LiteralPath $meta)) { continue }
  try {
    if (([IO.File]::ReadAllText($meta, $utf8NoBom) | ConvertFrom-Json).status -eq 'held') {
      $oldData += "$meta (status が held。新版は一覧に出しません)"
    }
  } catch { $oldData += "$meta (PowerShell で読めないため点検できません。手で確かめてください)" }
}
if (-not (Test-Path -LiteralPath $filledPlace.Path)) {
  $oldData += "$($filledPlace.Path) (filled フォルダがありません。この後の init-data-repo.bat で作れます)"
}
if ($oldData.Count -gt 0) {
  Write-Host ('【報告】新版が読まない旧い形式のデータがあります。手で直してください(メモは投稿の配列へ、' +
    'held の申請は pending へ):')
  $oldData | ForEach-Object { Write-Host "  $_" }
}
# 取り込む未コミットの変更と、追跡を外すファイル。
if ($absorbed.Count -gt 0) {
  Write-Host "取り込む未コミットの変更(このパッチと同じ形。同じコミットに含めます): $($absorbed.Count) 件"
  $absorbed | ForEach-Object { Write-Host "  $_" }
}
Write-Host "git の追跡から外すファイル(ファイルは残します): $($trackedFiles.Count) 件"
$trackedFiles | ForEach-Object { Write-Host "  $_" }
if ($conflicts.Count -gt 0) {
  throw ("競合: 移動先などに中身の違う同名のものがあります($($conflicts.Count) 件)。どちらを残すか決めてから" +
    "再実行してください:`n$($conflicts -join "`n")")
}
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
if ($renameAssets) { Rename-Item -LiteralPath $assetsDir -NewName $migratedName }
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
  # 同じ日に流し直しても、最初のバックアップ(移行前の状態。rollback.ps1 の復元元)は上書きしない。
  $bak = "$appConfigPath.bak-$stamp"
  $n = 2
  while (Test-Path -LiteralPath $bak) { $bak = "$appConfigPath.bak-$stamp-$n"; $n++ }
  Copy-Item -LiteralPath $appConfigPath -Destination $bak
  foreach ($k in $insideKeys) { $cfgPaths.PSObject.Properties.Remove($k) }
  if ($assetsToJs) {
    $cfgPaths.PSObject.Properties.Remove('assetsDir')
    $cfgPaths | Add-Member -NotePropertyName 'jsDir' -NotePropertyValue $jsDir -Force
  }
  foreach ($k in $pyRemove) { $py.PSObject.Properties.Remove($k) }
  if ($cfgPaths -and @($cfgPaths.PSObject.Properties).Count -eq 0) { $appConfig.PSObject.Properties.Remove('paths') }
  if ($py -and @($py.PSObject.Properties).Count -eq 0) { $appConfig.PSObject.Properties.Remove('python') }
  [IO.File]::WriteAllText($appConfigPath, ($appConfig | ConvertTo-Json -Depth 10), $utf8NoBom)
  Write-Host "appconfig を書き換えました(元は $bak に残しています)。"
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
