#requires -Version 5.1
<#
.SYNOPSIS
  オフライン重量物バンドルを GitHub Releases から HTTPS で取得し、リポジトリ直下へ置く。

.DESCRIPTION
  重量物（.pnpm-store / pnpm.tgz / ms-playwright / python-wheelhouse / git-tools /
  docs の mermaid JS / native-prebuilds）は git に入れず GitHub Releases（タグ offline-bundle-v1）に
  置いてある。本スクリプトは**取得だけ**を行う。展開と環境構築は setup-offline.bat の担当で、
  こちらはネットに出られる端末で実行し、取得物をリポジトリ直下（または bk\）に置いた状態で
  setup-offline.bat を実行する（ネットに出られない端末へは取得物 3 ファイルを持ち込む）。

  取得は一時ディレクトリで行い、Release の .sha256 と突き合わせた検証が通ってからだけ直下へ移す
  （検証前・失敗した取得物を直下に残さない。gh 不要。リポジトリは Public）。
  置くファイルは offline-deps-bundle.tar.gz / offline-deps-bundle.tar.gz.sha256 / bundle.key の 3 つ
  （-Source 指定時は source.zip / source.zip.sha256 が加わり 5 つ。遮断端末が git clone を持たない
  場合の持ち込み用で、展開は setup-offline.bat が行う）。

  バンドルの真正性は検証しない: 配布担当だけが Release を更新でき、配布先は同じ所有者の
  Public リポジトリを clone している前提で受け入れる。

.PARAMETER Owner
  GitHub オーナー名。既定 koichi-araki-0801。

.PARAMETER Repo
  リポジトリ名。既定 workspace。

.PARAMETER Tag
  重量物アセットの取得元タグ。既定 offline-bundle-v1。

.PARAMETER Source
  遮断端末へ持ち込むソース ZIP（source.zip + .sha256）も取得する。git clone で運用する端末では不要。

.EXAMPLE
  offline\fetch-offline-bundle.bat
.EXAMPLE
  offline\fetch-offline-bundle.bat -Tag offline-bundle-v2
#>
[CmdletBinding()]
param(
  [string]$Owner = 'koichi-araki-0801',
  [string]$Repo  = 'workspace',
  [string]$Tag   = 'offline-bundle-v1',
  [switch]$Source
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'lib\verify.ps1')
. (Join-Path $PSScriptRoot 'lib\fetch.ps1')

$RepoRoot   = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$BundleName = 'offline-deps-bundle.tar.gz'
$AssetBase  = "https://github.com/$Owner/$Repo/releases/download/$Tag"
Write-Host "[info] repo root: $RepoRoot"
Write-Host "[1/1] Release $Tag から HTTPS で取得します..."
try {
  $r = Save-VerifiedReleaseBundle -AssetBase $AssetBase -BundleName $BundleName -Destination $RepoRoot -IncludeSource:$Source
} catch {
  Write-Error "[error] $($_.Exception.Message)`n  タグ / ネットワーク / リポジトリの公開状態を確認してください。"
  exit 1
}
Write-Host "[info] 配置: $($r.Bundle)"
Write-Host "[info] 配置: $($r.Bundle).sha256"
Write-Host "[info] 配置: $($r.Key)"
if ($Source) {
  Write-Host "[info] 配置: $($r.Source)"
  Write-Host "[info] 配置: $($r.Source).sha256"
  Write-Host '[OK] 取得完了。遮断端末へ持ち込むのは次の 5 ファイル: offline-deps-bundle.tar.gz / .sha256 / bundle.key / source.zip / source.zip.sha256。続けて offline\setup-offline.bat を実行してください。'
} else {
  Write-Host '[OK] 取得完了。続けて offline\setup-offline.bat を実行してください。'
}
exit 0
