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

# 出力先がネットワーク上 (UNC / ネットワークにマップしたドライブ) なら拒否する。
# 「PFX(秘密鍵) と平文パスフレーズの併置」という割り切り (.DESCRIPTION 2.) は、出力先が
# サーバ機のローカルディスクでその機の利用者しか読めないことを前提に成立している。
# 共有フォルダへ置くと、共有の読み取り権を持つ全員が TLS 秘密鍵を持ち出せる。
function Test-NetworkPath([string]$path) {
  if ($path -like '\\*') { return $true }
  try {
    $root = [System.IO.Path]::GetPathRoot([System.IO.Path]::GetFullPath($path))
    $drive = New-Object System.IO.DriveInfo($root)
    return $drive.DriveType -eq [System.IO.DriveType]::Network
  } catch {
    # 判定不能はローカル扱いへ倒す(offline/lib/verify.ps1 の同名判断と同じ)。
    return $false
  }
}
if (Test-NetworkPath $tlsDir) {
  Write-Host "[NG] 出力先がネットワークドライブ上です: $tlsDir"
  Write-Host '     PFX(秘密鍵) と平文パスフレーズを共有フォルダへ置くことになるため生成を中止しました。'
  Write-Host '     editor はサーバ機のローカルディスクに配置し、そこで本スクリプトを実行してください。'
  exit 1
}

if ((Test-Path $pfxPath) -and -not $Force) {
  Write-Host "既に $pfxPath が存在します。作り直す場合は -Force を付けて再実行してください。"
  exit 1
}

# SAN を組み立てる。IP 直打ちでの利用が主のため、LAN の IPv4 のうち RFC1918 プライベート範囲
# (10.0.0.0/8・172.16.0.0/12・192.168.0.0/16) に一致するものだけを ipaddress エントリで
# 含める。VPN 仮想アダプタやグローバル IP まで含めると、その IP が SAN に焼き込まれた cer を
# クライアントの信頼ルートへ登録する運用と噛み合わない。判定はオクテットの数値比較で行う
# (-like '172.16.*' の文字列前方一致は 172.160.x.x を誤って許可するため使わない)。
function Test-PrivateIPv4([string]$ipText) {
  try {
    $addr = [System.Net.IPAddress]::Parse($ipText)
    if ($addr.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork) { return $false }
    $o = $addr.GetAddressBytes()
    if ($o[0] -eq 10) { return $true }
    if ($o[0] -eq 172 -and $o[1] -ge 16 -and $o[1] -le 31) { return $true }
    if ($o[0] -eq 192 -and $o[1] -eq 168) { return $true }
    return $false
  } catch {
    # 判定不能な値は SAN へ含めない(許可リストの外へ倒す)。
    return $false
  }
}

$ips = @(Get-NetIPAddress -AddressFamily IPv4 |
    Select-Object -ExpandProperty IPAddress |
    Where-Object { Test-PrivateIPv4 $_ })

if ($ips.Count -eq 0) {
  Write-Host '[NOTICE] LAN のプライベート IPv4 (RFC1918) が見つかりませんでした。SAN はホスト名のみで発行します。'
}
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
