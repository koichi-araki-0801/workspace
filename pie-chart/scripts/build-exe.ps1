<#
.SYNOPSIS
  pie-chart CLI を単一 exe(Node SEA)へビルドする。
.DESCRIPTION
  pie-chart ルートで依存を lockfile どおりに再現インストール(npm ci)してから、同フォルダの
  build-exe.mjs を呼び出して esbuild バンドル → SEA blob 生成 → postject 注入で
  dist-exe/pie-chart.exe を生成する。引数はそのまま node スクリプトへ転送する。
.NOTES
  本ファイルは pie-chart/scripts/ に置く。作業ディレクトリは `$PSScriptRoot` の 1 つ上
  (= pie-chart ルート)に固定し、build-exe.mjs の `dist-exe/` 等の相対パス前提を保つ。
  本ファイルは日本語を含むため UTF-8 BOM 必須(cp932 環境での文字化け回避)。
#>
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)

# ── 依存の再現インストール(npm ci --ignore-scripts) ──
# ここはコード署名鍵を持つビルド端末で走る。以前の「lockfile を消して範囲指定のまま
# npm の install」は、レジストリへ差し込まれた新版の lifecycle script を署名端末で
# 実行させる経路だった(npm は pnpm の `allowBuilds` に相当する既定の抑止を持たない)。
# 対策は 2 点で固定する:
#   1. lockfile(コミット済み package-lock.json)は消さず、解決結果を integrity ごと再現する。
#   2. `--ignore-scripts` で lifecycle script を一律実行しない。exe ビルドに script 実行が
#      必要な依存は無い(esbuild は optionalDependencies のプラットフォーム別バイナリ、
#      subset-font/harfbuzzjs は wasm 同梱。msnodesqlv8 の native build は走らなくなるが、
#      exe は DB 入力非対応なので不要)。
# `npm ci` は node_modules を自前で消してから入れるため、開発機の pnpm symlink 構成も
# フラットな npm 構成へ置き換わる。pnpm ワークスペースの依存解決をそのまま使いたい
# 場合は、本 .bat/.ps1 ではなく `pnpm run build:exe` を使うこと。
npm ci --ignore-scripts
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

node scripts/build-exe.mjs @args
exit $LASTEXITCODE
