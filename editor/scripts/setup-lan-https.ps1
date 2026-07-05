<#
.SYNOPSIS
  editor の社内 LAN 向け HTTPS 待受に使う自己署名証明書(PFX)を生成する。

.DESCRIPTION
  Windows 標準の New-SelfSignedCertificate だけで完結する(openssl / mkcert 不要。
  オフライン環境で実行可能)。処理内容:
    1. SAN に localhost・このマシンのホスト名・LAN の IPv4 を含む自己署名証明書を生成する。
       IP は ipaddress エントリで入れる(ブラウザは IP 直打ち URL を iPAddress SAN でしか
       照合しないため、DNS エントリに IP を書いても警告が消えない)。有効期限は 5 年。
    2. editor/server/tls/ へ editor.pfx(秘密鍵入り。ランダムパスフレーズ)と
       editor.pfx.pass(パスフレーズ。社内 LAN 前提の割り切りで平文併置)を出力する。
    3. クライアント配布用の公開証明書 editor-lan.cer も同フォルダへ出力する。
       他端末はこれを「信頼されたルート証明機関」へ取り込むと警告なしで接続できる
       (管理者コマンド例: certutil -addstore Root editor-lan.cer)。
    4. 生成後、一時利用したユーザ証明書ストアからは削除する(ファイルのみ残す)。
  サーバは server/src/config.ts の tls.pfxPath(既定 server/tls/editor.pfx)を見て、
  ファイルが存在するときだけ HTTPS で待受ける。社内 CA 発行の証明書を使う場合は
  その PFX を同じ場所に置き、パスフレーズを editor.pfx.pass か環境変数
  HTTPS_PFX_PASSPHRASE で与えれば本スクリプトは不要。

.PARAMETER Force
  既存の editor.pfx があっても確認なしで作り直す(他端末へ配布済みの cer は失効するため
  作り直したら cer の再配布が必要)。

.EXAMPLE
  editor\scripts\setup-lan-https.bat
  既定の場所(editor\server\tls\)に証明書一式を生成する。

.EXAMPLE
  editor\scripts\setup-lan-https.bat -Force
  既存の証明書を破棄して作り直す。
#>
param(
  [switch]$Force
)

$ErrorActionPreference = 'Stop'

# このスクリプトは editor/scripts/ にあるため、1 つ上が editor/。出力先はサーバ既定
# (config.ts の tls.pfxPath = server/tls/editor.pfx)と一致させる。
$editorDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$tlsDir = Join-Path $editorDir 'server\tls'
$pfxPath = Join-Path $tlsDir 'editor.pfx'
$passPath = Join-Path $tlsDir 'editor.pfx.pass'
$cerPath = Join-Path $tlsDir 'editor-lan.cer'

if ((Test-Path $pfxPath) -and -not $Force) {
  Write-Host "既に $pfxPath が存在します。作り直す場合は -Force を付けて再実行してください。"
  exit 1
}

# SAN を組み立てる。IP 直打ちでの利用が主のため、LAN の IPv4 を全て ipaddress エントリで
# 含める(ループバックと APIPA 169.254.* は除外)。
$ips = @(Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object { $_.IPAddress -ne '127.0.0.1' -and $_.IPAddress -notlike '169.254.*' } |
    Select-Object -ExpandProperty IPAddress)
$sanParts = @('dns=localhost', "dns=$env:COMPUTERNAME") + ($ips | ForEach-Object { "ipaddress=$_" })
$san = '2.5.29.17={text}' + ($sanParts -join '&')
Write-Host "SAN: $($sanParts -join ', ')"

# 証明書を生成する。ユーザ証明書ストア(CurrentUser\My)を一時利用し、エクスポート後に削除する
# (管理者権限は不要。LocalMachine ストアだと要管理者になる)。
$cert = New-SelfSignedCertificate `
  -Subject 'CN=editor-lan' `
  -TextExtension @($san) `
  -CertStoreLocation 'Cert:\CurrentUser\My' `
  -KeyAlgorithm RSA -KeyLength 2048 `
  -KeyExportPolicy Exportable `
  -NotAfter (Get-Date).AddYears(5)

try {
  New-Item -ItemType Directory -Force -Path $tlsDir | Out-Null

  # ランダムパスフレーズで PFX(秘密鍵入り)を書き出す。サーバ(config.ts)は隣の .pass を読む。
  $bytes = New-Object byte[] 24
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $passphrase = [Convert]::ToBase64String($bytes)
  $secure = ConvertTo-SecureString -String $passphrase -AsPlainText -Force
  Export-PfxCertificate -Cert $cert -FilePath $pfxPath -Password $secure | Out-Null
  # .pass は ASCII で BOM 無しにする(Node 側は trim して読むが余計なバイトを避ける)。
  [System.IO.File]::WriteAllText($passPath, $passphrase, [System.Text.Encoding]::ASCII)

  # クライアント配布用の公開証明書(秘密鍵なし)。
  Export-Certificate -Cert $cert -FilePath $cerPath | Out-Null
}
finally {
  # ストアに残すと再実行のたびに同名証明書が堆積するため、ファイル出力後は必ず消す。
  Remove-Item -Path $cert.PSPath -Force
}

Write-Host ''
Write-Host '生成完了:'
Write-Host "  PFX          : $pfxPath"
Write-Host "  パスフレーズ : $passPath"
Write-Host "  配布用 cer   : $cerPath"
Write-Host ''
Write-Host '次の手順:'
Write-Host '  1. editor\scripts\setup-lan-firewall.bat を管理者で 1 回実行する(受信許可)'
Write-Host '  2. editor\start.bat rest lan で起動する(HTTPS で待受ける)'
Write-Host '  3. 他端末では editor-lan.cer を「信頼されたルート証明機関」へ取り込む'
Write-Host '     (管理者コマンド例: certutil -addstore Root editor-lan.cer)'
