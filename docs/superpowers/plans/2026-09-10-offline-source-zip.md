# オフライン端末へのソース搬入（Release にソース ZIP を復活）実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** GitHub Release `offline-bundle-v1` にソース ZIP（`source.zip` + `.sha256`）を毎回 upload し、ネット端末の `fetch -Source` → 遮断端末の `setup-offline.bat` 一つで初回・更新の両方が完走する。

**Architecture:** publish が `git archive HEAD` に `MANIFEST`（`git ls-files`）と `SOURCE-COMMIT` を同梱して upload。fetch は `-Source` で ZIP も取得。setup は直下に `source.zip` があれば `[0/5]` 展開段（`.sha256` 照合 → 旧 `MANIFEST` の名簿を削除 → 展開 → `bk\` へ退避）を走らせ、新版の自分を `-SkipSourceExtract` で再実行して構築へ進む。展開・削除の実処理は `offline\lib\source.ps1` に切り出し Pester で固定する。

**Tech Stack:** PowerShell 5.1（`.ps1` 統一。UTF-8 BOM + CRLF）/ Pester 3.4 / git ≥ 2.30（配布担当のみ、`git archive --add-file`）/ `gh` CLI（配布担当のみ）

**Spec:** `docs/superpowers/specs/2026-09-10-offline-source-zip-design.md`（決定 Q1〜Q11・却下案・残リスク）

## Global Constraints

- `.ps1` は UTF-8 BOM + CRLF、`.bat` は ASCII + CRLF。`.ps1` には同名 `.bat` を併設（dot-source ライブラリは `scripts/check-comments.py` の `bat_pairing_exceptions` へ）。
- コメント規約は `docs/コメント規約.md`（なぜを書く / 日本語散文 / 経緯・日付を書かない）。`.ps1` は comment-based help。
- 新規 .ps1 は offline 配布スクリプト群に限る例外（Python 第一方針の例外。memory `team-python-first`）。
- 遮断端末の入口は `setup-offline.bat` 一つ（Q6）。展開段は `source.zip` があるときだけ動き、`-SkipSourceExtract` 時は動かない（再帰防止）。
- 名簿の削除はリポジトリ直下からの相対パスとしてだけ解釈し、`..` 区切り・絶対パス・`\\` 始まりは何も消さずに中止する（spec 3.3）。存在しないファイルは無視、空フォルダは消さない。
- `source.zip.sha256` が無い / 合わないときは削除も展開も行わない（Q11）。
- fetch は `-Source` を付けたときだけ ZIP を取り、ソースの `.sha256` が合わなければ重量物 3 ファイルも含めて直下に何も置かない（spec 3.5-5）。
- publish（`local-only/`）は git 管理外。変更はこのブランチのコミットに**入らない**（Task 4 は手順として実施し、E2E で確かめる）。
- push はユーザーに依頼する（pre-push CI 11〜12 分）。
- 各タスクは RED → GREEN → REFACTOR。Pester の実行: `powershell -NoProfile -Command "Import-Module Pester -RequiredVersion 3.4.0 -Force; $r = Invoke-Pester -Script offline/lib/verify.Tests.ps1 -PassThru -Quiet; \"Passed $($r.PassedCount) Failed $($r.FailedCount)\""`（現在 34 passed）。

## File Structure

| 区分 | ファイル | 責務 |
|---|---|---|
| 新規 | `offline/lib/source.ps1` | 名簿の検査・削除、ZIP 展開段（照合 → 削除 → 展開 → 退避）、`SOURCE-COMMIT` の読み取り |
| 変更 | `offline/lib/fetch.ps1` | `Save-VerifiedReleaseBundle -IncludeSource`（5 ファイルを一時ディレクトリで揃えて検証 → 配置） |
| 変更 | `offline/lib/verify.Tests.ps1` | 上記の Pester |
| 変更 | `offline/setup-offline.ps1` / `.bat` | `[0/5]` 展開段・`-SkipSourceExtract`・再実行・`SOURCE-COMMIT` 表示・不一致案内 |
| 変更 | `offline/fetch-offline-bundle.ps1` / `.bat` | `-Source` |
| 変更（git 管理外） | `local-only/offline-publish/publish-offline-bundle.ps1` | clean tree 必須・`MANIFEST` / `SOURCE-COMMIT` 生成・`source.zip` 常時 upload |
| 変更 | `scripts/check-comments.py` | 免除リストへ `offline/lib/source.ps1` |
| 変更 | `offline/README-offline.txt`、`README.md`、`docs/editor/src/デプロイ運用手順書.md`（+ HTML 再生成） | 手順・リスク・対象外の記述 |

---

## Task 1: `offline/lib/source.ps1` — 名簿削除と展開段（Pester 先行）

**Files:**
- Create: `offline/lib/source.ps1`
- Modify: `offline/lib/verify.Tests.ps1`（先頭の dot-source に `source.ps1` を足し、末尾に Describe を追加）
- Modify: `scripts/check-comments.py`（`bat_pairing_exceptions` に `"offline/lib/source.ps1"`）

**Interfaces:**
- Produces:
  - `Assert-ManifestPathsSafe -Lines <string[]>`: 1 行でも不正（`..` 区切り / 絶対パス / `\\` 始まり / `/` 始まり）があれば例外。空行は無視。
  - `Remove-ManifestFiles -RepoRoot <dir> -ManifestPath <file>` → 削除した件数（int）。名簿は `Read-Utf8Lines`（`verify.ps1`）で読む。存在しないファイルは無視、ディレクトリは消さない。
  - `Invoke-SourceExtractStage -RepoRoot <dir> -Bk <dir> [-ZipName 'source.zip'] [-ManifestName 'MANIFEST']` → `@{ Removed = <int>; FirstRun = <bool> }`。手順: `.sha256` 照合（`Get-Sha256FromSidecar` + `Assert-FileSha256`。無い・合わない → 例外、何もしない）→ 旧 `MANIFEST` があれば削除（無ければ `Write-Warning` で初回扱い）→ `Expand-Archive -Force` で直下へ → `source.zip` と `.sha256` を `bk\` へ移動。
  - `Read-SourceCommit -RepoRoot <dir>` → `SOURCE-COMMIT` の 1 行（trim 済）。無ければ `$null`。
- Consumes: `verify.ps1` の `Read-Utf8Lines` / `Get-Sha256FromSidecar` / `Assert-FileSha256`。

- [ ] **Step 1: RED — Pester を書く**

`offline/lib/verify.Tests.ps1` の先頭 dot-source ブロックに `. (Join-Path $here 'source.ps1')` を足し、末尾に追加:

```powershell
Describe 'Assert-ManifestPathsSafe（名簿はリポジトリ直下からの相対パスだけ）' {
  It '相対パスだけなら通す（空行は無視）' {
    { Assert-ManifestPathsSafe -Lines @('offline/setup-offline.ps1', '', 'docs/a b/c.md') } | Should Not Throw
  }
  It '.. を含む行があれば止まる' {
    { Assert-ManifestPathsSafe -Lines @('offline/x.ps1', '../outside.txt') } | Should Throw
    { Assert-ManifestPathsSafe -Lines @('a/../../b') } | Should Throw
  }
  It '絶対パス・UNC・ルート始まりは止まる' {
    { Assert-ManifestPathsSafe -Lines @('C:\Windows\x') } | Should Throw
    { Assert-ManifestPathsSafe -Lines @('\\server\share\x') } | Should Throw
    { Assert-ManifestPathsSafe -Lines @('/etc/passwd') } | Should Throw
    { Assert-ManifestPathsSafe -Lines @('\x') } | Should Throw
  }
}

Describe 'Remove-ManifestFiles（旧名簿に載るファイルだけを消す）' {
  BeforeEach {
    $script:root = Join-Path $TestDrive ('root-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path (Join-Path $script:root 'offline'), (Join-Path $script:root 'bk'), (Join-Path $script:root 'node_modules\pkg') -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $script:root 'offline\old.ps1') -Value 'x' -Encoding Ascii
    Set-Content -LiteralPath (Join-Path $script:root 'offline\keep.ps1') -Value 'x' -Encoding Ascii
    Set-Content -LiteralPath (Join-Path $script:root 'appconfig.json') -Value '{}' -Encoding Ascii
    Set-Content -LiteralPath (Join-Path $script:root 'bk\offline-deps-bundle.tar.gz') -Value 'b' -Encoding Ascii
    Set-Content -LiteralPath (Join-Path $script:root 'node_modules\pkg\index.js') -Value 'j' -Encoding Ascii
    $script:manifest = Join-Path $script:root 'MANIFEST'
    [IO.File]::WriteAllText($script:manifest, "offline/old.ps1`noffline/gone-already.ps1`n", [Text.UTF8Encoding]::new($false))
  }
  It '名簿のファイルだけ消え、名簿に無いものと git 管理外は残る。存在しない行は無視する' {
    $n = Remove-ManifestFiles -RepoRoot $script:root -ManifestPath $script:manifest
    $n | Should Be 1
    (Test-Path (Join-Path $script:root 'offline\old.ps1')) | Should Be $false
    (Test-Path (Join-Path $script:root 'offline\keep.ps1')) | Should Be $true
    (Test-Path (Join-Path $script:root 'appconfig.json')) | Should Be $true
    (Test-Path (Join-Path $script:root 'bk\offline-deps-bundle.tar.gz')) | Should Be $true
    (Test-Path (Join-Path $script:root 'node_modules\pkg\index.js')) | Should Be $true
  }
  It '空になったフォルダは消さない' {
    [IO.File]::WriteAllText($script:manifest, "offline/old.ps1`noffline/keep.ps1`n", [Text.UTF8Encoding]::new($false))
    Remove-ManifestFiles -RepoRoot $script:root -ManifestPath $script:manifest | Out-Null
    (Test-Path (Join-Path $script:root 'offline')) | Should Be $true
  }
  It '名簿に不正な行があれば 1 つも消さずに止まる' {
    [IO.File]::WriteAllText($script:manifest, "offline/old.ps1`n../outside`n", [Text.UTF8Encoding]::new($false))
    { Remove-ManifestFiles -RepoRoot $script:root -ManifestPath $script:manifest } | Should Throw
    (Test-Path (Join-Path $script:root 'offline\old.ps1')) | Should Be $true
  }
}

Describe 'Invoke-SourceExtractStage（照合 → 旧名簿で削除 → 展開 → 退避）' {
  BeforeEach {
    $script:root = Join-Path $TestDrive ('root-' + [guid]::NewGuid().ToString('N'))
    $script:bk = Join-Path $script:root 'bk'
    New-Item -ItemType Directory -Path (Join-Path $script:root 'offline'), $script:bk -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $script:root 'offline\old.ps1') -Value 'old' -Encoding Ascii
    Set-Content -LiteralPath (Join-Path $script:root 'appconfig.json') -Value '{}' -Encoding Ascii
    # 新版の ZIP を作る（offline/new.ps1 + MANIFEST + SOURCE-COMMIT。prefix 無し）
    $src = Join-Path $TestDrive ('src-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path (Join-Path $src 'offline') -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $src 'offline\new.ps1') -Value 'new' -Encoding Ascii
    [IO.File]::WriteAllText((Join-Path $src 'MANIFEST'), "offline/new.ps1`n", [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText((Join-Path $src 'SOURCE-COMMIT'), "0123456789abcdef0123456789abcdef01234567 2026-09-10T00:00:00+09:00`n", [Text.UTF8Encoding]::new($false))
    $script:zip = Join-Path $script:root 'source.zip'
    Compress-Archive -Path (Join-Path $src '*') -DestinationPath $script:zip -Force
    $hash = (Get-FileHash -LiteralPath $script:zip -Algorithm SHA256).Hash.ToLower()
    Set-Content -LiteralPath "$($script:zip).sha256" -Value "$hash  source.zip" -Encoding Ascii
  }
  It '旧 MANIFEST があれば削除してから展開し、ZIP と .sha256 を bk\ へ退避する' {
    [IO.File]::WriteAllText((Join-Path $script:root 'MANIFEST'), "offline/old.ps1`n", [Text.UTF8Encoding]::new($false))
    $r = Invoke-SourceExtractStage -RepoRoot $script:root -Bk $script:bk
    $r.FirstRun | Should Be $false
    $r.Removed | Should Be 1
    (Test-Path (Join-Path $script:root 'offline\old.ps1')) | Should Be $false
    (Test-Path (Join-Path $script:root 'offline\new.ps1')) | Should Be $true
    (Test-Path (Join-Path $script:root 'appconfig.json')) | Should Be $true
    (Get-Content -LiteralPath (Join-Path $script:root 'MANIFEST') -Raw).Trim() | Should Be 'offline/new.ps1'
    (Test-Path (Join-Path $script:bk 'source.zip')) | Should Be $true
    (Test-Path (Join-Path $script:bk 'source.zip.sha256')) | Should Be $true
    (Test-Path $script:zip) | Should Be $false
  }
  It '旧 MANIFEST が無ければ初回扱い（削除せず警告）で展開する' {
    $r = Invoke-SourceExtractStage -RepoRoot $script:root -Bk $script:bk -WarningVariable w -WarningAction SilentlyContinue
    $r.FirstRun | Should Be $true
    (Test-Path (Join-Path $script:root 'offline\old.ps1')) | Should Be $true
    (Test-Path (Join-Path $script:root 'offline\new.ps1')) | Should Be $true
  }
  It '.sha256 が無ければ何もせずに止まる' {
    Remove-Item -LiteralPath "$($script:zip).sha256"
    [IO.File]::WriteAllText((Join-Path $script:root 'MANIFEST'), "offline/old.ps1`n", [Text.UTF8Encoding]::new($false))
    { Invoke-SourceExtractStage -RepoRoot $script:root -Bk $script:bk } | Should Throw
    (Test-Path (Join-Path $script:root 'offline\old.ps1')) | Should Be $true
    (Test-Path (Join-Path $script:root 'offline\new.ps1')) | Should Be $false
    (Test-Path $script:zip) | Should Be $true
  }
  It '.sha256 が合わなければ何もせずに止まる' {
    Set-Content -LiteralPath "$($script:zip).sha256" -Value (('a' * 64) + '  source.zip') -Encoding Ascii
    { Invoke-SourceExtractStage -RepoRoot $script:root -Bk $script:bk } | Should Throw
    (Test-Path (Join-Path $script:root 'offline\new.ps1')) | Should Be $false
  }
}

Describe 'Read-SourceCommit' {
  It 'ファイルがあれば 1 行を返し、無ければ null' {
    $root = Join-Path $TestDrive ('rc-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $root | Out-Null
    ($null -eq (Read-SourceCommit -RepoRoot $root)) | Should Be $true
    [IO.File]::WriteAllText((Join-Path $root 'SOURCE-COMMIT'), "abc 2026-09-10T00:00:00+09:00`n", [Text.UTF8Encoding]::new($false))
    Read-SourceCommit -RepoRoot $root | Should Be 'abc 2026-09-10T00:00:00+09:00'
  }
}
```

- [ ] **Step 2: RED を確認**

Run: Pester（Global Constraints のコマンド）。Expected: `source.ps1` が無く dot-source で失敗。

- [ ] **Step 3: `offline/lib/source.ps1` を書く**

```powershell
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
  param([Parameter(Mandatory = $true)][AllowEmptyCollection()][string[]]$Lines)
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
```

保存後に BOM + CRLF へ正規化する（`source.ps1` と `verify.Tests.ps1`）:

```powershell
foreach ($f in @('offline\lib\source.ps1','offline\lib\verify.Tests.ps1')) {
  $t = [IO.File]::ReadAllText($f, [Text.UTF8Encoding]::new($false)); $t = $t -replace "`r?`n", "`r`n"
  [IO.File]::WriteAllText($f, $t, [Text.UTF8Encoding]::new($true))
}
```

`scripts/check-comments.py` の `bat_pairing_exceptions` に `"offline/lib/source.ps1",` を追加。

- [ ] **Step 4: GREEN**

Run: Pester → `Passed 45 Failed 0`（既存 34 + 11）。`pnpm run check:comments` → 0 error。

- [ ] **Step 5: コミット**

```bash
git add offline/lib/source.ps1 offline/lib/verify.Tests.ps1 scripts/check-comments.py
git commit -m "feat(offline): ソース ZIP の展開段(名簿削除・照合・退避)を lib へ切り出し Pester で固定する"
```

---

## Task 2: fetch の `-Source`（`Save-VerifiedReleaseBundle -IncludeSource`）

**Files:**
- Modify: `offline/lib/fetch.ps1`（`Save-VerifiedReleaseBundle` に `-IncludeSource`）
- Modify: `offline/lib/verify.Tests.ps1`（Describe を追加）
- Modify: `offline/fetch-offline-bundle.ps1` / `.bat`（`-Source`）

**Interfaces:**
- Produces: `Save-VerifiedReleaseBundle -AssetBase -BundleName -Destination [-Downloader] [-IncludeSource]` → `@{ Bundle; Key; Source = <path|null> }`。`-IncludeSource` 時は `source.zip` と `source.zip.sha256` も同じ一時ディレクトリへ取得し、両方の `.sha256` が通ってから 5 ファイルを一括で `Destination` へ移す。
- Consumes: 既存の `Get-Sha256FromSidecar` / `Assert-FileSha256`。

- [ ] **Step 1: RED — Pester**

既存 Describe `Save-VerifiedReleaseBundle（…）` の `BeforeEach` に source 資産を足す（`$script:src` に `source.zip` = 'source payload'、その sha256 sidecar）。追加 It:

```powershell
  It '-IncludeSource で source.zip と .sha256 も Destination へ置き、Source にパスを返す' {
    $r = Save-VerifiedReleaseBundle -AssetBase 'https://example/rel' -BundleName $script:name `
      -Destination $script:dest -Downloader $script:copyFrom -IncludeSource
    $r.Source | Should Be (Join-Path $script:dest 'source.zip')
    (Test-Path -LiteralPath (Join-Path $script:dest 'source.zip.sha256')) | Should Be $true
    @(Get-ChildItem -LiteralPath $script:dest -File).Count | Should Be 5
  }
  It '-IncludeSource 無しでは source.zip を取らず Source は null' {
    $r = Save-VerifiedReleaseBundle -AssetBase 'https://example/rel' -BundleName $script:name `
      -Destination $script:dest -Downloader $script:copyFrom
    ($null -eq $r.Source) | Should Be $true
    @(Get-ChildItem -LiteralPath $script:dest -File).Count | Should Be 3
  }
  It 'source.zip の sha256 が合わなければ重量物 3 ファイルも含めて Destination に何も置かない' {
    Set-Content -LiteralPath (Join-Path $script:src 'source.zip.sha256') -Value (('a' * 64) + '  source.zip') -Encoding Ascii
    { Save-VerifiedReleaseBundle -AssetBase 'https://example/rel' -BundleName $script:name `
        -Destination $script:dest -Downloader $script:copyFrom -IncludeSource } | Should Throw
    @(Get-ChildItem -LiteralPath $script:dest).Count | Should Be 0
  }
```

Run: Pester → 3 件 FAIL（`-IncludeSource` パラメータ不明）。

- [ ] **Step 2: 実装（`fetch.ps1`）**

`Save-VerifiedReleaseBundle` に `[switch]$IncludeSource` を足し、`try` 内を次の形に:

```powershell
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
```

`fetch-offline-bundle.ps1`: `param` に `[switch]$Source` を足し、`.PARAMETER Source`（「遮断端末へ持ち込むソース ZIP（source.zip + .sha256）も取得する。git clone で運用する端末では不要」）、呼び出しを `-IncludeSource:$Source` に。完了メッセージは `-Source` 時「遮断端末へ持ち込むのは次の 5 ファイル: …」を列挙、無し時は従来。`.bat` の rem に `fetch-offline-bundle.bat -Source   also fetch source.zip (for air-gapped machines)` を足す。BOM/CRLF 正規化。

- [ ] **Step 3: GREEN + 実挙動**

Pester → `Passed 48 Failed 0`。不正タグでの smoke（Task 1 で使った一時コピー手順）: `fetch-offline-bundle.ps1 -Source -Tag no-such-tag-xyz` → 404 で exit 1、直下に残骸なし。

- [ ] **Step 4: コミット**

```bash
git add offline/lib/fetch.ps1 offline/lib/verify.Tests.ps1 offline/fetch-offline-bundle.ps1 offline/fetch-offline-bundle.bat
git commit -m "feat(offline): fetch に -Source を足し、ソース ZIP も重量物と一括で検証してから配置する"
```

---

## Task 3: setup の `[0/5]` 展開段と再実行

**Files:**
- Modify: `offline/setup-offline.ps1`（ヘッダ・`param`・dot-source・`[0/5]`・`SOURCE-COMMIT` 表示・不一致案内）
- Modify: `offline/setup-offline.bat`（rem）

**Interfaces:**
- Consumes: Task 1 の `Invoke-SourceExtractStage` / `Read-SourceCommit`。
- Produces: `setup-offline.ps1 [-SkipBuild] [-InstallTortoiseGit] [-SkipSourceExtract]`。

- [ ] **Step 1: 実装**

1. `.DESCRIPTION` の手順 1 の前に「0. 直下に `source.zip` があれば展開段: `.sha256` 照合 → 前回の `MANIFEST` に載るファイルを削除 → 直下へ展開 → `bk\` へ退避 → 新しい `setup-offline.ps1` を `-SkipSourceExtract` で再実行して以降を任せる（自分自身が展開で新しくなるため）」を足す。`.PARAMETER SkipSourceExtract`「展開段を飛ばす（再実行時に自動で付く。手で付ける必要はない）」。
2. `param(` に `[switch]$SkipSourceExtract`。dot-source に `. (Join-Path $PSScriptRoot 'lib\source.ps1')`。
3. `$RepoRoot` / `$Bk` の決定直後（`Assert-LocalRepoRoot` の後、`Resolve-Tar` の前）に:

```powershell
# ---- [0/5] ソース ZIP の展開（直下に source.zip があるときだけ） ----
# 展開で自分自身（このスクリプトと dot-source 済みの lib）が新しくなる。PowerShell は起動時に
# 全文を読んでいるので実行中の処理は落ちないが、構築は新しい版に任せたいので、展開が済んだら
# 新しい setup-offline.ps1 を再実行してその終了コードで終わる。再実行側は -SkipSourceExtract
# 付きで呼ばれ、この段に入らない（再帰防止）。
$SourceZip = Join-Path $RepoRoot 'source.zip'
if (-not $SkipSourceExtract -and (Test-Path -LiteralPath $SourceZip)) {
  Write-Host '[0/5] ソース ZIP を展開...'
  try {
    $r = Invoke-SourceExtractStage -RepoRoot $RepoRoot -Bk $Bk
  } catch {
    Write-Error "[error] $($_.Exception.Message)`n  source.zip と source.zip.sha256 を fetch-offline-bundle.bat -Source で取り直してください。"
    exit 1
  }
  Write-Host "[info] 展開しました（前の版の削除: $($r.Removed) 件$(if ($r.FirstRun) { '、初回扱い' })）。新しい setup を続行します..."
  # `$args` は PowerShell の自動変数なので使わない。
  $reexec = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot 'setup-offline.ps1'), '-SkipSourceExtract')
  if ($SkipBuild) { $reexec += '-SkipBuild' }
  if ($InstallTortoiseGit) { $reexec += '-InstallTortoiseGit' }
  & powershell @reexec
  exit $LASTEXITCODE
}
$sourceCommit = Read-SourceCommit -RepoRoot $RepoRoot
if ($sourceCommit) { Write-Host "[info] source commit: $sourceCommit" }
```

4. `[1/5]` 以降は不変。`[3/5]` の不一致メッセージに 1 行追加:

```powershell
    "`n  遮断端末で source.zip を持ち込んだ場合は、その ZIP が古い（依存を変えたのに publish していない、" +
    "`n  または古い ZIP を持ち込んだ）可能性もあります。$(if ($sourceCommit) { "source commit: $sourceCommit" })" +
```

5. `.bat` の rem に `Also extracts source.zip found at the repo root (air-gapped update), then re-runs itself.` を足す。BOM/CRLF 正規化、parse errors 0 を確認。

- [ ] **Step 2: 一時コピーでの実挙動（展開段 → 再実行 → 重量物なしで停止）**

```powershell
$tmp = Join-Path $env:TEMP ('setupzip-' + [guid]::NewGuid().ToString('N')); New-Item -ItemType Directory -Path $tmp | Out-Null
Copy-Item offline -Destination (Join-Path $tmp 'offline') -Recurse; Copy-Item pnpm-lock.yaml, package.json -Destination $tmp
Set-Content (Join-Path $tmp 'offline\stale.txt') 'stale' -Encoding Ascii
[IO.File]::WriteAllText((Join-Path $tmp 'MANIFEST'), "offline/stale.txt`n", [Text.UTF8Encoding]::new($false))
# 新版 ZIP: 現行の offline/ + package.json + pnpm-lock.yaml + MANIFEST + SOURCE-COMMIT
$src = Join-Path $env:TEMP ('zipsrc-' + [guid]::NewGuid().ToString('N')); New-Item -ItemType Directory -Path $src | Out-Null
Copy-Item offline -Destination (Join-Path $src 'offline') -Recurse; Copy-Item pnpm-lock.yaml, package.json -Destination $src
Set-Content (Join-Path $src 'offline\fresh.txt') 'fresh' -Encoding Ascii
[IO.File]::WriteAllText((Join-Path $src 'MANIFEST'), "offline/fresh.txt`npackage.json`npnpm-lock.yaml`n", [Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText((Join-Path $src 'SOURCE-COMMIT'), "$((git rev-parse HEAD).Trim()) 2026-09-10T00:00:00+09:00`n", [Text.UTF8Encoding]::new($false))
Compress-Archive -Path (Join-Path $src '*') -DestinationPath (Join-Path $tmp 'source.zip') -Force
$h = (Get-FileHash (Join-Path $tmp 'source.zip') -Algorithm SHA256).Hash.ToLower(); Set-Content (Join-Path $tmp 'source.zip.sha256') "$h  source.zip" -Encoding Ascii
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $tmp 'offline\setup-offline.ps1') -SkipBuild; "EXIT $LASTEXITCODE"
Test-Path (Join-Path $tmp 'offline\stale.txt'); Test-Path (Join-Path $tmp 'offline\fresh.txt'); Test-Path (Join-Path $tmp 'bk\source.zip'); Get-Content (Join-Path $tmp 'MANIFEST')
Remove-Item $tmp, $src -Recurse -Force
```

Expected: `[0/5]` → 削除 1 件 → 「新しい setup を続行」→ `[info] source commit: …` → `[1/5]` で「組がありません」exit 1 / `stale.txt` False / `fresh.txt` True / `bk\source.zip` True / MANIFEST が新版。

- [ ] **Step 3: Pester 全件 + check:comments → コミット**

```bash
git add offline/setup-offline.ps1 offline/setup-offline.bat
git commit -m "feat(offline): setup に source.zip の展開段を足し、展開後は新しい setup を再実行して構築する"
```

---

## Task 4: publish の変更（git 管理外 — コミットしない）

**Files:**
- Modify（手元のみ）: `local-only/offline-publish/publish-offline-bundle.ps1`

**Interfaces:**
- Produces: Release アセット `source.zip` / `source.zip.sha256`（毎回）。ZIP 直下に `MANIFEST`（`git ls-files`、LF）と `SOURCE-COMMIT`（`<sha> <ISO 日時>`）。prefix 無し。

- [ ] **Step 1: 前提検査に clean tree を足す**

「HEAD が origin に在る」検査の直前に:

```powershell
# content-key は作業ツリーから、source.zip は HEAD から作る。未コミットの変更があると両者が
# ずれた組を Release に置いてしまうので、clean tree でなければ止める。
$dirty = (& git status --porcelain).Trim()
if ($dirty) { Write-Error "[error] 未コミットの変更があります。コミット（または stash）してから実行してください。`n$dirty"; exit 1 }
```

- [ ] **Step 2: ソース ZIP の生成（重量物の判定とは独立に常に行う）**

`$bundleChanged` の判定の後、重量物生成ブロックの前に:

```powershell
# ---- ソース ZIP（毎回） ----
$SourceZip = Join-Path $RepoRoot 'source.zip'
$SourceSha = "$SourceZip.sha256"
$srcTmp = Join-Path $tmp 'src'
New-Item -ItemType Directory -Path $srcTmp -Force | Out-Null
$manifestPath = Join-Path $srcTmp 'MANIFEST'
$commitPath   = Join-Path $srcTmp 'SOURCE-COMMIT'
(& git ls-files) -join "`n" | Set-Content -LiteralPath $manifestPath -Encoding utf8 -NoNewline
Add-Content -LiteralPath $manifestPath -Value "`n" -NoNewline -Encoding utf8
"$headSha $((& git show -s --format=%cI HEAD).Trim())" | Set-Content -LiteralPath $commitPath -Encoding ascii -NoNewline
& git archive HEAD --format=zip --add-file=$manifestPath --add-file=$commitPath -o $SourceZip
if ($LASTEXITCODE -ne 0) { Write-Error '[error] git archive に失敗しました（git 2.30 以上が必要）。'; exit 1 }
$srcHash = (Get-FileHash $SourceZip -Algorithm SHA256).Hash.ToLower()
"$srcHash  source.zip" | Set-Content -Path $SourceSha -Encoding ascii -NoNewline
$srcMB = [math]::Round((Get-Item $SourceZip).Length / 1MB, 1)
Write-Host "[info] source.zip: ${srcMB}MB / $(Get-Content $commitPath -Raw)"
```

`Set-Content -Encoding utf8` は PS5.1 で BOM 付きになるため、`MANIFEST` は `[IO.File]::WriteAllText($manifestPath, ((& git ls-files) -join "`n") + "`n", [Text.UTF8Encoding]::new($false))` で書く（BOM 無し LF。`Read-Utf8Lines` は BOM 付きでも読めるが、名簿の 1 行目が `\uFEFF` 付きにならないよう BOM 無しに統一）。

- [ ] **Step 3: upload の順序（重量物（変化時）→ ソース（毎回））**

「Release のアセット差し替え」ブロックを次の形に:

```powershell
if (-not $releaseExists) { Write-Error "[error] Release $Tag がありません。..."; exit 1 }
if ($bundleChanged) {
  Write-Host '[info] 重量物をアップロード（--clobber で差し替え）...'
  & gh release upload $Tag $Bundle $Sha $KeyFile --clobber
  if ($LASTEXITCODE -ne 0) { Write-Error '[error] gh release upload（重量物）に失敗しました。'; exit 1 }
}
Write-Host '[info] ソース ZIP をアップロード（--clobber で差し替え）...'
& gh release upload $Tag $SourceZip $SourceSha --clobber
if ($LASTEXITCODE -ne 0) { Write-Error '[error] gh release upload（source.zip）に失敗しました。'; exit 1 }
Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item $SourceZip, $SourceSha -Force -ErrorAction SilentlyContinue
Write-Host "[OK] 公開完了: $Tag に source.zip (${srcMB}MB) $(if ($bundleChanged) { "と $BundleName / .sha256 / bundle.key" })を反映しました。"
```

早期 `exit 0`（「重量物は一致（変更なし）」）は削除する（ソースは毎回上げるため）。`.SYNOPSIS`/`.DESCRIPTION` に「ソース ZIP は毎回 upload、clean tree 必須」を追記。`.gitignore` に `source.zip` / `source.zip.sha256` / `MANIFEST` / `SOURCE-COMMIT` を足す（clone 運用の端末で誤って生成されても追跡させない。**この 1 行はコミット対象**: Task 5 に含める）。

- [ ] **Step 4: 検証は Task 6（E2E）で行う**（未コミットの変更を 1 つ作った状態で止まること、`source.zip` が Release に並ぶこと）

---

## Task 5: 文書・Release 本文・タグ・`.gitignore`

**Files:**
- Modify: `offline/README-offline.txt`、`README.md`（16, 43 行付近）、`docs/editor/src/デプロイ運用手順書.md`（26 行付近）、`.gitignore`
- Regenerate: `py -3.13 docs/_build/build_all.py --project editor`（`editor_設計.html`）
- 手作業: Release 本文、ローカルタグの整列

- [ ] **Step 1: README-offline の手順を書き直す**

「手順（他端末）」を次の構成に（内容は spec 3.4）:

```
■ 手順 A: git clone できる端末
1) git clone … 2) offline\fetch-offline-bundle.bat 3) offline\setup-offline.bat 4) 動作確認
■ 手順 B: ネットに出られない端末（遮断端末）
  B-1 準備（ネット接続端末で）: clone した直下で offline\fetch-offline-bundle.bat -Source
      → 直下の 5 ファイル（offline-deps-bundle.tar.gz / .sha256 / bundle.key / source.zip / source.zip.sha256）を USB 等で運ぶ
  B-2 初回: source.zip を新しいフォルダへ展開（エクスプローラの「すべて展開」。展開先の直下に offline\ が並ぶ）
      → 重量物 3 ファイルを直下へ置く → offline\setup-offline.bat
  B-3 更新: 新しい source.zip と source.zip.sha256 を同じフォルダの直下へ置く → offline\setup-offline.bat
      （.sha256 照合 → 前の版のファイルを MANIFEST で削除 → 展開 → 新しい setup が構築。重量物は content-key が同じなら前のまま）
  ※ 直下の MANIFEST / SOURCE-COMMIT は消さない（次回の更新と版の表示に使う）
  ※ 更新は同じフォルダで行う（PortableGit の場所などが環境変数に固定されるため）
  ※ python-tools は本手順の対象外
```

「前提と受け入れているリスク」に「source.zip のすり替えも検出しない（重量物と同じ扱い。Release を更新できるのは所有者のみ）」、トラブルシュートに「[0/5] で止まる → source.zip.sha256 を fetch -Source で取り直す」「content-key 不一致で source commit が古い → publish 忘れ。配布担当に依頼」を足す。BOM 維持。

- [ ] **Step 2: README.md / デプロイ運用手順書 / .gitignore**

- `README.md` 入口一覧の fetch 行: 役割に「`-Source` で遮断端末向けのソース ZIP も取得」を足す。
- デプロイ運用手順書 26 行目の手順 2: 「ネットに出られる端末で `fetch-offline-bundle.bat -Source` → 5 ファイルを運用端末へ → 初回は `source.zip` を展開して `setup-offline.bat`、更新は `source.zip` を直下に置いて `setup-offline.bat`」に。
- `.gitignore` に `source.zip` / `source.zip.sha256` / `MANIFEST` / `SOURCE-COMMIT`（コメント付き: publish の生成物・遮断端末の展開段が直下に残すもの）。
- `py -3.13 docs/_build/build_all.py --project editor`。

- [ ] **Step 3: Release 本文とタグ（手作業。コミット対象外）**

```powershell
gh release edit offline-bundle-v1 --notes "重量物: offline-deps-bundle.tar.gz / .sha256 / bundle.key。ソース: source.zip / source.zip.sha256（毎回更新）。GitHub が自動で添える Source code (zip / tar.gz) は古いコミットのもので使わない。手順は offline/README-offline.txt。"
git fetch --tags --force
git rev-parse offline-bundle-v1   # 17e6841… と一致すること
```

- [ ] **Step 4: コミット**

```bash
git add offline/README-offline.txt README.md "docs/editor/src/デプロイ運用手順書.md" "docs/editor/editor_設計.html" .gitignore
git commit -m "docs(offline): 遮断端末へのソース搬入手順(fetch -Source → setup)と受容リスク・対象外を書く"
```

---

## Task 6: E2E（spec 3.6）

**Files:** なし（実測結果を spec の「状態」へ追記して 1 コミット）

- [ ] **Step 1: publish**（この端末）: 未コミットの変更を 1 つ作って `publish-offline-bundle.bat` → clean tree 検査で exit 1。戻して実行 → `gh release view offline-bundle-v1 --json assets` に `source.zip` / `source.zip.sha256` が並び、重量物は skip（content-key 一致）。
- [ ] **Step 2: fetch**: `C:\Users\Public\offline-verify\workspace-e2e` を clone → `offline\fetch-offline-bundle.bat -Source` → 5 ファイル。スイッチ無しで 3 ファイル。
- [ ] **Step 3: 初回**: `.git` 無しの `workspace-zip-e2e` に `source.zip` を手で展開 → 重量物 3 ファイル配置 → `DATA_ROOT` / `GIT_BIN` を上書きしたシェルで `offline\setup-offline.bat` 完走 → `corepack pnpm run ci`（先に pie-chart 基準生成）。
- [ ] **Step 4: 更新**: 追跡ファイルの削除・改名を含むコミットを push → publish → fetch -Source → `source.zip` + `.sha256` を `workspace-zip-e2e` 直下へ → `setup-offline.bat` → 残留なし / `bk\`・`appconfig.json` 温存 / `SOURCE-COMMIT` 更新 / 再実行 setup が構築完走。
- [ ] **Step 5: 不一致案内**: 依存を変えたコミットで publish せず、古い重量物のまま 4 → content-key 不一致の案内に「source.zip が古い可能性」と source commit が出る。
- [ ] **Step 6: 回帰**: `pnpm run ci:offline` と `pnpm run ci` が緑。実測時間（setup 初回 / 更新）を spec「状態」へ追記してコミット: `docs(spec): ソース ZIP 搬入の E2E 実測を記録`。

## 完了条件

- Pester 48 件緑、`check:comments` 0、`ci:offline` 緑。
- Release に `source.zip` / `.sha256` が並び、遮断端末相当のフォルダで初回・更新の両方が完走（Task 6）。
- push はユーザーへ依頼（各コミットの auto-push 失敗時は `git push`）。
