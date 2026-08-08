#requires -Version 5.1
<#
.SYNOPSIS
  オフライン重量物バンドルの分離署名に使う RSA 鍵ペアを 1 回だけ生成する（公開担当者用）。

.DESCRIPTION
  秘密鍵はユーザープロファイル配下（既定 %USERPROFILE%\.offline-signing）へ、公開鍵は
  リポジトリの offline\bundle-signing.pub.xml へ書き出す。公開鍵は offline/ フォルダごと
  手渡しで air-gapped 機へ運ばれ、setup 側の唯一の真正性の根拠になる（配信元から取る
  .sha256 は転送破損の検知にしかならず、すり替えの検知にはならない）。

  既存の鍵がある場合は上書きしない（-Force で明示的に置き換える）。鍵を作り直すと過去に
  配布した署名は検証できなくなるため、置き換え時は重量物の再公開が必要になる。

.PARAMETER PrivateKeyPath
  秘密鍵（RSA XML 形式）の出力先。既定 %USERPROFILE%\.offline-signing\bundle-signing.key.xml。

.PARAMETER PublicKeyPath
  公開鍵（RSA XML 形式）の出力先。既定 <repo>\offline\bundle-signing.pub.xml。

.PARAMETER Force
  既存の鍵ファイルを上書きする。

.EXAMPLE
  offline\new-bundle-signing-key.bat
#>
[CmdletBinding()]
param(
  [string]$PrivateKeyPath = (Join-Path $env:USERPROFILE '.offline-signing\bundle-signing.key.xml'),
  # 既定は本体で解決する。`param()` の既定値の中では **Windows PowerShell 5.1 の
  # `$PSScriptRoot` が空**で、`Join-Path` が「空文字は渡せない」で即死する(実測)。
  # 空を許す型にしておき、下で `$PSScriptRoot` が使える文脈になってから埋める。
  [string]$PublicKeyPath = '',
  [switch]$Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrEmpty($PublicKeyPath)) {
  $PublicKeyPath = Join-Path $PSScriptRoot 'bundle-signing.pub.xml'
}

. (Join-Path $PSScriptRoot 'lib\verify.ps1')

foreach ($p in @($PrivateKeyPath, $PublicKeyPath)) {
  if ((Test-Path -LiteralPath $p) -and -not $Force) {
    Write-Error "[error] 既に鍵があります: $p（置き換えるなら -Force。過去の署名は検証できなくなります）"
    exit 1
  }
}

$keyDir = Split-Path -Parent $PrivateKeyPath
if (-not (Test-Path -LiteralPath $keyDir)) { New-Item -ItemType Directory -Path $keyDir -Force | Out-Null }

$pair = New-OfflineSigningKeyPair
# 秘密鍵は ASCII（XML）で書き、所有者以外の読み取りを外す。BOM を付けないのは XML の
# パーサ差異を避けるため（ここは日本語を含まない機械可読ファイル）。
Set-Content -LiteralPath $PrivateKeyPath -Value $pair.PrivateXml -Encoding ascii -NoNewline
Set-Content -LiteralPath $PublicKeyPath -Value $pair.PublicXml -Encoding ascii -NoNewline

# 秘密鍵の ACL を所有者のみへ切り詰める（継承を切って現ユーザーだけを残す）。
try {
  $acl = Get-Acl -LiteralPath $PrivateKeyPath
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($r in @($acl.Access)) { $acl.RemoveAccessRule($r) | Out-Null }
  $me = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
        $me, 'FullControl', 'Allow')))
  Set-Acl -LiteralPath $PrivateKeyPath -AclObject $acl
} catch {
  Write-Warning "[warn] 秘密鍵の ACL 設定に失敗しました。手動で権限を絞ってください: $PrivateKeyPath"
}

Write-Host "[OK] 秘密鍵: $PrivateKeyPath（バックアップは各自で。リポジトリへは絶対に入れない）"
Write-Host "[OK] 公開鍵: $PublicKeyPath（このファイルをコミットし、offline/ ごと配布先へ運ぶ）"
Write-Host '次に offline\publish-offline-bundle.bat を引数なしで実行し、署名付きで重量物を公開してください。'
