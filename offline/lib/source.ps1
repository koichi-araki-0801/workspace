# 共通ライブラリ: ソース ZIP の展開段（遮断端末の setup-offline.ps1 が dot-source する）。
# 日本語コメントを含むため UTF-8 BOM 必須（cp932 環境で文字化けさせない）。
#
# 設計方針: 展開の前に「前回の名簿（MANIFEST）に載るファイル」を消す。ZIP を上書き展開するだけ
# だと、前の版で削除・改名されたファイルが残り、`biome ci .` などが残留物まで検査してしまう。
# 名簿はリポジトリ直下からの相対パスとしてだけ解釈し、外へ出うる行が 1 つでもあれば
# 何も消さずに止める（名簿を細工されてもリポジトリの外を消さない）。git 管理外の置き場
# （bk\ / appconfig.json / node_modules 等）は名簿に載らないので残る。

# ── 名簿の検査 ──
function Assert-ManifestPathsSafe {
  # 空行は無視する仕様のため、配列要素の空文字列を PowerShell の Mandatory 既定検証
  # （空文字列を自動で拒否する）から明示的に外す（AllowEmptyCollection は配列自体が
  # 空の場合だけを許し、要素の空文字列までは許さない）。
  param(
    [Parameter(Mandatory = $true)][AllowEmptyCollection()][AllowEmptyString()][string[]]$Lines
  )
  foreach ($raw in $Lines) {
    $line = $raw.Trim()
    if ($line -eq '') { continue }
    $bad = ($line -match '^[A-Za-z]:') -or ($line -match '^[\\/]') -or
      (($line -split '[\\/]') -contains '..')
    if ($bad) { throw "MANIFEST に不正なパスがあります（相対パスのみ許可）: $line" }
  }
}

# ── 名簿に載るファイルの削除 ──
# 存在しない行は無視する（前回の版に在ったが既に手で消された等）。空になったフォルダは
# 消さない（git 管理外の置き場を巻き込まない）。戻り値は削除した件数。
function Remove-ManifestFiles {
  param(
    [Parameter(Mandatory = $true)][string]$RepoRoot,
    [Parameter(Mandatory = $true)][string]$ManifestPath
  )
  $lines = Read-Utf8Lines -Path $ManifestPath
  Assert-ManifestPathsSafe -Lines $lines
  $removed = 0
  foreach ($raw in $lines) {
    $rel = $raw.Trim()
    if ($rel -eq '') { continue }
    $full = Join-Path $RepoRoot ($rel -replace '/', '\')
    if (Test-Path -LiteralPath $full -PathType Leaf) {
      Remove-Item -LiteralPath $full -Force
      $removed++
    }
  }
  return $removed
}

# ── SOURCE-COMMIT の読み取り ──
function Read-SourceCommit {
  param([Parameter(Mandatory = $true)][string]$RepoRoot)
  $p = Join-Path $RepoRoot 'SOURCE-COMMIT'
  if (-not (Test-Path -LiteralPath $p)) { return $null }
  ([System.IO.File]::ReadAllText($p, [System.Text.Encoding]::UTF8)).Trim()
}

# ── 展開段 ──
# 直下の source.zip を .sha256 で照合し、旧 MANIFEST の名簿を消してから直下へ展開し、
# ZIP と .sha256 を bk\ へ退避する。照合に失敗したら削除も展開も行わない（直下を汚さない）。
# 旧 MANIFEST が無いときは初回扱い（削除は行わず警告だけ出して展開する）。
function Invoke-SourceExtractStage {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string]$RepoRoot,
    [Parameter(Mandatory = $true)][string]$Bk,
    [string]$ZipName = 'source.zip',
    [string]$ManifestName = 'MANIFEST'
  )
  $zip = Join-Path $RepoRoot $ZipName
  $sha = "$zip.sha256"
  $expected = Get-Sha256FromSidecar -Path $sha
  Assert-FileSha256 -File $zip -ExpectedSha256 $expected -Label 'source.zip'

  $manifest = Join-Path $RepoRoot $ManifestName
  $firstRun = -not (Test-Path -LiteralPath $manifest)
  $removed = 0
  if ($firstRun) {
    Write-Warning "$ManifestName が無いため初回扱いにします（前の版のファイルは消しません）。"
  } else {
    $removed = Remove-ManifestFiles -RepoRoot $RepoRoot -ManifestPath $manifest
    Write-Host "[info] 前の版のファイルを $removed 件削除しました。"
  }

  Expand-Archive -LiteralPath $zip -DestinationPath $RepoRoot -Force

  New-Item -ItemType Directory -Path $Bk -Force | Out-Null
  Move-Item -LiteralPath $zip -Destination (Join-Path $Bk $ZipName) -Force
  Move-Item -LiteralPath $sha -Destination (Join-Path $Bk "$ZipName.sha256") -Force
  return @{ Removed = $removed; FirstRun = $firstRun }
}
