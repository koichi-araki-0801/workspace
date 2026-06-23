<#
.SYNOPSIS
  pie-chart CLI を単一 exe(Node SEA)へビルドする。
.DESCRIPTION
  pie-chart ルートで依存をクリーンインストール(npm)してから、同フォルダの build-exe.mjs を
  呼び出して esbuild バンドル → SEA blob 生成 → postject 注入で dist-exe/pie-chart.exe を生成する。
  これにより「このフォルダだけ」で(事前の手動 install 無しに)exe を作れる。引数はそのまま
  node スクリプトへ転送する。
.NOTES
  本ファイルは pie-chart/scripts/ に置く。作業ディレクトリは `$PSScriptRoot` の 1 つ上
  (= pie-chart ルート)に固定し、build-exe.mjs の `dist-exe/` 等の相対パス前提を保つ。
  本ファイルは日本語を含むため UTF-8 BOM 必須(cp932 環境での文字化け回避)。
#>
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)

# ── 依存のクリーンインストール(npm) ──
# 旧 Node20 系の単独環境で「このフォルダだけ」で exe を作れるよう、ビルド前に依存を入れ直す。
# stale な node_modules/lock を消してから入れることで、`package.json` の overrides(npm 経路は
# vite@6 固定)が確実に効いた状態を保証する。開発機(pnpm ワークスペース)で依存解決をそのまま
# 使いたい場合は、本 .bat ではなく `pnpm run build:exe` を使うこと。本経路は npm の install を
# 走らせるため、pnpm の symlink 構成 node_modules をフラットな npm 構成へ置き換える。
if (Test-Path node_modules) { Remove-Item -Recurse -Force node_modules }
if (Test-Path package-lock.json) { Remove-Item -Force package-lock.json }
npm install
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

node scripts/build-exe.mjs @args
exit $LASTEXITCODE
