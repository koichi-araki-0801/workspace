# 共通ライブラリ: offline バンドルの content-key 算出と tar 解決。
# publish / setup / setup-local から dot-source して使う（手動同期を避け 1 か所へ集約）。
# 日本語コメントを含むため UTF-8 BOM 必須（cp932 環境で文字化けさせない）。

# pnpm-lock.yaml の行末は環境差（Windows working tree=CRLF / GitHub アーカイブ=LF）で
# バイト列が変わる。キーを行末非依存にするため CR(0x0D) を除去して LF 正規化し、
# packageManager 文字列を連結してから SHA256 を測る。publish / setup 双方で同一値になる。
# pnpm-lock.yaml は機械生成でコメントを持たないため、この CR 除去バイト列をそのまま使う。
#
# さらに、Python 依存（リポジトリが追跡する全 requirements.txt。列挙は
# `Get-OfflineRequirementsFiles` へ一本化 — ハードコード列挙だと新規追加時に検知が
# 空振りする drift を生む）と、同梱物の manifest（git-tools の `git-tools\manifest.txt`、
# docs mermaid の `docs\_build\vendor\manifest.txt`、msnodesqlv8 prebuild の
# `native-prebuilds\manifest.txt`）も折り込む。requirements は重量物バンドルへ
# 同梱する `python-wheelhouse` の内容を、manifest は同梱する git / TortoiseGit / mermaid.min.js /
# ネイティブ prebuild の版を規定するため、
# 変われば重量物バンドルの再生成・再配布が要る。1 キーで pnpm 依存・pnpm 本体・Playwright・
# Python wheel・git ツールすべての変化を覆える。
#
# ただしこれらは人間が編集する「コメント付きテキスト manifest」であり、コメント規約
# （コメントのみの変更は成果物に影響させない。cf. pie-chart の byte-diff 不変）と整合させるため、
# 行コメント（先頭が `#`）と空行を除いた**有意行のみ**を折り込む。これにより requirements.txt の
# コメント一行を直しただけで content key が反転し、wheelhouse 再生成が空振りする誤検知を防ぐ。

# ── requirements.txt の列挙（追跡ファイル全件をグロブ走査） ──
# publish（pip download 対象・許可リスト検査）と content-key（この関数）が別々に
# requirements.txt をハードコード列挙すると、新規追加時に片方だけ更新を忘れる drift が
# 起きる。列挙をここへ一本化し、両方がこの関数を呼ぶ。既定は `git ls-files`（追跡ファイル
# 限定 — node_modules や python-wheelhouse 等の生成物・重量物置き場を構造的に除外できる）。
# git が使えない環境向けに Get-ChildItem -Recurse + 除外リストへフォールバックする。
# 2 経路は Get-OfflineRequirementsFilesViaGit / ...ViaFileSystem として個別に呼べる形へ分け、
# 「同じ結果になる」ことを verify.Tests.ps1 が両方を直接呼んで突き合わせる。

# git ls-files 経路。git が使えない、または RepoRoot が git 管理外なら $null を返し、
# 呼び出し元（Get-OfflineRequirementsFiles）にフォールバックを促す。
function Get-OfflineRequirementsFilesViaGit {
  param([Parameter(Mandatory = $true)][string]$RepoRoot)
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) { return $null }
  $repoFull = (Resolve-Path -LiteralPath $RepoRoot).ProviderPath
  $out = & git -C $repoFull ls-files -- '*requirements.txt' 2>$null
  if ($LASTEXITCODE -ne 0) { return $null }
  , @($out | ForEach-Object { Join-Path $repoFull ($_ -replace '/', '\') } | Sort-Object -Unique)
}

# フォールバック経路。node_modules / .git / .venv* / python-wheelhouse を除外して
# requirements.txt をファイル名で再帰探索する。
function Get-OfflineRequirementsFilesViaFileSystem {
  param([Parameter(Mandatory = $true)][string]$RepoRoot)
  $repoFull = (Resolve-Path -LiteralPath $RepoRoot).ProviderPath
  $excludedDirs = @('node_modules', '.git', 'python-wheelhouse')
  $found = Get-ChildItem -LiteralPath $repoFull -Recurse -File -Filter 'requirements.txt' -Force -ErrorAction SilentlyContinue |
    Where-Object {
      $parts = ($_.FullName.Substring($repoFull.Length).TrimStart('\', '/')) -split '[\\/]'
      -not ($parts | Where-Object { $excludedDirs -contains $_ -or $_ -like '.venv*' })
    } |
    ForEach-Object { $_.FullName }
  , @($found | Sort-Object -Unique)
}

function Get-OfflineRequirementsFiles {
  param([Parameter(Mandatory = $true)][string]$RepoRoot)
  # 呼び出し先は単数要素のスカラー化を防ぐため `, @(...)` で返す。それを変数で受けてから
  # `return` すると外側の 1 段だけ剥がれて 1 パス = 1 要素で流れる。関数呼び出しを
  # bare statement で素通しすると内側の配列がそのまま 1 要素として出力へ透過し、pipe 経由の
  # 消費側で「要素 1 個 = 全パスの配列」に潰れる (git 経路・ファイルシステム経路とも同じ)。
  $viaGit = Get-OfflineRequirementsFilesViaGit -RepoRoot $RepoRoot
  if ($null -ne $viaGit) { return $viaGit }
  $viaFileSystem = Get-OfflineRequirementsFilesViaFileSystem -RepoRoot $RepoRoot
  return $viaFileSystem
}

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
  # コメント付き manifest（requirements.txt / git-tools\manifest.txt）用の有意行リーダ。
  # UTF-8 として読み、各行を rstrip（CR・末尾空白を除去）したうえで、空行と行コメント
  # （trim 後の先頭が `#`）を捨て、残った行を LF 連結した UTF-8 バイト列(List)を返す。
  # 行内コメント（`pkg  # 注` 形式）は URL の `#egg=` 等を壊しうるため意図的に残す。
  $readSignificant = {
    param([string]$path)
    $text = [System.Text.Encoding]::UTF8.GetString([System.IO.File]::ReadAllBytes($path))
    $kept = New-Object System.Collections.Generic.List[string]
    foreach ($line in ($text -split "`n")) {
      $rstripped = $line.TrimEnd("`r", ' ', "`t")
      $trimmed = $rstripped.TrimStart(' ', "`t")
      if ($trimmed.Length -eq 0) { continue }       # 空行（空白のみを含む）
      if ($trimmed.StartsWith('#')) { continue }    # 行コメント
      $kept.Add($rstripped)
    }
    $bytes = [System.Text.Encoding]::UTF8.GetBytes([string]::Join("`n", $kept))
    $lb = New-Object System.Collections.Generic.List[byte] ($bytes.Length)
    $lb.AddRange($bytes)
    , $lb
  }
  $acc = & $readNoCr $LockFile
  $acc.AddRange([System.Text.Encoding]::UTF8.GetBytes($PackageManager))
  # requirements.txt はリポジトリ追跡ファイルを走査して折り込む。git-tools 等の manifest は
  # lockfile の親（= リポジトリ直下）からの相対で探し、存在するものだけ有意行で折り込む。
  $repoRoot = Split-Path -Parent $LockFile
  foreach ($rp in (Get-OfflineRequirementsFiles -RepoRoot $repoRoot)) {
    if (Test-Path -LiteralPath $rp) { $acc.AddRange((& $readSignificant $rp)) }
  }
  foreach ($rel in @('docs\_build\vendor\manifest.txt', 'git-tools\manifest.txt',
      'native-prebuilds\manifest.txt')) {
    $rp = Join-Path $repoRoot $rel
    if (Test-Path -LiteralPath $rp) { $acc.AddRange((& $readSignificant $rp)) }
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
