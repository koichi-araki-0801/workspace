# 共通ライブラリ: offline 配布物の入力検査（requirements 許可リスト / manifest 照合 / sha256）。
# publish / setup / setup-local から dot-source して使う（`content-key.ps1` と同じ運用）。
# 日本語コメントを含むため UTF-8 BOM 必須（cp932 環境で文字化けさせない）。
#
# 設計方針: 入力（requirements / manifest）は許可リストで受け、検証に失敗したら止まる
# （fail closed）。「無ければスキップ」はここでは提供しない。

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
# `-e` 等）・直 URL 参照（`pkg @ https://...`）・**ベアなローカルパス**
# （`./downloads/numpy-1.9.2-cp34-none-win32.whl` は pip 公式ドキュメントに載る正式な形）を
# すべて requirement として受け取る。編集 1 行で解決先そのものを差し替えられるため、
# ここは**受け入れる形だけを書く**（危険物の列挙にしない）。
#
# 拒否条件を並べる方式は、書いた本人が思いつかなかった形を必ず通す。実際、先頭ハイフンと
# `://` を含む行だけを弾く実装だったとき、リポジトリへコミットした wheel への相対パスが
# 素通りし、それが `pip download` で wheelhouse へ入り、公開担当者の鍵で署名されて
# 正規バンドルになる経路が開いていた（setup 側の pin 照合・署名検証は「publish が固めた
# ものと同一か」しか見ないので、入口が緩いと全部素通りする）。
#
# 受け入れるのは「名前 + 省略可能なバージョン指定子」だけ。extras / 環境マーカ / URL /
# パス / ハッシュ指定はすべて不可。実際の 3 ファイルはこの形に収まっている
# （足したくなったら、その形が解決先を動かせないことを確かめてからここへ書くこと）。
$script:RequirementNameRe = '[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?'
$script:RequirementSpecRe = '(?:==|>=|<=|~=|!=|>|<)\s*[A-Za-z0-9][A-Za-z0-9.*+!-]*'

function Test-OfflineRequirementLine {
  <#
    .SYNOPSIS
      requirements の 1 行が「名前 + 省略可能なバージョン指定子」だけかを判定する。
  #>
  param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Line)
  # 行内コメント（` #` 以降）は pip も無視するので落としてから見る。
  $t = ($Line -replace '\s+#.*$', '').Trim()
  if ($t.Length -eq 0) { return $true }
  $spec = "^$($script:RequirementNameRe)(?:\s*$($script:RequirementSpecRe))*$"
  if ($t -notmatch $spec) { return $false }
  # PEP 508 の名前はドットを許すため、`evil.whl` は「名前」として文法を通る。しかし pip は
  # **拡張子でアーカイブと判定**し（`is_archive_file`）、パス/URL として解決しにいく。
  # つまり文法上の名前判定だけでは、リポジトリへ置いたファイルを指させてしまう。
  # 列挙は pip がアーカイブと見なす綴りの**全集合**でなければならない（pip の判定表と対に
  # なる集合で、こちらが漏らすと pip が別解釈で解決してしまう）。tar 系の別綴り
  # （tbz / tlz / tar.lz = 末尾 lz / tar.lzma = 末尾 lzma）まで含めて網羅する。
  if ($t -match '(?i)\.(?:whl|zip|tar|tgz|tbz2|tbz|txz|tlz|egg|gz|bz2|xz|lz|lzma)$') { return $false }
  # パス区切りを含む行はローカルパス参照（`./downloads/foo.whl` 等）なので拒否する。
  # 拡張子網羅と二重で、リポジトリ内ファイルを指す形を確実に落とす（ベアな名前は index /
  # wheelhouse からしか解決されず、解決先を差し替えられない）。
  if ($t -match '[\\/]') { return $false }
  return $true
}

function Test-OfflineRequirementsFile {
  <#
    .SYNOPSIS
      requirements.txt が許可した形だけで構成されているかを検査する。
    .OUTPUTS
      違反の説明文字列の配列（空なら合格）。
  #>
  param([Parameter(Mandatory = $true)][string]$Path)
  $violations = @()
  $lineNo = 0
  foreach ($line in (Read-Utf8Lines -Path $Path)) {
    $lineNo++
    $t = $line.Trim()
    if ($t.Length -eq 0 -or $t.StartsWith('#')) { continue }
    if (-not (Test-OfflineRequirementLine -Line $line)) {
      $violations += "${Path}:${lineNo}: 名前とバージョン指定子だけを書けます: $t"
    }
  }
  , @($violations)
}

function Assert-OfflineRequirementsFile {
  <#
    .SYNOPSIS
      検査に落ちたら停止する。**pip へ渡すすべての入口から呼ぶこと。**
    .DESCRIPTION
      ガードが publish 経路にしか無かった頃は、同じ requirements を pip へ渡す入口が他に
      3 つあり（docs のビルド 2 経路・隔離 venv の 2 経路）、どれも検査を通らなかった。
      `--no-index` は requirements 内の `--find-links <URL>` や直 URL 参照を止めないので、
      「オフラインだから安全」も成立しない。
  #>
  param([Parameter(Mandatory = $true)][string]$Path)
  $violations = Test-OfflineRequirementsFile -Path $Path
  if ($violations.Count -gt 0) {
    foreach ($v in $violations) { Write-Error "[requirements] $v" }
    throw "requirements の形式検査に失敗しました: $Path"
  }
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
# 期待値は Release に並ぶ .sha256（転送破損の検知）または呼び出し側が持つ値を渡す。
function Assert-FileSha256 {
  param(
    [Parameter(Mandatory = $true)][string]$File,
    [Parameter(Mandatory = $true)][string]$ExpectedSha256,
    [Parameter(Mandatory = $true)][string]$Label
  )
  $actual = (Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLower()
  if ($actual -ne $ExpectedSha256.ToLower()) {
    throw ("$Label の sha256 が期待値と一致しません。`n  expected: $($ExpectedSha256.ToLower())" +
      "`n  actual:   $actual`n  取得物が期待したリリースのものでない。処理を中止する。")
  }
  Write-Host "[info] sha256 OK ($Label): $actual"
}
