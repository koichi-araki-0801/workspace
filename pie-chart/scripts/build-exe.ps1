<#
.SYNOPSIS
  pie-chart CLI を単一 exe(Node SEA)へビルドする。
.DESCRIPTION
  既存の node_modules(リポジトリ直下の `pnpm install` で入れたもの)で build-exe.mjs を呼び出し、
  esbuild バンドル → SEA blob 生成 → postject 注入で dist-exe/pie-chart.exe を生成する。
  依存の install はしない。引数はそのまま node スクリプトへ転送する(`--no-db` / `--sign`)。
.NOTES
  本ファイルは pie-chart/scripts/ に置く。作業ディレクトリは `$PSScriptRoot` の 1 つ上
  (= pie-chart ルート)に固定し、build-exe.mjs の `dist-exe/` 等の相対パス前提を保つ。
  本ファイルは日本語を含むため UTF-8 BOM 必須(cp932 環境での文字化け回避)。
#>
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)

node scripts/build-exe.mjs @args
exit $LASTEXITCODE
