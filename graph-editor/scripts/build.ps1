<#
.SYNOPSIS
  LabelEditor(SVG ラベル位置エディタ)の配布 exe を隔離 venv 内でワンクリックビルドする。
.DESCRIPTION
  共有ライブラリ scripts/lib/build-python-venv.ps1 で隔離 venv(.venv-build)を用意し、
  オフライン優先で依存を install した後、PyInstaller の --onefile で dist\LabelEditor.exe
  (単一ファイル / 実行に Python 不要)を生成する。venv 準備ロジックは pdf-to-svg の同名
  スクリプトと共通化してある。

  設計: ブラウザエンジンは同梱しない。exe は小さなローカル HTTP サーバを起動し、OS の Edge
  をアプリモードで開く。ファイル入出力は `<input>`(開く)/ダウンロード(保存)固定
  (File System Access API は VDI で不安定なため不使用)。WebView2 ランタイムを同梱しない
  ため小さい(~10MB)。
.PARAMETER Action
  `clean` を渡すと venv を作り直す(旧 build.bat の `clean` 引数に対応)。
.PARAMETER NoPause
  完了時の一時停止(pause)を抑止する。CI や自動実行から呼ぶときに使う。
.NOTES
  本ファイルは graph-editor/scripts/ に置く。作業ディレクトリを graph-editor ルートへ固定して
  PyInstaller を呼ぶため、--add-data の相対元(ui.html / styles.css / js / lib)や app.py、
  出力 dist\ の相対前提が保たれる。
  日本語を含むため UTF-8 BOM 必須(cp932 環境での文字化け回避)。
#>
param(
  [string]$Action,
  [switch]$NoPause
)

$ErrorActionPreference = 'Stop'

# パス基準を解決する。$PSScriptRoot = graph-editor/scripts、その 1 つ上が graph-editor ルート、
# 2 つ上がワークスペース(共有 python-wheelhouse の置き場)。
. (Join-Path $PSScriptRoot '..\..\scripts\lib\build-python-venv.ps1')
$projectDir = Split-Path -Parent $PSScriptRoot
$workspace = Split-Path -Parent $projectDir
$wheelhouse = Join-Path $workspace 'python-wheelhouse'
$requirements = Join-Path $projectDir 'requirements.txt'

try {
  $vpy = Initialize-BuildVenv -ProjectDir $projectDir -RequirementsPath $requirements `
    -WheelhouseDir $wheelhouse -Clean:($Action -eq 'clean')

  Write-Host ''
  Write-Host '============================================'
  Write-Host ' [2/2] exe をビルド (PyInstaller, 単一ファイル)'
  Write-Host '============================================'
  Set-Location -LiteralPath $projectDir
  & $vpy -m PyInstaller --noconfirm --clean --onefile --windowed --name LabelEditor `
    --add-data 'resources/web/ui.html;.' `
    --add-data 'resources/web/styles.css;.' `
    --add-data 'resources/web/js;js' `
    --add-data 'resources/web/lib/leader_geom.cjs;lib' `
    app.py
  if ($LASTEXITCODE -ne 0) {
    throw 'ビルドに失敗しました。LabelEditor.exe 実行中なら閉じて再実行してください(上書き不可)。'
  }

  Write-Host ''
  Write-Host '完成: dist\LabelEditor.exe (単一ファイル, ~10MB)'
  Write-Host '  配布: このファイルを渡すだけ。受け取り側はダブルクリックで Microsoft Edge の'
  Write-Host '        アプリウィンドウが開きます(Windows 10/11 標準の Edge を使用, 追加導入不要)。'
}
catch {
  Write-Host ''
  Write-Host "[エラー] $($_.Exception.Message)"
  if (-not $NoPause) { cmd /c pause }
  exit 1
}

# 旧 build.bat 同様、ダブルクリック起動でウィンドウが即閉じしないよう待つ。
if (-not $NoPause) { cmd /c pause }
