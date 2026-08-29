<#
.SYNOPSIS
  pie-chart 配布 exe 用のコード署名証明書を 1 回だけ作る(自己署名の縮退構成)。
.DESCRIPTION
  社内 PKI(AD CS)がある場合は本スクリプトを使わず、そちらから発行すること。
  企業ルートの下で発行できれば配布先での「信頼されたルート証明機関」への追加登録が不要になり、
  「1 台の PC が持つ鍵が全端末の信頼アンカーになる」構造そのものが消える。

  本スクリプトは PKI が無い前提の縮退案で、次の 3 点で従来の暗黙生成と異なる:
    - 秘密鍵をエクスポート不可(NonExportable)にする。持ち出せない鍵にする
    - 有効期間を 1 年にする(従来 5 年)。タイムスタンプを付けない構成では
      期限切れ = 既配布 exe の署名が無効になるので、更新運用とセットで運用する
    - Subject に発行日を入れる。端末ごと・世代ごとに識別できるようにする
  ビルド(build-exe.mjs)はもう証明書を暗黙生成しない。作成はこの明示実行のみ。
.PARAMETER Provider
  鍵の保管先 KSP。既定は TPM(Microsoft Platform Crypto Provider)。TPM が無い端末では
  'Microsoft Software Key Storage Provider' を指定する。
.PARAMETER Years
  有効期間(年)。既定 1。長くするほど鍵漏洩時の影響期間が延びる。
.PARAMETER CertOut
  公開証明書(.cer)の書き出し先(任意)。
.NOTES
  日本語を含むため UTF-8 BOM 必須(cp932 環境での文字化け回避)。
  作成後に表示される thumbprint を scripts\signing.local.json (git 管理外) へ書くこと。
  署名鍵を置く端末では、任意コード実行を許す設定(無確認のコマンド許可・範囲無指定の
  パッケージ導入)を先に締めること。鍵が NonExportable でも、その端末で任意コードが走れば
  「鍵を使って任意ファイルへ署名させる」ことはできる。
#>
param(
  [string]$Provider = 'Microsoft Platform Crypto Provider',
  [int]$Years = 1,
  [string]$CertOut
)
$ErrorActionPreference = 'Stop'

$subject = "CN=pie-chart code signing ($(Get-Date -Format 'yyyy-MM-dd'))"
Write-Host "[new-signing-cert] 作成します: $subject (provider=$Provider, $Years 年)"

$params = @{
  Type              = 'CodeSigningCert'
  Subject           = $subject
  CertStoreLocation = 'Cert:\CurrentUser\My'
  KeyUsage          = 'DigitalSignature'
  KeyExportPolicy   = 'NonExportable'
  KeyAlgorithm      = 'RSA'
  KeyLength         = 3072
  HashAlgorithm     = 'SHA256'
  NotAfter          = (Get-Date).AddYears($Years)
  Provider          = $Provider
}
try {
  $cert = New-SelfSignedCertificate @params
} catch {
  Write-Error ("[new-signing-cert] 作成に失敗しました: $($_.Exception.Message)`n" +
    "TPM が無い端末では -Provider 'Microsoft Software Key Storage Provider' を指定してください。")
  exit 1
}

Write-Host ''
Write-Host "[new-signing-cert] 作成しました"
Write-Host "  Subject    : $($cert.Subject)"
Write-Host "  Thumbprint : $($cert.Thumbprint)"
Write-Host "  NotAfter   : $($cert.NotAfter.ToString('yyyy-MM-dd'))"

if ($CertOut) {
  Export-Certificate -Cert $cert -FilePath $CertOut -Force | Out-Null
  Write-Host "  Cer        : $CertOut"
}

Write-Host ''
Write-Host '次にやること:'
Write-Host '  1. 上の Thumbprint を pie-chart\scripts\signing.local.json へ書く(git 管理外):'
Write-Host ("       { `"thumbprint`": `"$($cert.Thumbprint)`" }")
Write-Host '  2. 旧証明書がある場合は、配布物を入れ替えたうえで撤去する'
Write-Host '       (配布先ストアから削除 -> 必要なら Disallowed へ登録 -> ビルド端末で'
Write-Host '        Remove-Item Cert:\CurrentUser\My\<旧thumbprint> -DeleteKey)'
Write-Host "  3. 期限 $($cert.NotAfter.ToString('yyyy-MM-dd')) の 1 か月前に再発行・再署名・再配布する"
