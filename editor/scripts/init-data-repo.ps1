<#
.SYNOPSIS
  editor のテンプレ版管理用 data リポジトリ(dataRoot)を初期化する。

.DESCRIPTION
  確定保存したテンプレ(templates) とファンド別 CSS(css) を git で版管理するため、
  ワークスペースリポジトリの外に置く data リポジトリを作る(ネスト git の回避)。
  処理内容:
    1. dataRoot 配下にサーバが使う置き場をすべて作成する(templates/ filled/ css/ css/fonts/ sync/
       drafts/ pending/ reviews/ notes/ js/ images/)。サーバも必要時に作るが、
       共有フォルダへ置く運用では権限設定や目視確認のために最初から揃っている方が扱いやすい。
    2. git の履歴(HEAD)が無ければ初回コミットを作る。.git が無ければ git init から行い、
       .git はあるが HEAD が無い(git init だけした)ときは、そのリポジトリへ初回コミットを足す。
       .gitignore は無ければ書き、あれば足りない必須行だけを足す。.gitattributes はサーバと同じ形(先頭
       を * text eol=lf にし、無効な * text=lf を落とす。BOM 無し)に揃える。
       初回コミットに入れるのは、サーバの承認コミットと同じ確定領域(templates・filled・
       css(css/fonts を除く)・sync・.gitignore・.gitattributes)だけ。手で作り直した dataRoot に
       assets・js・images・notes などが残っていても記録しない。
    履歴が既にあれば git には触らない(何度流してもよい)。
  サーバは環境変数 DATA_ROOT(または appconfig.json の paths.dataRoot)でこの場所を
  参照する。drafts/ pending/ と一時ファイルは追跡しない(.gitignore)。pending/ を
  追跡しないのは整理ではなく防御の一部で、承認コミットに未承認の生成物が混ざると
  「確定領域へは承認経路からしか書けない」不変則が崩れるため。.gitattributes は
  `* text eol=lf`: text で改行正規化を有効にし eol=lf で作業ツリーも LF に固定するので、
  core.autocrlf の設定に関わらず Windows でも byte が揺れない。
  git は環境変数 GIT_BIN があればそれを使う(サーバと同じ。PATH に git が無い端末向け)。

.PARAMETER DataRoot
  data リポジトリの場所。UNC パス(\\server\share\editor-data)も指定できる。省略時は
  環境変数 DATA_ROOT(このプロセス → ユーザー環境変数の順)を使い、それも無ければ
  ワークスペースの 1 つ上の editor-data(例: C:\Users\<user>\editor-data)。いずれも
  サーバ(config.ts の dataRoot)と同じ解決で、相対パスは editor/ 基準になる。
  ユーザー環境変数まで見るのは、setx 直後の同じウィンドウでは $env: に反映されず、
  サーバ(新しいウィンドウから起動)と違う場所へ作ってしまうため。

.EXAMPLE
  editor\scripts\init-data-repo.bat
  環境変数 DATA_ROOT の場所(未設定なら既定の場所)に初期化する。

.EXAMPLE
  editor\scripts\init-data-repo.bat -DataRoot D:\editor-data
  指定した場所に初期化する。サーバ側は DATA_ROOT=D:\editor-data を設定する。

.EXAMPLE
  editor\scripts\init-data-repo.bat -DataRoot \\fileserver\share\editor-data
  ファイルサーバの共有上に初期化する。所有者が実行アカウントと異なる共有では、git が
  dubious ownership で止まるため、先に safe.directory を登録しておく。
#>
param(
  [string]$DataRoot
)

$ErrorActionPreference = 'Stop'

# このスクリプトは editor/scripts/ にあるため、2 つ上が editor/、3 つ上が
# ワークスペースの場所になる。data リポジトリの既定値はこれらを基準に解決する。
$editorDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$workspace = Split-Path -Parent $editorDir
# git の場所はサーバ(gitRepo.ts)と同じく GIT_BIN を優先する。PortableGit だけの端末で PATH に
# git が無くても流せるようにするため。
$gitExe = if ($env:GIT_BIN) { $env:GIT_BIN } else { 'git' }
$source = '-DataRoot 引数'
if (-not $DataRoot) {
  $fromEnv = $env:DATA_ROOT
  $source = '環境変数 DATA_ROOT'
  if (-not $fromEnv) {
    $fromEnv = [Environment]::GetEnvironmentVariable('DATA_ROOT', 'User')
    $source = 'ユーザー環境変数 DATA_ROOT'
  }
  if ($fromEnv) {
    # サーバ(config.ts の toPath)は相対パスを editor/ 基準で解決するので合わせる。
    $DataRoot = if ([IO.Path]::IsPathRooted($fromEnv)) { $fromEnv } else {
      [IO.Path]::GetFullPath((Join-Path $editorDir $fromEnv))
    }
  } else {
    $DataRoot = Join-Path (Split-Path -Parent $workspace) 'editor-data'
    $source = '既定'
  }
}

Write-Host "dataRoot: $DataRoot ($source)"

function Invoke-Git {
  # git は LF→CRLF 変換などの警告を stderr へ出す。$ErrorActionPreference = 'Stop' のままだと、
  # 出力をリダイレクトしたホストで PowerShell 5.1 がそれを例外にするので、stderr は自前で受けて
  # 終了コードで失敗を判定する。成功時の警告は捨て、失敗時だけ原因として例外メッセージへ載せる。
  $ErrorActionPreference = 'Continue'
  $all = @(& $gitExe -C $DataRoot @args 2>&1)
  if ($LASTEXITCODE -ne 0) {
    $err = ($all | Where-Object { $_ -is [Management.Automation.ErrorRecord] } | ForEach-Object { $_.ToString() }) -join "`n"
    throw "git $($args -join ' ') が失敗しました(終了コード $LASTEXITCODE)。`n$err"
  }
  return @($all | Where-Object { $_ -isnot [Management.Automation.ErrorRecord] })
}

function Test-GitHead {
  # HEAD が無い(git init だけした)リポジトリでは rev-parse が非 0 で終わる。それを例外にしない
  # よう、呼ぶ区間だけ設定を緩めて finally で戻す。
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & $gitExe -C $DataRoot rev-parse --verify -q HEAD 2>$null | Out-Null
    return ($LASTEXITCODE -eq 0)
  } finally { $ErrorActionPreference = $prev }
}

function Get-CommittedPathspecs {
  # サーバの承認コミット(gitRepo.ts の stageTrackedAreas と committedAreas.ts)と同じ確定領域。
  # 中身の無い置き場は渡さない(git add が pathspec の不一致で止まりうるため)。
  $fontsPrefix = (Join-Path $DataRoot 'css\fonts') + '\'
  foreach ($a in 'templates', 'filled', 'css', 'sync', '.gitignore', '.gitattributes') {
    $p = Join-Path $DataRoot $a
    if (Test-Path -LiteralPath $p -PathType Leaf) { $a; continue }
    if (-not (Test-Path -LiteralPath $p -PathType Container)) { continue }
    $files = @(Get-ChildItem -LiteralPath $p -Recurse -File -Force |
      Where-Object { -not $_.FullName.StartsWith($fontsPrefix, [StringComparison]::OrdinalIgnoreCase) })
    if ($files.Count -gt 0) { $a }
  }
}

# 1. ディレクトリ構成を用意する。名前は server/src/config.ts の既定と
#    notesFile.ts の notes/、gitRepo.ts の COMMITTED_PATHSPECS に合わせる。
New-Item -ItemType Directory -Force -Path $DataRoot | Out-Null
$dirs = 'templates', 'filled', 'css', 'css\fonts', 'sync', 'drafts', 'pending', 'reviews', 'notes',
  'js', 'images'
foreach ($d in $dirs) {
  New-Item -ItemType Directory -Force -Path (Join-Path $DataRoot $d) | Out-Null
}

# 2. 履歴が無ければ初回コミットを作る(.git が無ければ init から)。
$hasGit = Test-Path -LiteralPath (Join-Path $DataRoot '.git')
if ($hasGit -and (Test-GitHead)) {
  Write-Host 'git リポジトリは既に初期化済みです(スキップ)。'
} else {
  if (-not $hasGit) { Invoke-Git init -q | Out-Null }
  # 中身は gitRepo.ts の ensureGitignore の必須行と揃える。BOM 無しで書くのは、PowerShell 5.1 の
  # -Encoding utf8 が付ける BOM で先頭行がサーバの照合に一致せず、同じ行が重複して足されるため。
  # 既にある .gitignore は消さず、足りない必須行だけを足す(手で作り直した dataRoot の設定を残す)。
  $utf8NoBom = New-Object System.Text.UTF8Encoding $false
  $required = '/drafts/', '/reviews/', '/pending/', '/notes/', '/css/fonts/', '/images/', '*.tmp-*'
  $ignorePath = Join-Path $DataRoot '.gitignore'
  $current = if (Test-Path -LiteralPath $ignorePath) { [IO.File]::ReadAllText($ignorePath) } else { '' }
  $lines = @($current -split "`r?`n" | ForEach-Object { $_.Trim() })
  $missing = @($required | Where-Object { $lines -cnotcontains $_ })
  if ($missing.Count -gt 0) {
    if ($current -ne '' -and -not $current.EndsWith("`n")) { $current += "`n" }
    [IO.File]::WriteAllText($ignorePath, $current + (($missing -join "`n") + "`n"), $utf8NoBom)
  }
  # .gitattributes はサーバ(gitRepo.ts の ensureGitattributes)と同じ形に揃えてから記録する: 先頭を
  # `* text eol=lf` にし、無効な `* text=lf` を落とし、他の行は残す(BOM 無し・LF)。初回コミットへ
  # 無効な行や BOM を持ち込まないため。既に同じ形なら書かない。
  $attrPath = Join-Path $DataRoot '.gitattributes'
  $attrNow = if (Test-Path -LiteralPath $attrPath) { [IO.File]::ReadAllText($attrPath) } else { '' }
  $attrOthers = @($attrNow -split "`r?`n" | ForEach-Object { $_.Trim() } |
    Where-Object { $_ -ne '' -and $_ -cne '* text=lf' -and $_ -cne '* text eol=lf' })
  $attrWanted = $utf8NoBom.GetBytes(((@('* text eol=lf') + $attrOthers) -join "`n") + "`n")
  # if 式の値にすると空の配列がパイプラインで展開されて $null になるので、代入で受ける。
  $attrBytes = [byte[]]@()
  if (Test-Path -LiteralPath $attrPath) { $attrBytes = [IO.File]::ReadAllBytes($attrPath) }
  if ([Convert]::ToBase64String($attrBytes) -ne [Convert]::ToBase64String($attrWanted)) {
    [IO.File]::WriteAllBytes($attrPath, $attrWanted)
  }
  # css/fonts は上で必ず入れる .gitignore の /css/fonts/ で外す(サーバの stageTrackedAreas と同じ)。
  # `:(exclude)css/fonts` を併せて渡すと、git add は無視中のパスを名指ししたとみなして失敗する。
  $specs = @(Get-CommittedPathspecs)
  Invoke-Git add -A -- @specs | Out-Null
  Invoke-Git -c user.name=system -c user.email=system@editor.local commit -q -m '初期化: テンプレ版管理リポジトリ' | Out-Null
  if ($hasGit) {
    Write-Host '履歴(HEAD)の無い git リポジトリへ初回コミットを作成しました(確定領域だけを記録)。'
  } else {
    Write-Host 'git リポジトリを初期化し、初回コミットを作成しました。'
  }
}

Write-Host ''
Write-Host '完了しました。次の対応をしてください:'
Write-Host "  - サーバ起動時に環境変数 DATA_ROOT=$DataRoot を設定する(start.bat rest 等)。"
Write-Host '  - TortoiseGit で上記 dataRoot フォルダを開くと履歴/diff を参照できます。'
