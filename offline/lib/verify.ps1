# 共通ライブラリ: offline 配布物の完全性・真正性検証（署名 / ハッシュ / 入力の許可リスト）。
# publish / setup / setup-local から dot-source して使う（`content-key.ps1` と同じ運用）。
# 日本語コメントを含むため UTF-8 BOM 必須（cp932 環境で文字化けさせない）。
#
# 設計方針（セキュリティ所見 F14/F19/F20 対応）:
#   - 「配信元（GitHub Releases）から取る digest」に真正性を期待しない。バンドルを差し替え
#     られる攻撃者は対応する .sha256 も並べて置けるため、あの sidecar は転送破損の検知にしか
#     ならない。真正性の根拠は (a) 手渡しで運ばれる offline/ 同梱の pinned 値と、(b) offline/
#     同梱の公開鍵で検証する分離署名、の 2 つに置く。
#   - 検証に失敗したら止まる（fail closed）。「無ければスキップ」はここでは提供しない。

# ── テキスト台帳の読み取り（UTF-8 固定） ──
# `Get-Content` を素で使ってはならない: Windows PowerShell 5.1 の既定エンコーディングは
# ANSI（日本語環境では cp932）で、UTF-8 の日本語コメントを cp932 として解釈すると 2 バイト
# 文字の先行バイトが直後の LF を trail バイトとして食い、**行が丸ごと消える**。
# 実測: git-tools\manifest.txt（先頭 3 行が日本語コメント）が 5 行 → 3 行になり、
# PortableGit のエントリが消えて「台帳に無いので検証しない」＝ガードが黙って無効化された。
# 検証に使う台帳は必ずこのヘルパ経由で読む。
function Read-Utf8Lines {
  param([Parameter(Mandatory = $true)][string]$Path)
  $text = [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8)
  , @($text -split "`r?`n")
}

# ── requirements.txt の許可リスト検査 ──
# pip は requirements ファイル内のオプション行（`--extra-index-url` / `--find-links` /
# `-e` 等）と直 URL 参照（`pkg @ https://...`）を尊重するため、requirements の編集 1 つで
# 解決先そのものを攻撃者のインデックスへ差し替えられる。純粋な requirement specifier 以外を
# 一切拒否する（許可リスト方式。危険オプションの列挙＝ブロックリストにはしない）。
# 戻り値: 違反の説明文字列の配列（空なら合格）。
function Test-OfflineRequirementsFile {
  param([Parameter(Mandatory = $true)][string]$Path)
  $violations = @()
  $lineNo = 0
  foreach ($line in (Read-Utf8Lines -Path $Path)) {
    $lineNo++
    $t = $line.Trim()
    if ($t.Length -eq 0 -or $t.StartsWith('#')) { continue }
    if ($t.StartsWith('-')) {
      $violations += "${Path}:${lineNo}: オプション行は許可しない: $t"
      continue
    }
    if ($t -match '://') {
      $violations += "${Path}:${lineNo}: 直 URL 参照は許可しない: $t"
    }
  }
  , @($violations)
}

# ── git-tools/manifest.txt のパーサ ──
# 台帳形式は「<名前> <版> <ファイル名> <sha256>」の空白区切り 1 行 1 エントリ（`#` 行と
# 空行は無視）。実行するバイナリは**この台帳の正確なファイル名で選び**、実行前に sha256 を
# 突き合わせる（ワイルドカード選択だと git-tools/ へ置かれた任意の同名パターンのファイルを
# 拾ってしまう。git-tools/ は gitignore 対象で diff に現れない＝無レビュー実行になる）。
function Get-GitToolsManifestEntries {
  param([Parameter(Mandatory = $true)][string]$ManifestPath)
  $entries = @()
  foreach ($line in (Read-Utf8Lines -Path $ManifestPath)) {
    $t = $line.Trim()
    if ($t.Length -eq 0 -or $t.StartsWith('#')) { continue }
    $parts = $t -split '\s+'
    if ($parts.Count -lt 4) { continue }
    $entries += [pscustomobject]@{
      Name     = $parts[0]
      Version  = $parts[1]
      FileName = $parts[2]
      Sha256   = $parts[3].ToLower()
    }
  }
  , @($entries)
}

# 台帳エントリに対応する実ファイルを検証して返す。無い/不一致は throw（fail closed）。
function Resolve-VerifiedManifestFile {
  param(
    [Parameter(Mandatory = $true)][string]$Directory,
    [Parameter(Mandatory = $true)]$Entry
  )
  $path = Join-Path $Directory $Entry.FileName
  if (-not (Test-Path -LiteralPath $path)) {
    throw "manifest 記載のファイルがありません: $($Entry.FileName)（$Directory）"
  }
  $actual = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLower()
  if ($actual -ne $Entry.Sha256) {
    throw ("sha256 不一致: $($Entry.FileName)`n  manifest: $($Entry.Sha256)`n  actual:   $actual" +
      "`n  git-tools/ は git 管理外のため、この不一致は改ざん・すり替えの兆候として扱う。")
  }
  $path
}

# ── pinned commit id の形式検証 ──
# ソースの取得先はローリングタグでなく不変のコミット ID へ pin する。タグ名（例:
# offline-bundle-v1）は publish のたびに指す先が動くため、「タグで取れた」ことは内容を
# 何も同定しない。40 桁 16 進の完全 SHA-1 のみを受け付ける。
function Test-PinnedCommitId {
  param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$CommitId)
  $CommitId -match '^[0-9a-f]{40}$'
}

# ── pin ファイル（offline/pinned-release.txt）の読み取り ──
# offline/ フォルダは手渡しで air-gapped 機へ運ばれる。ここに置いた期待値だけが「配信元と
# 独立した」真正性の根拠になるため、公開時に publish が書き出し、リポジトリへコミットして
# offline/ ごと持ち運ぶ。形式は `<キー> <値>` の空白区切り 1 行 1 エントリ:
#   source-commit      <40 桁 16 進>  取得するソースの不変コミット ID
#   source-zip-sha256  <64 桁 16 進>  そのコミットの archive zip の SHA-256
#   bundle-sha256      <64 桁 16 進>  重量物バンドルの SHA-256
# 3 キーすべてが揃い形式が正しいことを要求する（欠けたら throw = fail closed）。
function Get-OfflinePin {
  param([Parameter(Mandatory = $true)][string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) {
    throw ("pin ファイルがありません: $Path`n" +
      '  offline/ 同梱の期待値が無いと、取得物の真正性を配信元と独立に確かめられない。' +
      '公開側で publish-offline-bundle.ps1 を実行し、生成された pin ファイルごと offline/ を運ぶこと。')
  }
  $map = @{}
  foreach ($line in (Read-Utf8Lines -Path $Path)) {
    $t = $line.Trim()
    if ($t.Length -eq 0 -or $t.StartsWith('#')) { continue }
    $parts = $t -split '\s+', 2
    if ($parts.Count -lt 2) { continue }
    $map[$parts[0].ToLower()] = $parts[1].Trim().ToLower()
  }
  foreach ($k in @('source-commit', 'source-zip-sha256', 'bundle-sha256')) {
    if (-not $map.ContainsKey($k)) { throw "pin ファイルに $k がありません: $Path" }
  }
  if (-not (Test-PinnedCommitId $map['source-commit'])) {
    throw "pin ファイルの source-commit が 40 桁 16 進ではありません: $($map['source-commit'])"
  }
  foreach ($k in @('source-zip-sha256', 'bundle-sha256')) {
    if ($map[$k] -notmatch '^[0-9a-f]{64}$') {
      throw "pin ファイルの $k が 64 桁 16 進ではありません: $($map[$k])"
    }
  }
  [pscustomobject]@{
    SourceCommit    = $map['source-commit']
    SourceZipSha256 = $map['source-zip-sha256']
    BundleSha256    = $map['bundle-sha256']
  }
}

# ── RSA 分離署名（RSA-SHA256 / PKCS#1 v1.5、鍵は RSA XML 形式） ──
# 鍵を XML 形式にするのは Windows PowerShell 5.1（.NET Framework）に PEM インポートが
# 無いため（`FromXmlString` は 5.1 / PowerShell 7 の双方で動く）。署名は base64 テキストの
# 分離ファイル（<bundle>.sig）として配布物に添える。

# 3072bit RSA 鍵ペアを生成し、XML 文字列 2 つ（private / public）を返す。
function New-OfflineSigningKeyPair {
  $rsa = New-Object System.Security.Cryptography.RSACryptoServiceProvider 3072
  try {
    [pscustomobject]@{
      PrivateXml = $rsa.ToXmlString($true)
      PublicXml  = $rsa.ToXmlString($false)
    }
  } finally { $rsa.Dispose() }
}

# ファイルの分離署名（base64）を作る。巨大ファイル（~1.2GB）のためストリームで署名する。
function New-DetachedSignatureBase64 {
  param(
    [Parameter(Mandatory = $true)][string]$File,
    [Parameter(Mandatory = $true)][string]$PrivateKeyXml
  )
  $rsa = New-Object System.Security.Cryptography.RSACryptoServiceProvider
  try {
    $rsa.FromXmlString($PrivateKeyXml)
    $fs = [System.IO.File]::OpenRead($File)
    try {
      $sig = $rsa.SignData($fs, [System.Security.Cryptography.HashAlgorithmName]::SHA256,
        [System.Security.Cryptography.RSASignaturePadding]::Pkcs1)
    } finally { $fs.Dispose() }
    [Convert]::ToBase64String($sig)
  } finally { $rsa.Dispose() }
}

# ファイルの分離署名（base64）を公開鍵で検証する。真なら合格。
# 署名・鍵の形式不正（base64 でない等）も「検証失敗」に倒す（fail closed）。
function Test-DetachedSignature {
  param(
    [Parameter(Mandatory = $true)][string]$File,
    [Parameter(Mandatory = $true)][string]$SignatureBase64,
    [Parameter(Mandatory = $true)][string]$PublicKeyXml
  )
  try {
    $sig = [Convert]::FromBase64String($SignatureBase64.Trim())
    $rsa = New-Object System.Security.Cryptography.RSACryptoServiceProvider
    try {
      $rsa.FromXmlString($PublicKeyXml)
      $fs = [System.IO.File]::OpenRead($File)
      try {
        $rsa.VerifyData($fs, $sig, [System.Security.Cryptography.HashAlgorithmName]::SHA256,
          [System.Security.Cryptography.RSASignaturePadding]::Pkcs1)
      } finally { $fs.Dispose() }
    } finally { $rsa.Dispose() }
  } catch {
    $false
  }
}

# ── 分離署名の検証を「必ず通す」入口 ──
# 呼び出し側が「鍵が無ければスキップ」「.sig が無ければ警告」と書けないよう、公開鍵・署名の
# 欠落も含めて全部 throw に倒した薄いラッパを用意する。setup 系はこれだけを呼ぶ。
function Assert-BundleSignature {
  param(
    [Parameter(Mandatory = $true)][string]$File,
    [Parameter(Mandatory = $true)][string]$SignaturePath,
    [Parameter(Mandatory = $true)][string]$PublicKeyPath
  )
  if (-not (Test-Path -LiteralPath $PublicKeyPath)) {
    throw ("署名検証用の公開鍵がありません: $PublicKeyPath`n" +
      '  公開側で offline\new-bundle-signing-key.bat を 1 回実行し、生成された公開鍵を' +
      ' offline/ へコミットしてから再公開すること。')
  }
  if (-not (Test-Path -LiteralPath $SignaturePath)) {
    throw ("分離署名がありません: $SignaturePath`n" +
      '  署名の無い重量物は受け入れない（配信元の .sha256 は転送破損の検知にしかならず、' +
      'すり替えの検知にはならない）。')
  }
  $pub = Get-Content -LiteralPath $PublicKeyPath -Raw
  $sig = Get-Content -LiteralPath $SignaturePath -Raw
  if (-not (Test-DetachedSignature -File $File -SignatureBase64 $sig -PublicKeyXml $pub)) {
    throw ("分離署名の検証に失敗: $File`n" +
      '  改ざん・すり替え、または公開鍵と署名鍵の不一致。処理を中止する。')
  }
}

# ── リポジトリ直下が「ローカルディスク」であることの検査 ──
# pnpm の isolated linker は node_modules を symlink + store への hardlink で組む。
# ネットワークドライブ (UNC / ネットワークにマップしたドライブレター) 上では、SMB
# クライアント既定がリモート symlink を評価しない (`fsutil behavior` の SymlinkEvaluation)
# うえ hardlink も拒否されるため、install が「成功したように見えて実行時に
# Cannot find module で全滅」か途中失敗になる。黙って壊れた環境を作らないよう、setup 系は
# 開始前にここで止める (fail fast)。これは利便のガードであって権限境界ではないので、
# 判定不能はローカル扱いへ倒す。
function Assert-LocalRepoRoot {
  param([Parameter(Mandatory = $true)][string]$Path)
  $isNetwork = $false
  if ($Path -like '\\*') {
    $isNetwork = $true
  } else {
    try {
      $root = [System.IO.Path]::GetPathRoot([System.IO.Path]::GetFullPath($Path))
      $drive = New-Object System.IO.DriveInfo($root)
      $isNetwork = ($drive.DriveType -eq [System.IO.DriveType]::Network)
    } catch {
      $isNetwork = $false
    }
  }
  if ($isNetwork) {
    throw ("リポジトリがネットワークドライブ上にあります: $Path`n" +
      '  pnpm の node_modules (symlink + hardlink) は SMB 上で成立しないため、この構成は' +
      "サポートしない。`n  リポジトリをローカルディスクへ置いて実行し、共有へは成果物" +
      '(exe / docs HTML / バンドル) だけをコピーすること。')
  }
}

# ── ハッシュを「必ず突き合わせる」入口 ──
# 期待値は offline/ 同梱の pin から渡すこと（配信元から取った .sha256 を渡さない）。
function Assert-FileSha256 {
  param(
    [Parameter(Mandatory = $true)][string]$File,
    [Parameter(Mandatory = $true)][string]$ExpectedSha256,
    [Parameter(Mandatory = $true)][string]$Label
  )
  $actual = (Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLower()
  if ($actual -ne $ExpectedSha256.ToLower()) {
    throw ("$Label の sha256 が pin と一致しません。`n  expected(pin): $($ExpectedSha256.ToLower())" +
      "`n  actual:        $actual`n  取得物が期待したリリースのものでない。処理を中止する。")
  }
  Write-Host "[info] sha256 OK ($Label): $actual"
}
