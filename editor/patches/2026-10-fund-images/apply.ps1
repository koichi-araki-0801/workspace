<#
.SYNOPSIS
  editor の data リポジトリに、ファンド別画像の置き場(images)を用意する。

.DESCRIPTION
  既定は確認モードで、置き場の解決結果・行う変更・既に置かれた画像の点検結果を表示するだけで
  何も変えない。-Apply を付けたときだけ実行する。処理順:
    1. .gitignore に /images/ が無ければ追記する(画像を置く前に git の追跡外にしておく)
    2. <imagesDir> が無ければ作る
    3. 追跡されている画像・フォント・js(css/fonts・images・js・assets)を git の追跡から外す
       (ファイルは残す)
    4. 確定領域の変更(.gitignore と、取り込んだ未コミットの変更)と追跡の解除を system 名義で
       1 コミットする(件名末尾に [fund-images])
  既に置かれた画像は点検して報告するだけで、動かしも消しもしない。SVG の中身の検査はサーバ
  (TypeScript 実装)が正なので、ここでは行わない。違反はサーバログの警告で確認する。
  次の場合は中止する: editor サーバが動いている、dataRoot が git リポジトリでない・履歴(HEAD)が
  無い、旧構成の assets が残っている(先に 2026-10-fonts-to-css を流す)、imagesDir が確定領域
  (templates / filled / css / sync)の内側にある、パッチが作る形でない未コミットの変更がある。
  未コミットの変更は 1 件ずつ点検し、.gitignore への必須行の追記・CSS の ../fonts/ → fonts/ の
  書き換え・.gitattributes を * text eol=lf にしただけなら取り込んで同じコミットに含める(BOM と
  改行コードの違いは除いて比べる)。点検範囲の外でステージ済みの変更があっても中止する。
  templates も css も無いときは dataRoot の取り違えとみなし、何も変えずに終了コード 2 で終わる。
  git は環境変数 GIT_BIN があればそれを使う。

.PARAMETER DataRoot
  data リポジトリの場所。省略時は -DataRoot → 環境変数 DATA_ROOT(プロセス → ユーザー) →
  appconfig の paths.dataRoot → 既定の順で決める(2026-10-fonts-to-css と同じ規則。appconfig の値が
  editor のフォルダの中を指すときは使わない)。

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

function Resolve-PlacePath([string]$p, [string]$label) {
  # パスとして読めない値(| などを含む)は .NET の例外のままだとどの設定か分からないので、
  # 出どころ($label)を添えて止める。
  try { return [IO.Path]::GetFullPath((Resolve-EditorPath $p)) }
  catch { throw "$label の値 '$p' はパスとして読めません($($_.Exception.Message))。直してから再実行してください。" }
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

function Get-CfgDataRoot {
  # editor のフォルダの中を指す値は旧構成の名残で、フォント移設パッチも無視して外す。同じ扱いにして
  # おかないと、移設パッチを流す前の環境で editor の中を dataRoot として点検してしまう。
  $v = Get-CfgPath 'dataRoot'
  if (-not $v) { return $null }
  $full = (Resolve-PlacePath $v 'appconfig の paths.dataRoot').TrimEnd('\') + '\'
  if ($full.StartsWith($editorDir.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) {
    Write-Host "appconfig の paths.dataRoot($v)は editor のフォルダの中を指すため使いません。"
    return $null
  }
  return $v
}

# ユーザー環境変数はレジストリから Get-ItemProperty で読む([Environment]::GetEnvironmentVariable と
# 同じ値)。テストが本物の dataRoot を指すユーザー環境変数を差し替えられるようにするため。
$source = '-DataRoot 引数'
if (-not $DataRoot) {
  $DataRoot = $env:DATA_ROOT; $source = '環境変数 DATA_ROOT'
  if (-not $DataRoot) {
    $userEnv = Get-ItemProperty -LiteralPath 'HKCU:\Environment' -Name 'DATA_ROOT' -ErrorAction SilentlyContinue
    $DataRoot = if ($userEnv) { [string]$userEnv.DATA_ROOT } else { $null }
    $source = 'ユーザー環境変数 DATA_ROOT'
  }
  if (-not $DataRoot) { $DataRoot = Get-CfgDataRoot; $source = 'appconfig の paths.dataRoot' }
  if ($DataRoot) { $DataRoot = Resolve-PlacePath $DataRoot $source }
  else { $DataRoot = Join-Path (Split-Path -Parent $workspace) 'editor-data'; $source = '既定' }
}
# 8.3 形式の短い名前(…\EDITOR~1 など)のままだと、Get-ChildItem が返す長い名前と比べたときに
# 一致せず、画像の点検を取り違える。フォルダがあれば長い名前へ揃える。
if (Test-Path -LiteralPath $DataRoot -PathType Container) { $DataRoot = (Get-Item -LiteralPath $DataRoot).FullName }

# images は IMAGES_DIR → appconfig の paths.imagesDir → <dataRoot>\images(サーバの config.ts と同じ順)。
$imagesSource = '既定(dataRoot\images)'
$imagesDir = Join-Path $DataRoot 'images'
if ($env:IMAGES_DIR) { $imagesDir = Resolve-PlacePath $env:IMAGES_DIR '環境変数 IMAGES_DIR'; $imagesSource = '環境変数 IMAGES_DIR' }
elseif (Get-CfgPath 'imagesDir') {
  $imagesDir = Resolve-PlacePath (Get-CfgPath 'imagesDir') 'appconfig の paths.imagesDir'; $imagesSource = 'appconfig の paths.imagesDir'
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
# templates も css も無い場所は、dataRoot の取り違え(別のフォルダを指している)とみなす。
if (-not (Test-Path -LiteralPath (Join-Path $DataRoot 'templates')) -and -not (Test-Path -LiteralPath (Join-Path $DataRoot 'css'))) {
  Write-Warning ("$DataRoot に templates も css もありません。dataRoot を取り違えていないか確かめてください" +
    '(-DataRoot で指定できます)。何も変えずに終了します。')
  exit 2
}
if (-not (Test-Path -LiteralPath (Join-Path $DataRoot '.git'))) {
  throw ("$DataRoot は git リポジトリではありません。editor\scripts\init-data-repo.bat -DataRoot `"$DataRoot`" で " +
    'git リポジトリと初回コミット(確定領域だけを記録します)を作ってから再実行してください。')
}
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

# ── 未コミットの変更の点検(2026-10-fonts-to-css の migrate.ps1 と同じ規則の写し) ──
# 手で dataRoot を作り直した直後や、新版のサーバが承認時に .gitignore へ必須行を足した後は、未コミット
# の変更が残る。このパッチ・フォント移設パッチ・init-data-repo・サーバが作るのと同じ形の変更だけなら
# 取り込んで同じコミットに含め、それ以外が 1 つでもあれば中止する。見るのは確定領域だけ(css/fonts は
# 除く)。比べる前に BOM を除き、改行を LF に揃える(構築済み環境の .gitattributes・.gitignore は BOM 付き・CRLF のことがある)。
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
  # "  /images/" や "/images/<TAB>" を "/images/" と同じに扱うと、効いていない行を「済み」と
  # 取り違える。
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
  $foreign += "  $xy $rel"
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
  if ($traces.Count -gt 0) {
    throw ("前回のパッチ(または rollback)が途中で止まった形跡があります($($traces -join ', '))。" +
      "git -C `"$DataRoot`" status で状態を確かめ、途中の操作を終えるか戻してから再実行してください。" +
      "次の未コミットの変更は、このパッチが作る形ではありません:`n$list")
  }
  throw ("手作業の変更が残っています。次の未コミットの変更は、パッチが作る形(.gitignore への必須行の追記・" +
    'CSS の ../fonts/ → fonts/ の書き換え・.gitattributes を * text eol=lf にしただけ)ではないため中止' +
    "しました。残すなら先にコミットしてください。要らなければ、ステージ済みのものを git -C `"$DataRoot`" " +
    "restore --staged -- <ファイル> でステージから外し、変更したファイルは git -C `"$DataRoot`" checkout -- " +
    "<ファイル> で戻し、新しく足したファイルは消してから再実行してください(新しく足したファイルを " +
    "checkout -- に渡すと、git の知らないファイルとして全体が失敗します):`n$list")
}

# 追跡された画像・フォント・js は、承認コミットのたびに版に残り続け、次の承認者の名前で更新される。
# ファイルは残して追跡だけ外し、同じ system コミットに含める。
$trackedFiles = @((Invoke-GitUtf8 -GitArgs @('ls-files', '-z', '--', 'css/fonts', 'images', 'js', 'assets')).Out.Split([char]0) | Where-Object { $_ -ne '' })
$untrackPlaces = @('css/fonts', 'images', 'js', 'assets' | Where-Object {
    $place = $_
    @($trackedFiles | Where-Object { $_.StartsWith("$place/") }).Count -gt 0
  })

# ── 3. 計画と点検 ──
$gitignorePath = Join-Path $DataRoot '.gitignore'
# 末尾は空白だけ除く(git は行末の空白を無視するが、行頭の空白とタブは無視しない)。
$ignoreLines = if (Test-Path -LiteralPath $gitignorePath) { @([IO.File]::ReadAllLines($gitignorePath) | ForEach-Object { $_.TrimEnd(' ') }) } else { @() }
$needsIgnore = -not ($ignoreLines -contains '/images/')
$needsDir = -not (Test-Path -LiteralPath $imagesFull)

$report = @()
if (-not $needsDir) {
  foreach ($f in Get-ChildItem -LiteralPath $imagesFull -Recurse -File) {
    # 置けるのは直下と 1 段下の会社フォルダだけ。2 段以上はサーバの配信経路(:file と :dir/:file)の形に合わない。
    $depth = if ($f.DirectoryName.TrimEnd('\') -ieq $imagesFull) { 0 }
      elseif ($f.Directory.Parent.FullName.TrimEnd('\') -ieq $imagesFull) { 1 }
      else { 2 }
    if ($depth -ge 2) {
      $report += "[subfolder] $($f.FullName) (images の 2 段以上下は配信されません。置けるのは直下と 1 段下の会社フォルダ)"; continue
    }
    if ($allowedExt -notcontains $f.Extension.ToLowerInvariant()) {
      $report += "[extension] $($f.FullName) (許可外の拡張子は配信されません。.svg .png .jpg .jpeg)"; continue
    }
    # 命名の約束は直下のファンド別画像のもの。会社フォルダの画像は会社共通なので名前を見ない。
    if ($depth -eq 0 -and -not (Test-FundImageName $f.Name)) {
      $report += "[naming] $($f.FullName) (命名 <fund>_<名前>.<拡張子> に合いません。配信はされます)"
    }
  }
}

Write-Host ".gitignore に /images/ を追記: $needsIgnore"
Write-Host "images フォルダを作成: $needsDir"
if ($absorbed.Count -gt 0) {
  Write-Host "取り込む未コミットの変更(パッチと同じ形。同じコミットに含めます): $($absorbed.Count) 件"
  $absorbed | ForEach-Object { Write-Host "  $_" }
}
Write-Host "git の追跡から外すファイル(ファイルは残します): $($trackedFiles.Count) 件"
$trackedFiles | ForEach-Object { Write-Host "  $_" }
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
# -f は「index が HEAD とも作業ツリーとも違う」ときの確認を外すだけで、--cached なので作業ツリーの
# ファイルには触れない(手で変更してステージした画像でも追跡を外せるようにするため)。
if ($untrackPlaces.Count -gt 0) { Invoke-Git rm -r -q --cached --ignore-unmatch -f -- @untrackPlaces | Out-Null }
$addPaths = @('.gitignore') + @($absorbed | Where-Object { $_ -ne '.gitignore' })
Invoke-Git add -- @addPaths | Out-Null
$staged = Invoke-Git diff --cached --name-only
if ($staged) {
  # 末尾の [fund-images] は rollback.ps1 が git log --grep で探す ASCII の目印(日本語を
  # 引数で渡すと PowerShell 5.1 の文字コード変換で一致しなくなる)。
  Invoke-Git -c user.name=system -c user.email=system@editor.local commit -q -m '移行: 画像の置き場を追加 [fund-images]' | Out-Null
  Write-Host '確定領域の変更を system 名義でコミットしました。'
}
Write-Host '完了しました。editor を起動してください。'
