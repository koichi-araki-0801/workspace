<#
.SYNOPSIS
  pie-chart CLI を単一 exe(Node SEA)へビルドする。
.DESCRIPTION
  同階層の scripts/build-exe.mjs を呼び出し、esbuild バンドル → SEA blob 生成 →
  postject 注入で dist-exe/pie-chart.exe を生成する。事前に依存(esbuild / postject)を
  pnpm install で導入しておくこと。引数はそのまま node スクリプトへ転送する。
.NOTES
  本ファイルは日本語を含むため UTF-8 BOM 必須(cp932 環境での文字化け回避)。
#>
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
node scripts/build-exe.mjs @args
exit $LASTEXITCODE
