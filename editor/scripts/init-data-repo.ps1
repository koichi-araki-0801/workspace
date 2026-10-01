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
    2. dataRoot が未初期化なら git init + .gitignore/.gitattributes + 初回コミット。
  サーバは環境変数 DATA_ROOT(または appconfig.json の paths.dataRoot)でこの場所を
  参照する。drafts/ pending/ と一時ファイルは追跡しない(.gitignore)。pending/ を
  追跡しないのは整理ではなく防御の一部で、承認コミット(git add -A)に未承認の生成物が
  混ざると「確定領域へは承認経路からしか書けない」不変則が崩れるため。.gitattributes は
  `* text eol=lf`: text で改行正規化を有効にし eol=lf で作業ツリーも LF に固定するので、
  core.autocrlf の設定に関わらず Windows でも byte が揺れない。

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

# 1. ディレクトリ構成を用意する。名前は server/src/config.ts の既定と
#    notesFile.ts の notes/、gitRepo.ts の COMMITTED_PATHSPECS に合わせる。
New-Item -ItemType Directory -Force -Path $DataRoot | Out-Null
$dirs = 'templates', 'filled', 'css', 'css\fonts', 'sync', 'drafts', 'pending', 'reviews', 'notes',
  'js', 'images'
foreach ($d in $dirs) {
  New-Item -ItemType Directory -Force -Path (Join-Path $DataRoot $d) | Out-Null
}

# 2. git リポジトリを初期化する(未初期化のときだけ)。
Push-Location $DataRoot
try {
  if (-not (Test-Path (Join-Path $DataRoot '.git'))) {
    git init | Out-Null
    # 中身は gitRepo.ts の ensureGitignore の必須行と揃える。BOM 無しで書くのは、
    # PowerShell 5.1 の -Encoding utf8 が付ける BOM で先頭行がサーバの照合に一致せず、
    # 同じ行が重複して足されるため。
    $utf8NoBom = New-Object System.Text.UTF8Encoding $false
    [IO.File]::WriteAllText((Join-Path $DataRoot '.gitignore'),
      "/drafts/`n/reviews/`n/pending/`n/notes/`n/css/fonts/`n/images/`n*.tmp-*`n", $utf8NoBom)
    [IO.File]::WriteAllText((Join-Path $DataRoot '.gitattributes'), "* text eol=lf`n", $utf8NoBom)
    git add -A | Out-Null
    git -c user.name=system -c user.email=system@editor.local commit -m '初期化: テンプレ版管理リポジトリ' | Out-Null
    Write-Host 'git リポジトリを初期化し、初回コミットを作成しました。'
  } else {
    Write-Host 'git リポジトリは既に初期化済みです(スキップ)。'
  }
} finally {
  Pop-Location
}

Write-Host ''
Write-Host '完了しました。次の対応をしてください:'
Write-Host "  - サーバ起動時に環境変数 DATA_ROOT=$DataRoot を設定する(start.bat rest 等)。"
Write-Host '  - TortoiseGit で上記 dataRoot フォルダを開くと履歴/diff を参照できます。'
