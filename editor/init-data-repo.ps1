<#
.SYNOPSIS
  editor のテンプレ版管理用 data リポジトリ(dataRoot)を初期化する。

.DESCRIPTION
  確定保存したテンプレ(templates) とファンド別 CSS(css) を git で版管理するため、
  ワークスペースリポジトリの外に置く data リポジトリを作る(ネスト git の回避)。
  処理内容:
    1. dataRoot 配下に templates/ css/ drafts/ を作成する。
    2. 既存 editor/data/{templates,css} があれば dataRoot へコピーする(初回移行)。
    3. dataRoot が未初期化なら git init + .gitignore/.gitattributes + 初回コミット。
  サーバは環境変数 DATA_ROOT(または appconfig.json の paths.dataRoot)でこの場所を
  参照する。drafts/ と一時ファイルは追跡しない(.gitignore)。改行は LF 固定
  (.gitattributes)で Windows でも byte が揺れないようにする。

.PARAMETER DataRoot
  data リポジトリの場所。省略時はワークスペースの 1 つ上の editor-data
  (例: C:\Users\<user>\editor-data)。サーバ既定(config.ts の dataRoot)と一致。

.EXAMPLE
  init-data-repo.bat
  既定の場所(..\..\editor-data)に初期化する。

.EXAMPLE
  init-data-repo.bat -DataRoot D:\editor-data
  指定した場所に初期化する。サーバ側は DATA_ROOT=D:\editor-data を設定する。
#>
param(
  [string]$DataRoot
)

$ErrorActionPreference = 'Stop'

# このスクリプト(editor/)とワークスペースの場所を解決する。
$editorDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$workspace = Split-Path -Parent $editorDir
if (-not $DataRoot) {
  $DataRoot = Join-Path (Split-Path -Parent $workspace) 'editor-data'
}

Write-Host "dataRoot: $DataRoot"

# 1. ディレクトリ構成を用意する。
New-Item -ItemType Directory -Force -Path $DataRoot | Out-Null
foreach ($d in 'templates', 'css', 'drafts') {
  New-Item -ItemType Directory -Force -Path (Join-Path $DataRoot $d) | Out-Null
}

# 2. 既存 editor/data の本体(templates/css)を初回移行(コピー)する。
$src = Join-Path $editorDir 'data'
if (Test-Path $src) {
  foreach ($sub in 'templates', 'css') {
    $s = Join-Path $src $sub
    if (Test-Path $s) {
      Copy-Item (Join-Path $s '*') (Join-Path $DataRoot $sub) -Recurse -Force -ErrorAction SilentlyContinue
      Write-Host "コピー: editor/data/$sub -> dataRoot/$sub"
    }
  }
}

# 3. git リポジトリを初期化する(未初期化のときだけ)。
Push-Location $DataRoot
try {
  if (-not (Test-Path (Join-Path $DataRoot '.git'))) {
    git init | Out-Null
    Set-Content -Path '.gitignore' -Value "/drafts/`n*.tmp-*" -Encoding utf8
    Set-Content -Path '.gitattributes' -Value "* text=lf" -Encoding utf8
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
Write-Host '  - 旧 editor/data の追跡解除(任意。ワークスペースで実行):'
Write-Host '      git rm -r --cached editor/data'
Write-Host "      echo 'editor/data/' >> .gitignore"
