<#
.SYNOPSIS
  PdfToSvg の配布 exe を隔離 venv 内でワンクリックビルドする。
.DESCRIPTION
  共有ライブラリ scripts/lib/build-python-venv.ps1 で隔離 venv(.venv-build)を用意し、
  オフライン優先で依存を install した後、PyInstaller で dist\PdfToSvg\PdfToSvg.exe を生成する。
  venv 準備ロジックは graph-editor の同名スクリプトと共通化してある。
.PARAMETER Action
  `clean` を渡すと venv を作り直す(旧 build.bat の `clean` 引数に対応)。
.PARAMETER NoPause
  完了時の一時停止(pause)を抑止する。CI や自動実行から呼ぶときに使う。
.NOTES
  本ファイルは pdf-to-svg/scripts/ に置く。作業ディレクトリを pdf-to-svg ルートへ固定して
  PyInstaller を呼ぶため、packaging\pdftosvg.spec や出力 dist\ の相対前提が保たれる。
  日本語を含むため UTF-8 BOM 必須(cp932 環境での文字化け回避)。
#>
param(
  [string]$Action,
  [switch]$NoPause
)

$ErrorActionPreference = 'Stop'

# パス基準を解決する。$PSScriptRoot = pdf-to-svg/scripts、その 1 つ上が pdf-to-svg ルート、
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
  Write-Host ' [2/2] exe をビルド (PyInstaller)'
  Write-Host '============================================'
  Set-Location -LiteralPath $projectDir
  & $vpy -m PyInstaller packaging\pdftosvg.spec --clean --noconfirm --distpath dist --workpath build
  if ($LASTEXITCODE -ne 0) { throw 'ビルドに失敗しました。' }

  Write-Host ''
  Write-Host '============================================'
  Write-Host ' 完成: dist\PdfToSvg\PdfToSvg.exe'
  Write-Host '============================================'
}
catch {
  Write-Host ''
  Write-Host "[エラー] $($_.Exception.Message)"
  if (-not $NoPause) { cmd /c pause }
  exit 1
}

# 旧 build.bat 同様、ダブルクリック起動でウィンドウが即閉じしないよう待つ。
if (-not $NoPause) { cmd /c pause }
