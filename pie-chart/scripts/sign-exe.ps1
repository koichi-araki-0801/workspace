<#
.SYNOPSIS
  pie-chart.exe をコード署名する(署名鍵は thumbprint で明示指定する)。
.DESCRIPTION
  CurrentUser\My / LocalMachine\My から -Thumbprint に一致するコード署名証明書を探し、
  Set-AuthenticodeSignature で exe に SHA256 署名する。公開証明書(.cer)も書き出す。

  証明書を**その場で作らない**のが本スクリプトの要点である。以前は「無ければ作る」実装
  だったため、ビルドした端末の数だけ同一 Subject の別々のルート証明書ができ、「どの .cer を
  配ったか」が追跡不能になっていた。鍵の作成は scripts/new-signing-cert.ps1 の明示実行に
  一本化し、ここでは既存鍵の利用だけを行う。

  署名の役割は「配布物の完全性検証」ではない。完全性は exe への全同梱(SEA アセット)で
  構造的に担保されており(scripts/build-exe.mjs)、Authenticode は発行元表示と
  AppLocker / WDAC の発行者ルールのための補助である。
.PARAMETER ExePath
  署名対象の exe パス。
.PARAMETER Thumbprint
  使用する証明書の thumbprint。未指定なら環境変数 PIECHART_SIGN_THUMBPRINT を見る。
  どちらも無ければ非ゼロ終了する(黙って未署名の配布物を作らないため)。
.PARAMETER CertOut
  書き出す公開証明書(.cer)のパス(任意)。
.PARAMETER TimestampServer
  RFC3161 タイムスタンプサーバ URL(任意)。指定しない場合、証明書の有効期限が切れると
  既配布 exe の署名も無効になる。オフライン署名端末では指定できない。
.NOTES
  日本語を含むため UTF-8 BOM 必須(cp932 環境での文字化け回避)。CurrentUser ストアのため
  管理者権限は不要。標準出力の `SIGN-INFO key=value` 行は build-exe.mjs が
  dist-exe/SIGNING-INFO.txt へ写す(どの鍵で署名した配布物かの追跡用)。
#>
param(
  [Parameter(Mandatory = $true)][string]$ExePath,
  [string]$Thumbprint,
  [string]$CertOut,
  [string]$TimestampServer
)
$ErrorActionPreference = 'Stop'

if (-not $Thumbprint) { $Thumbprint = $env:PIECHART_SIGN_THUMBPRINT }
if (-not $Thumbprint) {
  Write-Error @'
[sign-exe] 署名鍵の thumbprint が指定されていません。
  1. scripts\new-signing-cert.bat を 1 回だけ実行して鍵を作る
  2. 表示された thumbprint を scripts\signing.local.json (git 管理外) へ書くか、
     環境変数 PIECHART_SIGN_THUMBPRINT に設定する
'@
  exit 1
}

# 大小文字・空白のゆれを吸収する(certutil や証明書 UI からの貼り付けを想定)。
$normalized = ($Thumbprint -replace '[^0-9A-Fa-f]', '').ToUpperInvariant()

# Code Signing の拡張キー使用法 OID(FriendlyName はロケール依存なので OID で判定する)。
$codeSigningOid = '1.3.6.1.5.5.7.3.3'

$cert = @('Cert:\CurrentUser\My', 'Cert:\LocalMachine\My') | ForEach-Object {
  if (Test-Path $_) { Get-ChildItem $_ -ErrorAction SilentlyContinue }
} | Where-Object {
  $_.Thumbprint -eq $normalized -and $_.HasPrivateKey -and
  ($_.EnhancedKeyUsageList | Where-Object { $_.ObjectId -eq $codeSigningOid })
} | Select-Object -First 1

if (-not $cert) {
  Write-Error ("[sign-exe] thumbprint $normalized のコード署名証明書(秘密鍵つき)が " +
    'CurrentUser\My / LocalMachine\My に見つかりません。scripts\new-signing-cert.bat で ' +
    '作成するか、正しい thumbprint を指定してください。')
  exit 1
}

if ($cert.NotAfter -lt (Get-Date)) {
  Write-Error "[sign-exe] 証明書は $($cert.NotAfter) に失効しています。新しい鍵を作成してください。"
  exit 1
}

$signArgs = @{
  FilePath      = $ExePath
  Certificate   = $cert
  HashAlgorithm = 'SHA256'
}
if ($TimestampServer) { $signArgs['TimestampServer'] = $TimestampServer }
$null = Set-AuthenticodeSignature @signArgs

# 署名の成否は Set-AuthenticodeSignature の戻り値ではなく**署名後の実ファイル**で判定する。
# 自己署名はルート未信頼の端末で Status=UnknownError(署名は正しく付いているが信頼されて
# いない)になるため、この 2 値だけを成功とみなす。HashMismatch / NotSigned を混ぜると
# 署名検証が実質無効化されるので、判定は列挙 2 値の完全一致で書く。
$verified = Get-AuthenticodeSignature -FilePath $ExePath
$okStatuses = @('Valid', 'UnknownError')
if ($okStatuses -notcontains $verified.Status.ToString()) {
  Write-Error "[sign-exe] 署名に失敗しました: Status=$($verified.Status) ($ExePath)"
  exit 1
}
if ($verified.SignerCertificate.Thumbprint -ne $normalized) {
  Write-Error ('[sign-exe] 署名後の証明書 thumbprint が一致しません: ' +
    "$($verified.SignerCertificate.Thumbprint) != $normalized")
  exit 1
}

Write-Host "[sign-exe] 署名: $($verified.Status) -> $ExePath"
Write-Host "SIGN-INFO thumbprint=$normalized"
Write-Host "SIGN-INFO subject=$($cert.Subject)"
Write-Host "SIGN-INFO notAfter=$($cert.NotAfter.ToString('o'))"
Write-Host "SIGN-INFO status=$($verified.Status)"
Write-Host ("SIGN-INFO timestamp=" + $(if ($TimestampServer) { $TimestampServer } else { 'none' }))
if (-not $TimestampServer) {
  Write-Host ('[sign-exe] 注意: タイムスタンプ無しのため、証明書の有効期限 ' +
    "$($cert.NotAfter.ToString('yyyy-MM-dd')) を過ぎると既配布 exe の署名も無効になります。")
}

if ($CertOut) {
  Export-Certificate -Cert $cert -FilePath $CertOut -Force | Out-Null
  Write-Host "[sign-exe] 公開証明書を書き出し: $CertOut"
}
