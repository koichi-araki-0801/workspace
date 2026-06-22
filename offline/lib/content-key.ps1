# 共通ライブラリ: offline バンドルの content-key 算出と tar 解決。
# publish / setup / setup-local から dot-source して使う（手動同期を避け 1 か所へ集約）。
# 日本語コメントを含むため UTF-8 BOM 必須（cp932 環境で文字化けさせない）。

# pnpm-lock.yaml の行末は環境差（Windows working tree=CRLF / GitHub アーカイブ=LF）で
# バイト列が変わる。キーを行末非依存にするため CR(0x0D) を除去して LF 正規化し、
# packageManager 文字列を連結してから SHA256 を測る。publish / setup 双方で同一値になる。
#
# さらに、Python ビルド依存（`pdf-to-svg\requirements.txt` / `graph-editor\requirements.txt`）
# も同様に CR 除去して連結する。これらは重量物バンドルに同梱する `python-wheelhouse` の
# 内容を規定するため、変われば wheelhouse の再生成が要る。1 キーで pnpm 依存・pnpm 本体・
# Playwright・Python wheel すべての変化を覆える。
function Get-LockContentKey {
  param(
    [Parameter(Mandatory = $true)][string]$LockFile,
    [Parameter(Mandatory = $true)][string]$PackageManager
  )
  # ファイルを読み CR(0x0D) を除去して LF 正規化したバイト列(List)を返す内部ヘルパ。
  # `,$lb` で List を 1 オブジェクトとして返す（pipeline 展開でバイト配列に化けるのを防ぐ）。
  $readNoCr = {
    param([string]$path)
    $raw = [System.IO.File]::ReadAllBytes($path)
    $lb = New-Object System.Collections.Generic.List[byte] ($raw.Length)
    foreach ($x in $raw) { if ($x -ne 13) { $lb.Add($x) } }
    , $lb
  }
  $acc = & $readNoCr $LockFile
  $acc.AddRange([System.Text.Encoding]::UTF8.GetBytes($PackageManager))
  # requirements.txt と git-tools の manifest は lockfile の親（= リポジトリ直下）からの
  # 相対で探し、存在するものだけ折り込む。git-tools\manifest.txt は同梱する git /
  # TortoiseGit のバイナリ版を規定するため、変われば重量物バンドルの再配布が要る。
  $repoRoot = Split-Path -Parent $LockFile
  foreach ($rel in @('pdf-to-svg\requirements.txt', 'graph-editor\requirements.txt', 'git-tools\manifest.txt')) {
    $rp = Join-Path $repoRoot $rel
    if (Test-Path -LiteralPath $rp) { $acc.AddRange((& $readNoCr $rp)) }
  }
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try { (($sha.ComputeHash($acc.ToArray()) | ForEach-Object { $_.ToString('x2') }) -join '') }
  finally { $sha.Dispose() }
}

# package.json の packageManager 文字列を取り出す（pnpm@x.y.z+sha512... 形式）。
function Get-PackageManagerString {
  param([Parameter(Mandatory = $true)][string]$PkgJson)
  $pkg = Get-Content $PkgJson -Raw | ConvertFrom-Json
  [string]$pkg.packageManager
}

# tar は Windows 標準（System32\tar.exe = BSD tar）を明示優先する。
# Git Bash 等の MSYS tar が PATH 先頭にあると、`-C C:\...` を rsh の host:path と誤認し
# 「Cannot connect to C:」で失敗するため（フックは sh 経由で起動され PATH が混ざりうる）。
function Resolve-Tar {
  $sys = Join-Path $env:SystemRoot 'System32\tar.exe'
  if (Test-Path $sys) { return $sys }
  $c = Get-Command 'tar.exe' -ErrorAction SilentlyContinue
  if ($c) { return $c.Source }
  $c = Get-Command 'tar' -ErrorAction SilentlyContinue
  if ($c) { return $c.Source }
  Write-Error "[error] 'tar' が見つかりません（Windows 10/11 標準の tar.exe が必要）。"; exit 1
}
