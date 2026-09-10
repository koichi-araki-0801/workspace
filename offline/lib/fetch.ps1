# 共通ライブラリ: GitHub Releases からのオフライン重量物バンドルの取得。
# fetch-offline-bundle.ps1 から dot-source して使う（`verify.ps1` と同じ運用）。
# 日本語コメントを含むため UTF-8 BOM 必須（cp932 環境で文字化けさせない）。
#
# 設計方針: 取得は一時ディレクトリで行い、Release の .sha256 と突き合わせた検証が通った
# ものだけを配置先へ移す。検証前・失敗した取得物を配置先に残さない — 残すと次回の setup が
# 「手元のバンドルを使う」経路で .sha256 検証を経ないままそれを使ってしまう。

# ── 1 ファイルのダウンロード ──
# curl.exe があればストリーミング DL、無ければ Invoke-WebRequest（PS5.1 の進捗描画は
# 大容量で極端に遅いため抑止する）。
function Invoke-ReleaseDownload {
  param(
    [Parameter(Mandatory = $true)][string]$Url,
    [Parameter(Mandatory = $true)][string]$Destination
  )
  Write-Host "       <- $Url"
  $curl = Get-Command 'curl.exe' -ErrorAction SilentlyContinue
  if ($curl) {
    & $curl.Source -L --fail --retry 3 -o $Destination $Url
    if ($LASTEXITCODE -ne 0) { throw "ダウンロードに失敗: $Url" }
  } else {
    $old = $ProgressPreference
    $ProgressPreference = 'SilentlyContinue'
    try { Invoke-WebRequest -Uri $Url -OutFile $Destination -UseBasicParsing }
    finally { $ProgressPreference = $old }
  }
}

# ── 取得 → 検証 → 配置 ──
# AssetBase 直下の 3 アセット（バンドル / .sha256 / bundle.key）を一時ディレクトリへ取得し、
# .sha256 の検証が通ったときだけ Destination へ移す。戻り値は配置後のパス。
# `Downloader` は (url, dest) を受けるスクリプトブロックで、テストからは実ネットワークを
# 使わない写し取りに差し替える。
# .sha256 は配信元と同じ場所の値なので転送破損の検知にしか使えない（すり替えの検知は
# しない）。前提は `README-offline.txt` の「前提と受け入れているリスク」を参照。
function Save-VerifiedReleaseBundle {
  param(
    [Parameter(Mandatory = $true)][string]$AssetBase,
    [Parameter(Mandatory = $true)][string]$BundleName,
    [Parameter(Mandatory = $true)][string]$Destination,
    [scriptblock]$Downloader = ${function:Invoke-ReleaseDownload},
    [switch]$IncludeSource
  )
  $work     = Join-Path ([IO.Path]::GetTempPath()) ('offline-fetch-' + [Guid]::NewGuid().ToString('N'))
  $workFile = Join-Path $work $BundleName
  $workSha  = "$workFile.sha256"
  $workKey  = Join-Path $work 'bundle.key'
  New-Item -ItemType Directory -Path $work -Force | Out-Null
  try {
    & $Downloader "$AssetBase/$BundleName"        $workFile
    & $Downloader "$AssetBase/$BundleName.sha256" $workSha
    & $Downloader "$AssetBase/bundle.key"         $workKey
    $expected = Get-Sha256FromSidecar -Path $workSha
    Assert-FileSha256 -File $workFile -ExpectedSha256 $expected -Label 'bundle'

    # ソースは重量物と同じ一時ディレクトリで揃え、両方の照合が通ってから一括で移す —
    # 片方だけ直下に置くと、次回の setup が「手元の組」として検証無しに使ってしまう。
    $workSrc = Join-Path $work 'source.zip'
    if ($IncludeSource) {
      & $Downloader "$AssetBase/source.zip"        $workSrc
      & $Downloader "$AssetBase/source.zip.sha256" "$workSrc.sha256"
      $srcExpected = Get-Sha256FromSidecar -Path "$workSrc.sha256"
      Assert-FileSha256 -File $workSrc -ExpectedSha256 $srcExpected -Label 'source.zip'
    }

    New-Item -ItemType Directory -Path $Destination -Force | Out-Null
    $bundle = Join-Path $Destination $BundleName
    $key    = Join-Path $Destination 'bundle.key'
    Move-Item -LiteralPath $workFile -Destination $bundle          -Force
    Move-Item -LiteralPath $workSha  -Destination "$bundle.sha256" -Force
    Move-Item -LiteralPath $workKey  -Destination $key             -Force
    $source = $null
    if ($IncludeSource) {
      $source = Join-Path $Destination 'source.zip'
      Move-Item -LiteralPath $workSrc          -Destination $source          -Force
      Move-Item -LiteralPath "$workSrc.sha256" -Destination "$source.sha256" -Force
    }
    return @{ Bundle = $bundle; Key = $key; Source = $source }
  } finally {
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
  }
}
