<#
.SYNOPSIS
  pie-chart.exe を自己署名(self-signed コード署名)で署名する。
.DESCRIPTION
  CurrentUser\My に専用の自己署名コード署名証明書が無ければ作成し、Set-AuthenticodeSignature で
  exe に SHA256 署名する。公開証明書(.cer)も書き出し、配布先で「信頼されたルート証明機関」と
  「信頼された発行元」へ取り込めば署名が Valid 扱いになり SmartScreen / Defender の警告も抑えられる。
  オフライン前提のためタイムスタンプ署名は行わない(証明書の有効期限まで有効)。
.PARAMETER ExePath
  署名対象の exe パス。
.PARAMETER CertOut
  書き出す公開証明書(.cer)のパス(任意)。
.NOTES
  日本語を含むため UTF-8 BOM 必須(cp932 環境での文字化け回避)。CurrentUser ストアのため
  管理者権限は不要。配布先での信頼登録(Trusted Root / Trusted Publishers への import)のみ
  管理者権限が要る。
#>
param(
  [Parameter(Mandatory = $true)][string]$ExePath,
  [string]$CertOut
)
$ErrorActionPreference = 'Stop'

# Code Signing の拡張キー使用法 OID(FriendlyName はロケール依存なので OID で判定する)。
$codeSigningOid = '1.3.6.1.5.5.7.3.3'
$subject = 'CN=pie-chart self-signed code signing'

$cert = Get-ChildItem Cert:\CurrentUser\My | Where-Object {
  $_.Subject -eq $subject -and $_.HasPrivateKey -and
  ($_.EnhancedKeyUsageList | Where-Object { $_.ObjectId -eq $codeSigningOid })
} | Select-Object -First 1

if (-not $cert) {
  Write-Host "[sign-exe] 自己署名証明書を新規作成します ($subject)"
  $cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject $subject `
    -CertStoreLocation Cert:\CurrentUser\My -KeyUsage DigitalSignature `
    -KeyExportPolicy Exportable -HashAlgorithm SHA256 -NotAfter (Get-Date).AddYears(5)
}

$result = Set-AuthenticodeSignature -FilePath $ExePath -Certificate $cert -HashAlgorithm SHA256
Write-Host "[sign-exe] 署名: $($result.Status) -> $ExePath (thumbprint $($cert.Thumbprint))"
# 自己署名はルート未信頼のため、配布先で取り込むまで Status は UnknownError(=署名済みだが未信頼)。
# 署名そのものは付与されている("デジタル署名"タブに表示される)。

if ($CertOut) {
  Export-Certificate -Cert $cert -FilePath $CertOut -Force | Out-Null
  Write-Host "[sign-exe] 公開証明書を書き出し: $CertOut"
}
