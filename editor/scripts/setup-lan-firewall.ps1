<#
.SYNOPSIS
  editor の社内 LAN 公開用に Windows ファイアウォールの受信許可ルールを登録する。

.DESCRIPTION
  サーバポート(既定 24680)への TCP 受信を許可するルールを登録する。プロファイルは
  Domain と Private のみ(社内 LAN 前提。公衆ネットワーク接続時にまで開けない)。
  同名ルールが既にあれば削除してから作り直すため、何度実行しても 1 本に保たれる。
  ファイアウォールルールの登録・削除には管理者権限が必要(非管理者なら明示エラーで
  終了する。「管理者として実行」で起動し直すこと)。

.PARAMETER Port
  受信を許可する TCP ポート。省略時はサーバ既定の 24680(config.ts の port と一致)。

.PARAMETER Remove
  登録済みルールを削除する(LAN 公開をやめるとき)。

.EXAMPLE
  editor\scripts\setup-lan-firewall.bat
  既定ポート 24680 の受信許可ルールを登録する(管理者で実行)。

.EXAMPLE
  editor\scripts\setup-lan-firewall.bat -Remove
  登録済みルールを削除する(管理者で実行)。
#>
param(
  [int]$Port = 24680,
  [switch]$Remove
)

$ErrorActionPreference = 'Stop'

# ルール名はポートを含めて一意にする(ポート変更後の旧ルールが別名で残っても、この
# スクリプトの -Remove ではなく Windows の設定画面から個別に消せるように表示名で区別)。
$ruleName = "Jinja Template Editor (TCP $Port)"

# 管理者権限の確認。ファイアウォール操作は要管理者で、権限不足だと分かりにくいエラーに
# なるため先に明示的に落とす。
$principal = New-Object Security.Principal.WindowsPrincipal(
  [Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host 'エラー: 管理者権限が必要です。「管理者として実行」で起動し直してください。'
  exit 1
}

# 冪等化: 同名ルールがあれば消してから登録する(-Remove のときは消すだけ)。
$existing = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
if ($existing) {
  $existing | Remove-NetFirewallRule
  Write-Host "既存ルールを削除しました: $ruleName"
}

if ($Remove) {
  if (-not $existing) { Write-Host "ルールは登録されていません: $ruleName" }
  exit 0
}

# 社内 LAN 前提のため Domain/Private のみ。Public(公衆 Wi-Fi 等)では開けない。
New-NetFirewallRule -DisplayName $ruleName `
  -Direction Inbound -Protocol TCP -LocalPort $Port `
  -Action Allow -Profile Domain, Private | Out-Null

Write-Host "受信許可ルールを登録しました: $ruleName (TCP $Port, Domain/Private)"
Write-Host '他端末からは https://<この端末のIP>:' -NoNewline
Write-Host "$Port/ でアクセスできます(start.bat lan で起動していること)。"
