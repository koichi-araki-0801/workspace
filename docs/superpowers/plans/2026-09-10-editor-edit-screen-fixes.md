# editor 編集画面 6 件 + offline fetch/setup 分離 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 編集画面で「選択しただけで未確定 / 往復後の赤入れ誤検知・コメント消失 / Undo で戻しても未確定 / 往復で UI 状態が消える / 起動時に画面へフィット / コメント種別」の 6 件を直し、オフライン構築の HTTPS 取得と展開を別スクリプトに分ける。

**Architecture:** 保存内容（`getBodyHtml` + `getCss`）から GrapesJS 由来の揮発物（自動 id・protectedCss）を排し、幾何は inline `style` 属性に保存する。「未確定」は保存内容と確定版正規形の**内容比較**で決め、UI 状態は編集セッション（localStorage 永続。`allowEdit` と選択はメモリのみ）に持つ。offline は `fetch-offline-bundle`（取得・検証・配置）と `setup-offline`（展開・構築。取得しない）の 2 段にする。

**Tech Stack:** Vue 3 + GrapesJS 0.23.2 + Pinia / Fastify + Zod / Vitest（jsdom で GrapesJS 実体起動）+ Playwright / PowerShell 5.1 + Pester 3.4

**Spec:** `docs/superpowers/specs/2026-09-10-editor-edit-screen-fixes-dig.md`（決定 Q1〜Q14・却下案・残リスク）

## Global Constraints

- 編集 2 系統の原則（編集タブ = `tpl.filled` + ハイライト無し / 作成タブ = `toFilled` + ハイライト有り）を崩さない。`twoSystems.guard.test.ts` を含む `pnpm test` を通す。
- `editor/**` を変更したコミット前に `pnpm exec biome check --write editor/<対象>` を先行実行する（lint-staged のステージ入れ替わり事故の回避）。
- `.ps1` は UTF-8 BOM + CRLF、`.bat` は ASCII + CRLF、`.ps1` には同名 `.bat` を併設（dot-source ライブラリは `scripts/check-comments.py` の免除リストへ）。
- コメント規約は `docs/コメント規約.md`。経緯（変更日・前回実装への言及）はコードコメントに書かない。
- 前回 revert した履歴 `10befc4..bb95201` は**そのまま cherry-pick しない**（幾何を壊す退行を含む）。参照は可。
- push はユーザーに `!` で依頼する（pre-push CI 11〜12 分 > 背景実行 10 分）。commit 後の auto-push フックは走るが、失敗時は手動 push を頼む。
- 各タスクは RED → GREEN → REFACTOR。テストが先。
- Python の起動は `py -3.13`。

## File Structure

| 区分 | ファイル | 責務 |
|---|---|---|
| 新規 | `offline/lib/fetch.ps1` | Release からの取得 → `.sha256` 検証 → 配置（downloader 差し替え可） |
| 新規 | `offline/fetch-offline-bundle.ps1` / `.bat` | 取得の入口（引数 `-Owner/-Repo/-Tag`） |
| 変更 | `offline/setup-offline.ps1` / `.bat` | 取得経路を撤去。手元バンドル必須 |
| 変更 | `offline/lib/verify.Tests.ps1` | `Save-VerifiedReleaseBundle` の Pester |
| 変更 | `editor/web/src/features/editor/useGrapes.ts` | `avoidInlineStyle:false`・`protectedCss:''`・`getBodyHtml` の id 除去・`load({quiet})`・`applyInitialZoom`・`setInitialZoom` |
| 変更 | `editor/web/src/features/editor/grapesEvents.ts` | `SAVE_NEUTRAL_PROPS` 濾過・`applyInitialZoom` |
| 新規 | `editor/web/src/lib/confirmedCanonical.ts` | 確定版正規形の localStorage キャッシュ（純関数） |
| 変更 | `editor/web/src/features/editor/useTemplateEditor.ts` | 内容比較 dirty（`settleIfClean`）・UI 状態の写し・`partLabels` |
| 変更 | `editor/web/src/stores/editorSession.ts` | `ui`（永続 / メモリ）・Undo ミラー版数 |
| 変更 | `editor/web/src/lib/storageKeys.ts` | Undo ミラー `:v2`・正規形キャッシュキー・UI 状態キー |
| 変更 | `editor/web/src/features/editor/EditorView.vue` | resize 据え置き・`paneTab`/`showPageGuides` の永続 |
| 変更 | `editor/web/src/features/editor/useZoomFit.ts` | doc コメントのみ |
| 変更 | `editor/shared/src/schemas.ts` 他 | `kind` 撤去 |
| 変更 | `docs/editor/src/設計正典.md` | 不変則の追記（各タスクで） |

## Task 0: Spike — protectedCss を外した canvas と PDF の実機比較

**Files:**
- Modify (一時): `editor/web/src/features/editor/useGrapes.ts:357`（`grapesjs.init` に `protectedCss: ''` を仮追加）
- Record: `docs/superpowers/specs/2026-09-10-editor-edit-screen-fixes-dig.md`「Q14」行に結論を追記

**Interfaces:**
- Produces: `CANVAS_BASE_CSS`（Task 2 で `useGrapes.ts` の `a4CanvasCss` へ足す規則。空 / `body{margin:0}` のどちらか）

- [ ] **Step 1: `protectedCss: ''` を仮当てして dev を起動**

`useGrapes.ts` の `grapesjs.init({ ... jsInHtml: false, })` に `protectedCss: '',` を足す（コミットしない）。`editor\start.bat dev local` で起動。

- [ ] **Step 2: 同一テンプレを編集画面とプレビューで並べる**

`/edit/AM01_510037_20240710_交付版` と `/preview/AM01_510037_20240710_交付版` を別タブで開き、1 ページ目の表紙ブロック・表・脚注の 3 箇所を目視比較する。差があれば Chrome DevTools で canvas iframe の `body` の computed `margin` と代表要素の `box-sizing` を記録する。

- [ ] **Step 3: 結論を決めて記録**

- 差が無い → `CANVAS_BASE_CSS = ''`（何も足さない）。
- `body` の 8px 余白だけが差 → `CANVAS_BASE_CSS = 'body { margin: 0; }'`（PDF は `@page` 余白で描くため canvas 側だけ余白ゼロにしないと紙面枠と 8px ずれる）。
- `box-sizing` の差で幅が崩れる → per-fund CSS 側に `* { box-sizing: border-box }` が無いのが原因。**canvas に足さず**、テンプレ CSS の問題として spec「残リスク」へ「per-fund CSS に box-sizing が無い」と記録し、Task 2 では `CANVAS_BASE_CSS` に含めない（PDF と揃える方針を優先）。

spec の Q14 行を `計画先頭の実機比較 spike で決める` → 実測結果と `CANVAS_BASE_CSS` の値に書き換える。

- [ ] **Step 4: 仮変更を戻してコミット**

```bash
git checkout -- editor/web/src/features/editor/useGrapes.ts
git add docs/superpowers/specs/2026-09-10-editor-edit-screen-fixes-dig.md
git commit -m "docs(spec): protectedCss を外した canvas と PDF の実機比較の結果(canvasCss に残す規則)"
```

---

## Task 1: ④ offline — fetch（取得）と setup（展開）の分離

**Files:**
- Create: `offline/lib/fetch.ps1`
- Create: `offline/fetch-offline-bundle.ps1`, `offline/fetch-offline-bundle.bat`
- Modify: `offline/setup-offline.ps1`（ヘッダ・`param`・`$AssetBase`・`Download-File`・`[1/5]`・`[5/5]`）、`offline/setup-offline.bat`（rem 行）
- Modify: `offline/lib/verify.Tests.ps1`（末尾に Describe 追加、先頭で `fetch.ps1` を dot-source）
- Modify: `scripts/check-comments.py:111`（免除リストへ `offline/lib/fetch.ps1`）
- Modify: `offline/README-offline.txt`、`README.md`（入口一覧・「最初に覚える 3 コマンド」・dot-source ライブラリ注記）、`docs/editor/src/デプロイ運用手順書.md:26`
- Regenerate: `py -3.13 docs/_build/build_all.py --project editor`（デプロイ運用手順書は `editor_設計.html` に含まれる）

**Interfaces:**
- Produces: `Save-VerifiedReleaseBundle -AssetBase <url> -BundleName <name> -Destination <dir> [-Downloader <scriptblock (url, dest)>]` → `@{ Bundle; Key }`。`Invoke-ReleaseDownload -Url -Destination`（既定 downloader。curl.exe があれば curl、無ければ `Invoke-WebRequest`）。
- Consumes: `verify.ps1` の `Get-Sha256FromSidecar -Path`、`Assert-FileSha256 -File -ExpectedSha256 -Label`。

- [ ] **Step 1: Pester の RED を書く**

`offline/lib/verify.Tests.ps1` の先頭 dot-source に `. (Join-Path $here 'fetch.ps1')` を足し、末尾に追加:

```powershell
Describe 'Save-VerifiedReleaseBundle（取得 → 検証 → 配置。検証前の取得物を配置先に残さない）' {
  BeforeEach {
    # Release のアセット置き場を模す(downloader は URL 末尾のファイル名で src から写す)。
    $script:src  = Join-Path $TestDrive ('src-' + [guid]::NewGuid().ToString('N'))
    $script:dest = Join-Path $TestDrive ('dest-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $script:src, $script:dest -Force | Out-Null
    $script:name = 'offline-deps-bundle.tar.gz'
    $bundle = Join-Path $script:src $script:name
    Set-Content -LiteralPath $bundle -Value 'bundle payload' -Encoding Ascii
    $hash = (Get-FileHash -LiteralPath $bundle -Algorithm SHA256).Hash.ToLower()
    Set-Content -LiteralPath "$bundle.sha256" -Value "$hash  $($script:name)" -Encoding Ascii
    Set-Content -LiteralPath (Join-Path $script:src 'bundle.key') -Value 'abc123' -Encoding Ascii
    $script:copyFrom = {
      param([string]$url, [string]$to)
      Copy-Item -LiteralPath (Join-Path $script:src (Split-Path $url -Leaf)) -Destination $to
    }
    $script:tempBefore = @(Get-ChildItem ([IO.Path]::GetTempPath()) -Directory -Filter 'offline-fetch-*').Count
  }

  It '検証を通った 3 ファイル(バンドル / .sha256 / bundle.key)を Destination へ置き、そのパスを返す' {
    $r = Save-VerifiedReleaseBundle -AssetBase 'https://example/rel' -BundleName $script:name `
      -Destination $script:dest -Downloader $script:copyFrom
    $r.Bundle | Should Be (Join-Path $script:dest $script:name)
    $r.Key | Should Be (Join-Path $script:dest 'bundle.key')
    (Test-Path -LiteralPath "$($r.Bundle).sha256") | Should Be $true
    (Get-Content -LiteralPath $r.Key -Raw).Trim() | Should Be 'abc123'
  }

  It 'sha256 が一致しなければ停止し、Destination に何も残さない' {
    Set-Content -LiteralPath (Join-Path $script:src "$($script:name).sha256") -Value (('a' * 64) + "  $($script:name)") -Encoding Ascii
    { Save-VerifiedReleaseBundle -AssetBase 'https://example/rel' -BundleName $script:name `
        -Destination $script:dest -Downloader $script:copyFrom } | Should Throw
    @(Get-ChildItem -LiteralPath $script:dest).Count | Should Be 0
  }

  It '取得そのものが失敗しても Destination に何も残さない' {
    $failing = { param([string]$url, [string]$to) throw "ダウンロードに失敗: $url" }
    { Save-VerifiedReleaseBundle -AssetBase 'https://example/rel' -BundleName $script:name `
        -Destination $script:dest -Downloader $failing } | Should Throw 'ダウンロードに失敗'
    @(Get-ChildItem -LiteralPath $script:dest).Count | Should Be 0
  }

  It '成功・失敗のどちらでも一時ディレクトリを残さない' {
    Save-VerifiedReleaseBundle -AssetBase 'https://example/rel' -BundleName $script:name `
      -Destination $script:dest -Downloader $script:copyFrom | Out-Null
    $failing = { param([string]$url, [string]$to) throw 'x' }
    try {
      Save-VerifiedReleaseBundle -AssetBase 'https://example/rel' -BundleName $script:name `
        -Destination $script:dest -Downloader $failing | Out-Null
    } catch {}
    @(Get-ChildItem ([IO.Path]::GetTempPath()) -Directory -Filter 'offline-fetch-*').Count | Should Be $script:tempBefore
  }

  It 'downloader へは AssetBase 直下の 3 つの URL を渡す' {
    $script:seen = @()
    $recording = {
      param([string]$url, [string]$to)
      $script:seen += $url
      & $script:copyFrom $url $to
    }
    Save-VerifiedReleaseBundle -AssetBase 'https://example/rel' -BundleName $script:name `
      -Destination $script:dest -Downloader $recording | Out-Null
    $expected = (@(
      "https://example/rel/$($script:name)",
      "https://example/rel/$($script:name).sha256",
      'https://example/rel/bundle.key') | Sort-Object) -join "`n"
    (($script:seen | Sort-Object) -join "`n") | Should Be $expected
  }
}
```

- [ ] **Step 2: RED を確認**

Run: `powershell -NoProfile -Command "Import-Module Pester -RequiredVersion 3.4.0 -Force; Invoke-Pester -Script offline/lib/verify.Tests.ps1"`
Expected: `fetch.ps1` が無く dot-source で失敗（CommandNotFoundException）。

- [ ] **Step 3: `offline/lib/fetch.ps1` を書く**

```powershell
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
    [scriptblock]$Downloader = ${function:Invoke-ReleaseDownload}
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

    New-Item -ItemType Directory -Path $Destination -Force | Out-Null
    $bundle = Join-Path $Destination $BundleName
    $key    = Join-Path $Destination 'bundle.key'
    Move-Item -LiteralPath $workFile -Destination $bundle          -Force
    Move-Item -LiteralPath $workSha  -Destination "$bundle.sha256" -Force
    Move-Item -LiteralPath $workKey  -Destination $key             -Force
    return @{ Bundle = $bundle; Key = $key }
  } finally {
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
  }
}
```

保存後に BOM + CRLF へ正規化する:

```powershell
foreach ($f in @('offline\lib\fetch.ps1','offline\lib\verify.Tests.ps1')) {
  $t = [IO.File]::ReadAllText($f, [Text.UTF8Encoding]::new($false)); $t = $t -replace "`r?`n", "`r`n"
  [IO.File]::WriteAllText($f, $t, [Text.UTF8Encoding]::new($true))
}
```

- [ ] **Step 4: GREEN を確認**

Run: 同上。Expected: `Passed 34 Failed 0`（既存 29 + 追加 5）。

- [ ] **Step 5: 入口スクリプト `offline/fetch-offline-bundle.ps1` と `.bat`**

```powershell
#requires -Version 5.1
<#
.SYNOPSIS
  オフライン重量物バンドルを GitHub Releases から HTTPS で取得し、リポジトリ直下へ置く。

.DESCRIPTION
  重量物（.pnpm-store / pnpm.tgz / ms-playwright / python-wheelhouse / git-tools /
  docs の mermaid JS / native-prebuilds）は git に入れず GitHub Releases（タグ offline-bundle-v1）に
  置いてある。本スクリプトは**取得だけ**を行う。展開と環境構築は setup-offline.bat の担当で、
  こちらはネットに出られる端末で実行し、取得物をリポジトリ直下（または bk\）に置いた状態で
  setup-offline.bat を実行する（ネットに出られない端末へは取得物 3 ファイルを持ち込む）。

  取得は一時ディレクトリで行い、Release の .sha256 と突き合わせた検証が通ってからだけ直下へ移す
  （検証前・失敗した取得物を直下に残さない。gh 不要。リポジトリは Public）。
  置くファイルは offline-deps-bundle.tar.gz / offline-deps-bundle.tar.gz.sha256 / bundle.key の 3 つ。

  バンドルの真正性は検証しない: 配布担当だけが Release を更新でき、配布先は同じ所有者の
  Public リポジトリを clone している前提で受け入れる。

.PARAMETER Owner
  GitHub オーナー名。既定 koichi-araki-0801。

.PARAMETER Repo
  リポジトリ名。既定 workspace。

.PARAMETER Tag
  重量物アセットの取得元タグ。既定 offline-bundle-v1。

.EXAMPLE
  offline\fetch-offline-bundle.bat
.EXAMPLE
  offline\fetch-offline-bundle.bat -Tag offline-bundle-v2
#>
[CmdletBinding()]
param(
  [string]$Owner = 'koichi-araki-0801',
  [string]$Repo  = 'workspace',
  [string]$Tag   = 'offline-bundle-v1'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'lib\verify.ps1')
. (Join-Path $PSScriptRoot 'lib\fetch.ps1')

$RepoRoot   = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$BundleName = 'offline-deps-bundle.tar.gz'
$AssetBase  = "https://github.com/$Owner/$Repo/releases/download/$Tag"
Write-Host "[info] repo root: $RepoRoot"
Write-Host "[1/1] Release $Tag から HTTPS で取得します..."
try {
  $r = Save-VerifiedReleaseBundle -AssetBase $AssetBase -BundleName $BundleName -Destination $RepoRoot
} catch {
  Write-Error "[error] $($_.Exception.Message)`n  タグ / ネットワーク / リポジトリの公開状態を確認してください。"
  exit 1
}
Write-Host "[info] 配置: $($r.Bundle)"
Write-Host "[info] 配置: $($r.Bundle).sha256"
Write-Host "[info] 配置: $($r.Key)"
Write-Host '[OK] 取得完了。続けて offline\setup-offline.bat を実行してください。'
exit 0
```

`offline/fetch-offline-bundle.bat`（ASCII のみ）:

```bat
@echo off
chcp 65001 >nul
title Offline bundle - fetch from GitHub Releases
rem Launches fetch-offline-bundle.ps1 with ExecutionPolicy Bypass (args forwarded).
rem Downloads the offline bundle (tar.gz / .sha256 / bundle.key) from GitHub Releases over
rem HTTPS into the repo root. Run this on a machine with network access, then run
rem setup-offline.bat (which never downloads by itself).
rem   fetch-offline-bundle.bat                    fetch tag offline-bundle-v1
rem   fetch-offline-bundle.bat -Tag <tag>         fetch another release tag
rem ASCII only on purpose: cmd garbles multi-byte rem/title lines in .bat files.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0fetch-offline-bundle.ps1" %*
exit /b %ERRORLEVEL%
```

両方を CRLF（`.ps1` は BOM 付き）へ正規化する（Step 3 と同じ PowerShell）。

- [ ] **Step 6: `setup-offline.ps1` から取得経路を撤去**

1. `.DESCRIPTION` の手順 1 を「バンドルの確認。直下または bk\ に組が揃っていればそれを使う。無ければ fetch-offline-bundle.bat を案内して中止（取得を肩代わりしない）」へ、手順 4 を「直下に置かれていたバンドルを bk\ へ退避する（bk\ のものを使った回は動かさない）」へ書き換える。`.PARAMETER Owner/Repo/Tag` を削除。`.PARAMETER SkipBuild` の「取得・展開・整合検査」を「展開・整合検査」へ。
2. `param(` から `$Owner/$Repo/$Tag` を削除。`$AssetBase` 行を削除。
3. `Download-File` 関数と `[1/5]` ブロック全体を次に置換:

```powershell
# ---- [1/5] バンドルの確認（取得はしない） ----
Write-Host '[1/5] バンドルを確認...'
# リポジトリ直下 → bk\ の順で、バンドルと bundle.key が同じディレクトリに揃っている組だけを使う。
# 取得は fetch-offline-bundle.bat の担当。ここで肩代わりすると「ネットに出ない」前提が崩れ、
# ネットに出られない端末で原因の見えにくい失敗になる。
$local = Find-LocalBundlePair -Directories @($RepoRoot, $Bk) -BundleName $BundleName
if (-not $local) {
  Write-Error ("[error] リポジトリ直下にも bk\ にも $BundleName と bundle.key の組がありません。" +
    "`n  ネットに出られる端末で offline\fetch-offline-bundle.bat を実行して取得し、" +
    "`n  3 ファイル（$BundleName / $BundleName.sha256 / bundle.key）をリポジトリ直下に置いてから再実行してください。")
  exit 1
}
$Bundle  = $local.Bundle
$KeyFile = $local.Key
# 直下のバンドルを使った回だけ、完了後に bk\ へ退避する（bk\ のものはそのまま）。
$fromRoot = ((Split-Path $Bundle -Parent).TrimEnd('\') -eq $RepoRoot.TrimEnd('\'))
Write-Host "[info] 手元のバンドルを使います: $Bundle"
```

4. `[4/5] -SkipBuild:` の文言から「取得・」を落とす。`[5/5]` は `if ($downloaded)` → `if ($fromRoot)`、見出しを「直下のバンドルを bk\ へ退避（bk\ のものを使った回は動かさない）」、メッセージを「直下のバンドルを bk/ へ退避...」へ。
5. `setup-offline.bat` の rem 行を「Prerequisite: repo is git-cloned and the bundle (tar.gz / .sha256 / bundle.key) is at the repo root (or bk\). This script never downloads; fetch first with fetch-offline-bundle.bat on a machine with network access.」へ書き換える。

- [ ] **Step 7: 構文と実挙動の確認**

```powershell
foreach ($f in @('offline\setup-offline.ps1','offline\fetch-offline-bundle.ps1','offline\lib\fetch.ps1')) {
  $errs = $null; [System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path $f), [ref]$null, [ref]$errs) | Out-Null
  "$f : $(@($errs).Count) parse errors"
}
# 一時コピーで「バンドル無し → exit 1 + fetch の案内」「不正タグ → 404 で exit 1、直下に残骸なし」を確認
$tmp = Join-Path $env:TEMP ('setupprobe-' + [guid]::NewGuid().ToString('N')); New-Item -ItemType Directory -Path $tmp | Out-Null
Copy-Item offline -Destination (Join-Path $tmp 'offline') -Recurse; Copy-Item pnpm-lock.yaml, package.json -Destination $tmp
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $tmp 'offline\setup-offline.ps1') -SkipBuild; "SETUP EXIT $LASTEXITCODE"
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $tmp 'offline\fetch-offline-bundle.ps1') -Tag no-such-tag-xyz; "FETCH EXIT $LASTEXITCODE"
Get-ChildItem $tmp -File | Select-Object -ExpandProperty Name; Remove-Item $tmp -Recurse -Force
```

Expected: parse errors 0 / SETUP EXIT 1（案内文あり）/ FETCH EXIT 1 / 直下は `package.json` `pnpm-lock.yaml` のみ。

- [ ] **Step 8: 免除リストと docs**

- `scripts/check-comments.py` の `bat_pairing_exceptions` に `"offline/lib/fetch.ps1",` を追加。
- `README.md`: 「セットアップ: `offline\setup-offline.bat`（…自動取得）」→「`offline\fetch-offline-bundle.bat`（重量物を Release から取得）→ `offline\setup-offline.bat`（展開・構築はネット不要）」。入口一覧の表に `offline/fetch-offline-bundle.bat` の行を追加し、`setup-offline.bat` の役割を「手元の重量物バンドルを展開して構築（取得はしない。無ければ fetch を案内して停止）」へ。dot-source ライブラリの注記に `offline/lib/fetch.ps1` を追加。
- `offline/README-offline.txt`: 手順を「1) clone 2) fetch（ネット接続端末） 3) setup（ネット不要） 4) 動作確認」へ。前提に「取得だけは HTTPS で GitHub に出られること」。トラブルシュートに「setup が『組がありません』で止まる → fetch を先に実行」。
- `docs/editor/src/デプロイ運用手順書.md` 26 行目の手順 2 を「fetch で取得 → setup で展開」の 2 段へ。
- `pnpm run check:comments` → 0 error。`py -3.13 docs/_build/build_all.py --project editor` で HTML 再生成（`editor_設計.html` が変わる。`editor_手引き.html` は EOL 差分のみなら `git checkout -- ` で戻す）。

- [ ] **Step 9: コミット**

```bash
git add README.md offline scripts/check-comments.py "docs/editor/src/デプロイ運用手順書.md" "docs/editor/editor_設計.html"
git commit -m "chore(offline): 重量物バンドルの HTTPS 取得と展開を別スクリプトに分ける"
```

---

## Task 2: 保存形式 — 幾何を inline style へ、自動 id と protectedCss を保存内容から排除

**Files:**
- Modify: `editor/web/src/features/editor/useGrapes.ts`（`grapesjs.init` config、`a4CanvasCss`、`getBodyHtml`）
- Modify: `editor/web/src/features/editor/geom.ts:1-6`（doc コメント）
- Modify: `editor/web/src/lib/storageKeys.ts`（Undo ミラー `:v2`）
- Modify: `editor/web/src/api/local/store.ts:167`、`editor/web/src/stores/auth.ts:95`（旧 v1 キーの後片付け）
- Test: `editor/web/test/saveFormat.dom.test.ts`（新規）、`editor/web/test/editorSession.dom.test.ts`
- Modify: `docs/editor/src/設計正典.md`「中核原則」
- 別リポ `editor-data`: `css/510037.css`、`templates/AM01_510037_20240710_kr.html`、`drafts/`

**Interfaces:**
- Produces: `useGrapes().getBodyHtml()` は明示属性に無い `id` を含まない / `getCss()` に `box-sizing` `body{margin` を含まない / `patchSelectedStyle` は inline `style` 属性へ書く。`storageKeys.undoStacksKey()` = `editor:session:undo:v2:<scope>`、`LEGACY_UNDO_STACKS_KEYS()` = 旧キー配列。
- Consumes: Task 0 の `CANVAS_BASE_CSS`。

- [ ] **Step 1: RED — 保存形式の単体テスト（jsdom で GrapesJS 実体）**

`editor/web/test/saveFormat.dom.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { useGrapes } from '@/features/editor/useGrapes';

// =============================================================================
// saveFormat.dom.test.ts — 保存内容(getBodyHtml / getCss)に GrapesJS 由来の揮発物を載せない
// =============================================================================
// 幾何は inline style 属性に保存し、自動 id(ccid)と protectedCss は保存内容に出さない。
// 自動 id が draft / Undo snapshot に混入すると再読込で確定版と構造キーが一致せず、編集して
// いない箇所が赤入れになりコメントの宛先が「削除済みパーツ」になる。protectedCss は load の
// たび規則として積み増す。幾何を CssRule(#id)に書くと自動 id が保存内容の一部になってしまう。

const DOC = '<div class="page"><p class="cover-category" data-part-id="cat">見出し</p><p class="body" id="fixed-1">本文</p></div>';

describe('保存形式', () => {
  let g: ReturnType<typeof useGrapes>;
  beforeEach(() => {
    g = useGrapes();
    g.init({ canvas: document.createElement('div'), layers: document.createElement('div') });
    g.load(DOC, '.body { color: red; }');
  });

  function select(selector: string) {
    const ed = g.editor.value!;
    const comp = ed.getWrapper()!.find(selector)[0];
    ed.select(comp);
    return comp;
  }

  it('選択しただけでは getBodyHtml に自動 id が現れない', () => {
    select('.cover-category');
    expect(g.getBodyHtml()).not.toMatch(/ id="i[a-z0-9]+"/);
  });

  it('テンプレ由来の明示 id は残る', () => {
    select('.body');
    expect(g.getBodyHtml()).toContain('id="fixed-1"');
  });

  it('幾何の編集は inline style 属性へ書かれ、保存 → 再読込で残る', () => {
    select('.cover-category');
    g.patchSelectedStyle({ width: '50%', 'margin-top': '10mm' });
    const html = g.getBodyHtml();
    expect(html).toMatch(/class="cover-category"[^>]*style="[^"]*width:\s*50%/);
    expect(html).not.toMatch(/ id="i[a-z0-9]+"/);
    expect(g.getCss()).not.toMatch(/#i[a-z0-9]+\s*\{/);
    g.load(html, g.getCss());
    select('.cover-category');
    expect(g.selectedStyle()).toMatchObject({ width: '50%', 'margin-top': '10mm' });
  });

  it('getCss に protectedCss(box-sizing / body margin)が現れず、load を繰り返しても増えない', () => {
    const css1 = g.getCss();
    expect(css1).not.toMatch(/box-sizing/);
    expect(css1).not.toMatch(/body\s*\{\s*margin/);
    g.load(g.getBodyHtml(), css1);
    expect(g.getCss()).toBe(css1);
  });
});
```

`editorSession.dom.test.ts` に追加:

```ts
  it('Undo ミラーのキーは v2 で、旧形式のミラーは読まない', () => {
    localStorage.setItem('editor:session:undo:local', JSON.stringify({ t1: { past: [{ html: 'old', css: '' }], future: [] } }));
    const store = useEditorSessionStore();
    expect(store.ensure('t1').undoPast).toEqual([]);
    expect(undoStacksKey()).toBe('editor:session:undo:v2:local');
  });
```

- [ ] **Step 2: RED を確認**

Run: `cd editor/web && pnpm exec vitest run test/saveFormat.dom.test.ts test/editorSession.dom.test.ts`
Expected: 「選択しただけ」「幾何」「protectedCss」「v2」の 4 件が FAIL。

- [ ] **Step 3: `useGrapes.ts` の実装**

`grapesjs.init` config に追加（`jsInHtml: false,` の直後）:

```ts
      // 幾何(幅・余白)は inline `style` 属性に保存する。既定の `avoidInlineStyle:true` は
      // `setStyle` を `#<自動id>{…}` の CssRule へ書き、自動 id が保存内容の一部になる —
      // 再読込で確定版と構造キーが一致しなくなり、ペア同期(パーツ HTML だけ転写)で幾何が
      // 転写されない。inline ならパーツと一体で、id に依存しない。
      avoidInlineStyle: false,
      // canvas の下地 CSS(既定は `* { box-sizing: border-box } body { margin: 0 }`)は PDF 側
      // の CSS に無く、canvas と PDF の見た目が食い違う。`getCss()` の先頭にも付いて保存 CSS へ
      // 混入し、load のたび規則として積み増す。空にして PDF と同じ CSS で描く(必要な下地は
      // `a4CanvasCss` に明示する)。
      protectedCss: '',
```

`a4CanvasCss` の先頭に Task 0 の `CANVAS_BASE_CSS`（`''` なら何も足さない。`body { margin: 0; }` なら `html { background: transparent; }` の次行に置く）。

`getBodyHtml` を置換:

```ts
  /**
   * 保存用の body HTML。GrapesJS は選択したパーツに StyleManager の id セレクタを作り、以後
   * `getHtml()` が自動 id(`ccid`)を属性として出力する。その id が draft / Undo snapshot に
   * 混入すると、再読込で確定版と構造キー(`partKey` / 赤入れ)が一致しなくなる。テンプレ由来の
   * id はモデルの明示属性に載っているので、明示属性に無い id だけを落とす。
   */
  function getBodyHtml(): string {
    return (
      editor.value?.getHtml({
        attributes: (comp, attrs) => {
          const explicit = (comp.get('attributes') as Record<string, unknown> | undefined)?.id;
          if (typeof explicit !== 'string' || explicit === '') delete attrs.id;
          return attrs;
        },
      }) ?? ''
    );
  }
```

`geom.ts` 冒頭の役割コメントは「GrapesJS inline style」のままで実態と一致するので変更不要（`avoidInlineStyle:false` で inline になる）。

- [ ] **Step 4: Undo ミラーの版数**

`storageKeys.ts`:

```ts
const UNDO_STACKS_PREFIX = 'editor:session:undo:v2';
// v2 より前のミラー。自動 id と protectedCss が snapshot に混入しており、読み込むと確定版との
// 内容比較が永久に外れる。後片付け(logout / スキーマ bump)でのみ参照する。
const UNDO_STACKS_PREFIX_V1 = 'editor:session:undo';
export const LEGACY_UNDO_STACKS_KEY = UNDO_STACKS_PREFIX_V1;
/** 現在のユーザー向け v1 ミラーキー(後片付け用)。 */
export function legacyUndoStacksKeyV1(): string {
  return `${UNDO_STACKS_PREFIX_V1}:${userScope()}`;
}
```

`api/local/store.ts` の `WORKING_KEYS` 相当の配列（167 行付近）に `legacyUndoStacksKeyV1()` を追加、`stores/auth.ts:95` の logout で `localStorage.removeItem(legacyUndoStacksKeyV1())` を追加。

- [ ] **Step 5: GREEN を確認 + 関連テスト**

Run: `cd editor/web && pnpm exec vitest run test/saveFormat.dom.test.ts test/editorSession.dom.test.ts test/inspectorGeom.dom.test.ts test/useGeomHandles.dom.test.ts test/canvasActiveContent.guard.dom.test.ts`
Expected: 全 PASS。`inspectorGeom.dom.test.ts` は偽 editor を使うので `avoidInlineStyle` の影響なし。

Run: `pnpm run typecheck`。

- [ ] **Step 6: e2e の既存赤入れテストが通ることを確認**

Run: `cd editor && pnpm exec playwright test e2e/canvas.spec.ts --project chromium`
Expected: 5 件 PASS（幾何ハンドルの e2e があれば併せて）。

- [ ] **Step 7: 設計正典へ追記**

`docs/editor/src/設計正典.md`「中核原則」の「編集キャンバスの赤入れ表示」項の次に:

```markdown
- **保存内容に GrapesJS 由来の揮発物を載せない**: 幾何（幅・余白）は inline `style` 属性に
  保存する（`avoidInlineStyle:false`。CssRule `#id` は使わない — 自動 id が保存内容の一部になる）。
  `getBodyHtml()` は明示属性に無い `id` を落とす（選択で StyleManager が id セレクタを作ると
  `getHtml()` が自動 id を出力し、draft / Undo snapshot に混入して再読込で構造キーが合わなくなる）。
  canvas に GrapesJS の `protectedCss` を当てない（`protectedCss:''`。PDF と同じ CSS で描く。
  保存 CSS へ混入して load のたび積み増すのを止める）。Undo ミラーは `:v2`（旧ミラーは読まない）。
  機械検証は `web/test/saveFormat.dom.test.ts`。
```

「してはならないこと」へ: 「自動 id を保存内容に載せる / protectedCss を保存 CSS に載せる / 旧 Undo ミラーを正規化で救う（明示属性化した自動 id はテンプレ由来 id と判別できない）」。

- [ ] **Step 8: editor-data の汚染修正（別リポ）**

`../editor-data` で `css/510037.css` 先頭の `* { box-sizing: border-box; } body {margin: 0;}` 2 規則を削除し、`templates/AM01_510037_20240710_kr.html` の `<h2 id="i8kcl">` から ` id="i8kcl"` を削除。`drafts/` 配下の draft ファイルを削除。`git -C ../editor-data commit -am "fix: 承認で混入した GrapesJS の protectedCss と自動 id を除く"`。

- [ ] **Step 9: コミット**

```bash
pnpm exec biome check --write editor/web/src editor/web/test
git add editor/web/src/features/editor/useGrapes.ts editor/web/src/lib/storageKeys.ts editor/web/src/api/local/store.ts editor/web/src/stores/auth.ts editor/web/test/saveFormat.dom.test.ts editor/web/test/editorSession.dom.test.ts "docs/editor/src/設計正典.md"
git commit -m "fix(editor): 幾何を inline style に保存し、自動 id と protectedCss を保存内容から排除する"
```

---

## Task 3: dirty 機構（③ 選択だけで未確定 / ⑥ Undo で同一なら変更なし）

**Files:**
- Create: `editor/web/src/lib/confirmedCanonical.ts`
- Modify: `editor/web/src/lib/storageKeys.ts`（`confirmedCanonicalKey()`）
- Modify: `editor/web/src/features/editor/grapesEvents.ts`（`SAVE_NEUTRAL_PROPS`・`onComponentUpdate`）
- Modify: `editor/web/src/features/editor/useGrapes.ts`（`load(html, css, { quiet })`）
- Modify: `editor/web/src/features/editor/useTemplateEditor.ts`（`confirmedCanonical`・`markChanged`・`settleIfClean`・`partLabels`）
- Test: `editor/web/test/confirmedCanonical.dom.test.ts`（新規）、`editor/web/test/grapesEvents.test.ts`、`editor/e2e/canvas.spec.ts`
- Modify: `docs/editor/src/設計正典.md`

**Interfaces:**
- Produces: `readConfirmedCanonical(templateId, updatedAt) → {html, css} | null`、`writeConfirmedCanonical(templateId, updatedAt, {html, css})`（`lib/confirmedCanonical.ts`）。`useGrapes().load(html, css, { quiet?: boolean })`。`grapesEvents` の `SAVE_NEUTRAL_PROPS`。
- Consumes: Task 2 の `getBodyHtml/getCss`（揮発物なし）。

- [ ] **Step 1: RED — 正規形キャッシュの単体テスト**

`editor/web/test/confirmedCanonical.dom.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { readConfirmedCanonical, writeConfirmedCanonical } from '@/lib/confirmedCanonical';

describe('confirmedCanonical — 確定版正規形の localStorage キャッシュ', () => {
  beforeEach(() => localStorage.clear());

  it('templateId と updatedAt が一致するときだけ返す', () => {
    writeConfirmedCanonical('t1', '2026-09-01T00:00:00.000Z', { html: '<p>a</p>', css: '.a{}' });
    expect(readConfirmedCanonical('t1', '2026-09-01T00:00:00.000Z')).toEqual({ html: '<p>a</p>', css: '.a{}' });
    expect(readConfirmedCanonical('t1', '2026-09-02T00:00:00.000Z')).toBeNull();
    expect(readConfirmedCanonical('t2', '2026-09-01T00:00:00.000Z')).toBeNull();
  });

  it('updatedAt が null の版はキャッシュしない(毎回フォールバック)', () => {
    writeConfirmedCanonical('t1', null, { html: 'x', css: '' });
    expect(readConfirmedCanonical('t1', null)).toBeNull();
  });

  it('壊れた JSON は空として扱い、書き込み失敗(quota)は投げない', () => {
    localStorage.setItem('editor:confirmed:v1:local', '{broken');
    expect(readConfirmedCanonical('t1', 'x')).toBeNull();
    const big = 'x'.repeat(6 * 1024 * 1024);
    expect(() => writeConfirmedCanonical('t1', 'x', { html: big, css: '' })).not.toThrow();
  });
});
```

- [ ] **Step 2: RED — grapesEvents の単体テスト**

`grapesEvents.test.ts` の `setup()` と lock-state テストの deps にある `fitToView: vi.fn(),` を `applyInitialZoom: vi.fn(),` へ改名（Task 4 で使う。ここでは型のみ）し、末尾に追加:

```ts
// パーツをクリック選択すると Layers が祖先へ `open:true` を、GrapesJS が `status` を set し、
// どちらも `component:update` を発火させる。保存内容に現れない UI 状態なので dirty/autosave へ
// 流さない(主防御は内容比較。これは即時応答用の補助)。内容の変更は従来どおり届く。
describe('wireGrapesEvents — 保存内容に現れない prop だけの component:update', () => {
  function emitUpdate(ed: ReturnType<typeof makeFakeEditor>, changed: Record<string, unknown>) {
    ed.emit('component:update', { changed });
  }

  it('open / status だけの更新は change を呼ばず、revision は進む', () => {
    stubRaf();
    const { ed, spies, revision } = setup();
    emitUpdate(ed, { open: true });
    emitUpdate(ed, { status: 'selected' });
    emitUpdate(ed, { open: true, status: 'hovered' });
    expect(spies.change).not.toHaveBeenCalled();
    expect(revision.value).toBe(3);
  });

  it('内容の変更を含む更新は change を呼ぶ(UI 状態と混ざっていても)', () => {
    stubRaf();
    const { ed, spies } = setup();
    emitUpdate(ed, { content: 'x' });
    emitUpdate(ed, { open: true, attributes: { id: 'a' } });
    expect(spies.change).toHaveBeenCalledTimes(2);
  });

  it('changed が読めない発火(引数なし / 空)は保守的に change を呼ぶ', () => {
    stubRaf();
    const { ed, spies } = setup();
    ed.emit('component:update');
    emitUpdate(ed, {});
    expect(spies.change).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 3: RED — e2e 1 本目（往復統合）**

`editor/e2e/canvas.spec.ts` の import に `selectPart` を足し、末尾に追加:

```ts
// ③⑥: 選択だけでは未確定にならず、編集後の往復で赤入れは編集箇所だけ、コメントは削除済み扱いに
// ならず、Undo で確定版と同じ内容へ戻れば「変更なし」に戻り draft も消える。
test('往復統合: 選択のみ非 dirty / 往復後の赤入れとコメント / Undo で変更なし', async ({ page }) => {
  test.setTimeout(150_000);
  await login(page);
  const frame = await openEditor(page);

  // 選択しただけでは未確定にならず draft も作られない
  await selectPart(frame, frame.locator('.page > *').nth(4));
  await selectPart(frame, frame.locator('.page > *').nth(2));
  await page.waitForTimeout(2_000);
  await expect(page.getByText('変更なし', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('editor:drafts'))).toBeNull();

  // コメントを付け(選択が要る)、別パーツを 1 語置換
  await selectPart(frame, frame.locator('.page > *').nth(4));
  await page.locator('[data-pane-tab="comments"]').click();
  await page.getByPlaceholder('このパーツへのコメントを書く').fill('往復テスト');
  await page.locator('button[data-add-submit]').click();
  await expect(page.locator('[data-comment-row]', { hasText: '往復テスト' })).toBeVisible();
  await page.getByRole('button', { name: '閲覧のみ(クリックで編集を許可)' }).click();
  await replaceWord(page, frame, '受益者のみなさまへ', 'みなさま', '皆様');
  await expect(frame.locator('del[data-redline]', { hasText: 'みなさま' }).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('header [role="status"]')).toHaveAttribute('title', /に自動保存/, { timeout: 15_000 });

  // プレビューへ行って戻る
  await page.getByRole('button', { name: 'プレビュー' }).click();
  await page.waitForURL(/\/preview\//);
  await page.getByRole('button', { name: 'エディターに戻る' }).click();
  await page.waitForURL(/\/edit\//);
  const back = page.frameLocator('iframe.gjs-frame');
  await back.locator('.page').first().waitFor({ state: 'visible', timeout: 30_000 });
  await expect(back.locator('del[data-redline]', { hasText: 'みなさま' })).toHaveCount(1, { timeout: 15_000 });
  await expect(back.locator('[data-redline]')).toHaveCount(1);
  await expect(page.locator('.note-marker')).toHaveCount(1, { timeout: 15_000 });
  await page.locator('[data-pane-tab="comments"]').click();
  await expect(page.locator('[data-comment-row]', { hasText: '削除済み' })).toHaveCount(0);

  // Undo で確定版と同じ内容に戻れば「変更なし」、draft も消える
  await page.getByRole('button', { name: '閲覧のみ(クリックで編集を許可)' }).click();
  await page.getByRole('button', { name: '元に戻す' }).first().click();
  await expect(back.getByText('皆様')).toHaveCount(0, { timeout: 10_000 });
  await expect(page.getByText('変更なし', { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(back.locator('[data-redline]')).toHaveCount(0);
  await expect
    .poll(() => page.evaluate((id) => JSON.parse(localStorage.getItem('editor:drafts') ?? '{}')[id] ?? null, SEED_ID), { timeout: 15_000 })
    .toBeNull();
});

/** RTE でパラグラフ内の 1 語を置換する。 */
async function replaceWord(page: Page, frame: ReturnType<Page['frameLocator']>, needle: string, from: string, to: string) {
  await frame.getByText(needle).first().click();
  await page.evaluate((n) => {
    const doc = document.querySelector<HTMLIFrameElement>('iframe.gjs-frame')?.contentDocument;
    const p = [...(doc?.querySelectorAll('p') ?? [])].find((e) => (e.textContent ?? '').includes(n));
    p?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
  }, needle);
  const editing = frame.locator('[contenteditable="true"]').first();
  await expect(editing).toBeVisible({ timeout: 10_000 });
  await editing.evaluate((el, [f, t]) => {
    for (const n of Array.from(el.childNodes)) {
      if (n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').includes(f)) n.textContent = (n.textContent ?? '').replace(f, t);
    }
    el.dispatchEvent(new InputEvent('input', { bubbles: true }));
  }, [from, to]);
  await frame.locator('.page').first().click({ position: { x: 5, y: 5 } });
}
```

Undo 後に「編集を許可」を再度押している行は不要なら削る（Undo は閲覧のみでも押せる）。

- [ ] **Step 4: RED を確認**

Run: `cd editor/web && pnpm exec vitest run test/confirmedCanonical.dom.test.ts test/grapesEvents.test.ts` → confirmedCanonical は import 失敗、grapesEvents の 1 件目が FAIL。
Run: `cd editor && pnpm exec playwright test e2e/canvas.spec.ts --project chromium -g "往復統合"` → 「変更なし」で FAIL。

- [ ] **Step 5: `lib/confirmedCanonical.ts` と `storageKeys.ts`**

`storageKeys.ts` に追加:

```ts
const CONFIRMED_CANONICAL_PREFIX = 'editor:confirmed:v1';
/** 確定版正規形キャッシュのキー(ユーザー別。`lib/confirmedCanonical.ts`)。 */
export function confirmedCanonicalKey(): string {
  return `${CONFIRMED_CANONICAL_PREFIX}:${userScope()}`;
}
```

`lib/confirmedCanonical.ts`:

```ts
// =============================================================================
// confirmedCanonical.ts — 確定版正規形(HTML + CSS)の localStorage キャッシュ
// =============================================================================
// 役割: 「未確定」の判定基準になる確定版の正規形(canvas を通して GrapesJS 自身が直列化した
// 形)を templateId + updatedAt をキーに保持する。確定版から開いた初回に取り、draft 再開時は
// これを使って canvas の二重 load を避ける。updatedAt が変われば(承認で確定版が更新されれば)
// 使わない。null の版はキャッシュしない。読めない・書けないは「無い」として扱う(判定側が
// フォールバックする)。

import { confirmedCanonicalKey } from '@/lib/storageKeys';

export interface ConfirmedCanonical {
  html: string;
  css: string;
}

type CanonicalMap = Record<string, { updatedAt: string; html: string; css: string }>;

function readMap(): CanonicalMap {
  try {
    return JSON.parse(localStorage.getItem(confirmedCanonicalKey()) ?? '{}') as CanonicalMap;
  } catch {
    return {};
  }
}

export function readConfirmedCanonical(templateId: string, updatedAt: string | null): ConfirmedCanonical | null {
  if (!updatedAt) return null;
  const e = readMap()[templateId];
  if (!e || e.updatedAt !== updatedAt) return null;
  return { html: e.html, css: e.css };
}

export function writeConfirmedCanonical(templateId: string, updatedAt: string | null, value: ConfirmedCanonical): void {
  if (!updatedAt) return;
  const map = readMap();
  delete map[templateId]; // 削除→再追加でキー順の末尾 = 最近使用に置く
  map[templateId] = { updatedAt, ...value };
  try {
    localStorage.setItem(confirmedCanonicalKey(), JSON.stringify(map));
  } catch {
    // quota: 古い順に間引いて 1 回だけ再試行。それでも駄目なら諦める(判定はフォールバックする)。
    const keys = Object.keys(map);
    for (const k of keys.slice(0, Math.max(0, keys.length - 1))) delete map[k];
    try {
      localStorage.setItem(confirmedCanonicalKey(), JSON.stringify(map));
    } catch {
      /* 諦める */
    }
  }
}
```

`api/local/store.ts` の後片付け配列に `confirmedCanonicalKey()` を追加。

- [ ] **Step 6: `grapesEvents.ts`**

`wireGrapesEvents` の前に:

```ts
/**
 * `component:update` のうち dirty/autosave へ流さない prop。どれも GrapesJS がモデルの見た目・
 * 操作状態として set するもので、`getHtml()` の出力(保存内容)には現れない(`toJSON` が捨てる
 * `status`/`open` と、`setEditable` が撒く lock state の prop)。主防御は保存内容の比較
 * (`useTemplateEditor.settleIfClean`)で、これは選択直後に「未確定」を一瞬でも出さないための
 * 即時応答用。
 */
const SAVE_NEUTRAL_PROPS: ReadonlySet<string> = new Set([
  'status',
  'open',
  'editable',
  'draggable',
  'selectable',
  'hoverable',
  'highlightable',
]);
```

`fireChange` を `(opts: { saveNeutral?: boolean } = {})` にして `if (opts.saveNeutral) return;` を `callbacks.change?.()` の直前に置き、

```ts
  // `component:update` は直近の `set` で変わった prop を `model.changed` に持つ。全部が
  // 保存内容に現れない prop なら dirty/autosave へ流さない。読めない発火は保守的に「変更」扱い。
  const onComponentUpdate = (model?: { changed?: Record<string, unknown> }) => {
    const changed = model?.changed;
    const keys = changed && typeof changed === 'object' ? Object.keys(changed) : [];
    fireChange({ saveNeutral: keys.length > 0 && keys.every((k) => SAVE_NEUTRAL_PROPS.has(k)) });
  };
```

購読を `ed.on('component:update', onComponentUpdate); ed.on('component:add', () => fireChange()); ed.on('component:remove', () => fireChange()); ed.on('component:styleUpdate', () => fireChange());` へ。deps の `fitToView` → `applyInitialZoom: () => void`（Task 4 で本実装。ここでは `useGrapes` 側を `applyInitialZoom: fitToView` として挙動不変に繋ぐ）。

- [ ] **Step 7: `useGrapes.load` の `quiet`**

```ts
  function load(bodyEditableHtml: string, css: string, opts: { quiet?: boolean } = {}): boolean {
    …
    // `quiet` は刈り取りのトーストだけを抑止する(刈り取り自体は通常どおり)。確定版の正規形を
    // 取るための読み込みで使う — 本文の読み込みで同じ通知が出るため、二重に出すと誤解を招く。
    quietParse = !!opts.quiet;
    try {
      ed.setComponents(bodyEditableHtml);
    } finally {
      quietParse = false;
    }
    ed.setStyle(css);
```

- [ ] **Step 8: `useTemplateEditor.ts`**

宣言部（`const dirty = ref(false);` の直後）:

```ts
  /**
   * 確定版の値埋め込み本文を GrapesJS 自身が直列化した形(HTML + CSS)。「未確定」の判定基準。
   * 文字列比較が成り立つのは同じ直列化を通した同士だけなので canvas から取る。初回に取って
   * `lib/confirmedCanonical.ts` へ永続し、draft 再開時はそれを使う(無ければ確定版を先に
   * 読み込んで測る)。作成経路は確定版が無く null。
   */
  let confirmedCanonical: ConfirmedCanonical | null = null;
  /** draft が実体として在りうるか(前回セッションの draft、または autosave が 1 度でも走った)。 */
  let draftMayExist = false;
  let cleanCheckTimer: ReturnType<typeof setTimeout> | null = null;
```

`onMounted` の load 部:

```ts
    dirty.value = res.value.hasDraft;
    draftMayExist = res.value.hasDraft;
    …
    g.init({ canvas, layers });
    const isCreateRoute = route.query.created === '1';
    const tplUpdatedAt = res.value.template.meta.updatedAt;
    if (!isCreateRoute) {
      confirmedCanonical = readConfirmedCanonical(id, tplUpdatedAt);
      // キャッシュが無く draft から開くときだけ、確定版を先に読み込んで正規形を測る。
      if (!confirmedCanonical && res.value.hasDraft) {
        if (!g.load(res.value.confirmedBody, res.value.template.css, { quiet: true })) {
          router.replace({ name: 'edit' });
          return;
        }
        confirmedCanonical = { html: g.getBodyHtml(), css: g.getCss() };
        writeConfirmedCanonical(id, tplUpdatedAt, confirmedCanonical);
      }
    }
    if (!g.load(res.value.editableBody, res.value.css)) {
      router.replace({ name: 'edit' });
      return;
    }
    if (!isCreateRoute && !confirmedCanonical) {
      confirmedCanonical = { html: g.getBodyHtml(), css: g.getCss() };
      writeConfirmedCanonical(id, tplUpdatedAt, confirmedCanonical);
    }
    …
    g.onChange(markChanged);
    // 前回セッションの draft が確定版と同じ内容なら、開いた時点で「変更なし」へ戻す。
    if (res.value.hasDraft) scheduleCleanCheck();
```

`Template.meta.updatedAt` の実フィールド名は `shared/src/schemas.ts:89` を見て合わせる（`meta` 配下か直下か）。

関数群（autosave の error 監視の前に）:

```ts
  /** canvas の変更。dirty を即時に立てて autosave を予約し、確定版との同一判定も予約する。 */
  function markChanged(): void {
    dirty.value = true;
    draftMayExist = true;
    autosave.trigger();
    scheduleCleanCheck();
  }

  /**
   * 現在の保存内容が確定版の正規形と同じなら「未確定」を下ろし、draft を消す。Undo や手戻しで
   * 元の内容に戻ったのに未確定のまま draft が残ると、プレビュー・申請が「変更あり」の経路を
   * 通り続けるため。判定は autosave の debounce(800ms)より先に走らせ、同じ内容の draft を
   * 保存しに行く前に予約を取り消す。進行中の保存があれば完了を待ってから消す。
   */
  function scheduleCleanCheck(): void {
    if (cleanCheckTimer) clearTimeout(cleanCheckTimer);
    cleanCheckTimer = setTimeout(() => {
      cleanCheckTimer = null;
      void settleIfClean();
    }, 300);
  }
  async function settleIfClean(): Promise<void> {
    const base = confirmedCanonical;
    if (!base || !dirty.value) return;
    if (g.getBodyHtml() !== base.html || g.getCss() !== base.css) return;
    dirty.value = false;
    autosave.cancel();
    if (!draftMayExist) return;
    await autosave.settled();
    // 待っている間に編集が入っていれば、その変更の判定に任せる(消してはいけない draft を消さない)。
    if (dirty.value) return;
    draftMayExist = false;
    const res = await service.discardDraft(id);
    if (isErr(res)) logError(res.error);
  }
```

`onBeforeUnmount` で `if (cleanCheckTimer) clearTimeout(cleanCheckTimer);`。`partLabels` の computed に `void g.pageEls.value;` を足し、`useGrapes` の return に `pageEls` を加える（コメント: load 直後は wrapper 要素が無く空 Map になるため、ページ列挙の確定にも依存させる）。

- [ ] **Step 9: GREEN を確認**

Run: `cd editor/web && pnpm exec vitest run test/confirmedCanonical.dom.test.ts test/grapesEvents.test.ts test/saveFormat.dom.test.ts` → PASS。
Run: `pnpm run typecheck`。
Run: `cd editor && pnpm exec playwright test e2e/canvas.spec.ts e2e/comment_panel.spec.ts e2e/note_bubble.spec.ts e2e/tabbed_layout.spec.ts --project chromium` → PASS。

- [ ] **Step 10: 設計正典へ追記**

```markdown
- **「未確定」は保存内容が確定版と違うときだけ**: `dirty` は `component:update` の発火ではなく、
  保存内容（`getBodyHtml()` + `getCss()`）が確定版の正規形と違うかで決める。正規形は確定版から
  開いた初回に canvas から取り `lib/confirmedCanonical.ts` へ永続する（キーは templateId +
  `updatedAt`。承認で更新されれば無効）。無ければ確定版を先に読み込んで測ってから draft で
  入れ替える。変更のたび 300ms で突き合わせ、同じ内容へ戻れば「変更なし」へ下ろし draft を消す
  （進行中の autosave を待ち、待機中に再編集が入れば消さない）。`component:update` の UI 状態
  prop（`grapesEvents.SAVE_NEUTRAL_PROPS`）の濾過は即時応答用の補助で、主防御にしない。
  機械検証は `web/test/grapesEvents.test.ts`・`web/test/confirmedCanonical.dom.test.ts`・
  `e2e/canvas.spec.ts`「往復統合」。
```

- [ ] **Step 11: コミット**

```bash
pnpm exec biome check --write editor/web/src editor/web/test editor/e2e
git add editor/web/src/lib/confirmedCanonical.ts editor/web/src/lib/storageKeys.ts editor/web/src/api/local/store.ts editor/web/src/features/editor/grapesEvents.ts editor/web/src/features/editor/useGrapes.ts editor/web/src/features/editor/useTemplateEditor.ts editor/web/test/confirmedCanonical.dom.test.ts editor/web/test/grapesEvents.test.ts editor/e2e/canvas.spec.ts "docs/editor/src/設計正典.md"
git commit -m "fix(editor): 「未確定」を保存内容と確定版正規形の比較で決め、選択だけで未確定にならず Undo で同一なら変更なしに戻す"
```

---

## Task 4: ① 起動ズーム 100%（画面に合わせない）+ スクリーンショット再撮影

**Files:**
- Modify: `editor/web/src/features/editor/grapesEvents.ts:104-108`（load 時の `fitToView` → `applyInitialZoom`）
- Modify: `editor/web/src/features/editor/useGrapes.ts`（`applyInitialZoom: () => setZoom(initialZoom)`、`setInitialZoom`）
- Modify: `editor/web/src/features/editor/EditorView.vue:220-262`（ResizeObserver・`userZoomed` 撤去）
- Modify: `editor/web/src/features/editor/useZoomFit.ts`（doc コメント）
- Test: `editor/e2e/canvas.spec.ts`「ズーム」
- Regenerate: `docs/editor/images/*.png`、`docs/editor/*.html`

**Interfaces:**
- Produces: `useGrapes().setInitialZoom(z: number)`（load 前に呼ぶ。既定 1）。
- Consumes: Task 3 で改名した deps `applyInitialZoom`。

- [ ] **Step 1: RED — e2e「ズーム」を書き換え**

```ts
test('ズーム: 起動時は 100%(A4 実寸)で、拡大と「画面に合わせる」は手動でだけ効く', async ({ page }) => {
  await login(page);
  await openEditor(page);
  // A4 の紙面は 210mm = 794px。起動時は画面に合わせず 100% で開く(1440x900 では縦が
  // 収まらないので、フィットさせると 794 より小さくなる = 100% と区別できる)。
  const widthOf = async () => (await page.locator('iframe.gjs-frame').boundingBox())?.width ?? 0;
  await expect.poll(async () => Math.abs((await widthOf()) - 794), { timeout: 15_000 }).toBeLessThan(2);
  await page.getByRole('button', { name: '拡大' }).click();
  await expect.poll(widthOf, { timeout: 15_000 }).toBeGreaterThan(794 + 10);
  await page.getByRole('button', { name: '画面に合わせる' }).click();
  await expect.poll(widthOf, { timeout: 15_000 }).toBeLessThan(794 - 10);
});
```

Run: `cd editor && pnpm exec playwright test e2e/canvas.spec.ts --project chromium -g "ズーム"` → 794 でなく FAIL。

- [ ] **Step 2: 実装**

`grapesEvents.ts` load 内: `requestAnimationFrame(() => deps.applyInitialZoom());`（コメント: 起動時の倍率は 100%。画面へのフィットは Ctrl+0 / % ボタンの手動操作でだけ効く）。deps doc: 「canvas load 後に初期倍率を当てる(既定 100%。画面には合わせない)」。

`useGrapes.ts`: `let initialZoom = 1; function setInitialZoom(z: number) { initialZoom = z; }`、wireGrapesEvents へ `applyInitialZoom: () => setZoom(initialZoom)`、return に `setInitialZoom`。

`EditorView.vue`: `userZoomed` を削除。ResizeObserver は常に `g.refreshRect(); g.refreshPageGuides(); g.updateScrollMode();`（コメント: 倍率は据え置き、overlay と縦配置だけ追随。フィットは手動のみ）。`zoomIn/zoomOut` からフラグ設定を外し、`zoomReset` は `g.fitToView()` のみ。

`useZoomFit.ts` の `fitToView` doc「起動時の初期ズーム用」→「Ctrl+0 / % ボタンの手動フィット用。起動時は 100% で開き自動では呼ばない」。

- [ ] **Step 3: GREEN**

Run: `cd editor && pnpm exec playwright test e2e/canvas.spec.ts e2e/smoke.spec.ts --project chromium` → PASS。`pnpm run typecheck`。

- [ ] **Step 4: スクリーンショット再撮影と HTML 再生成**

Run: `cd editor && pnpm exec playwright test --project docs`（`capture_docs.spec.ts`）→ `docs/editor/images/*.png` が変わる。`py -3.13 docs/_build/build_all.py --project editor`。`docs/editor/src/操作手順書.md` に「起動時は画面に合わせる」旨の記述があれば「起動時は 100%（実寸）で開き、% ボタン / Ctrl+0 で画面に合わせる」へ（`grep -n "ズーム" docs/editor/src/操作手順書.md` で確認。128 行目は文言変更不要）。

- [ ] **Step 5: 設計正典へ追記 + コミット**

```markdown
- **起動時のズームは 100%**: 編集キャンバスは画面に合わせず A4 実寸で開き、window・ペインの
  resize でも倍率を据え置く（追随させるのは overlay と縦配置だけ）。画面へのフィットは
  Ctrl+0 / % ボタンの手動操作のみ（`useZoomFit.fitToView`）。狭い画面では横スクロールになる（仕様）。
```

```bash
pnpm exec biome check --write editor/web/src editor/e2e
git add editor/web/src/features/editor editor/e2e/canvas.spec.ts docs/editor "docs/editor/src/設計正典.md"
git commit -m "fix(editor): 起動時のズームを 100% にし、resize で画面に合わせ直さない(スクリーンショット再撮影を含む)"
```

---

## Task 5: ⑤ プレビュー往復で UI 状態を戻す

**Files:**
- Modify: `editor/web/src/stores/editorSession.ts`（`ui`・永続）
- Modify: `editor/web/src/lib/storageKeys.ts`（`editorUiKey()`）
- Modify: `editor/web/src/features/editor/useTemplateEditor.ts`（初期値・写し・選択復元）
- Modify: `editor/web/src/features/editor/EditorView.vue`（`paneTab`・`showPageGuides`）
- Test: `editor/web/test/editorSession.dom.test.ts`、`editor/e2e/canvas.spec.ts`

**Interfaces:**
- Produces: `EditorUiState { allowEdit; redlineEnabled; paneTab; zoom: number|null; singlePageMode; currentPage; showPageGuides; selectedKey: string|null }`、`defaultEditorUiState()`、`EditSession.ui`、`store.persistUi(templateId)`。永続対象は `redlineEnabled / paneTab / zoom / singlePageMode / currentPage / showPageGuides`（`allowEdit` と `selectedKey` はメモリのみ）。
- Consumes: Task 4 の `setInitialZoom`、既存 `selectPartByKey`、`currentNoteKey`。

- [ ] **Step 1: RED — ストアの単体テスト**

`editorSession.dom.test.ts` の既存 `toEqual({ partHistory: {}, seq: 0, undoPast: [], undoFuture: [] })` 2 箇所に `ui: defaultEditorUiState()` を足し（import も）、追加:

```ts
  it('ui 状態は再 ensure で残り、倍率・表示系だけが localStorage へ永続し、allowEdit と選択は永続しない', () => {
    const store = useEditorSessionStore();
    const s = store.ensure('t1');
    expect(s.ui).toEqual({
      allowEdit: false, redlineEnabled: true, paneTab: 'props', zoom: null,
      singlePageMode: true, currentPage: 0, showPageGuides: true, selectedKey: null,
    });
    s.ui.allowEdit = true; s.ui.zoom = 1.2; s.ui.paneTab = 'comments'; s.ui.selectedKey = 'p1/.x#2';
    store.persistUi('t1');
    expect(store.ensure('t1').ui).toMatchObject({ allowEdit: true, zoom: 1.2, paneTab: 'comments', selectedKey: 'p1/.x#2' });
    const persisted = JSON.parse(localStorage.getItem('editor:session:ui:local') ?? '{}');
    expect(persisted.t1).toEqual({ redlineEnabled: true, paneTab: 'comments', zoom: 1.2, singlePageMode: true, currentPage: 0, showPageGuides: true });
  });

  it('新しいセッションは永続した ui から hydrate し、allowEdit と選択は既定に戻る', () => {
    localStorage.setItem('editor:session:ui:local', JSON.stringify({ t1: { redlineEnabled: false, paneTab: 'comments', zoom: 0.8, singlePageMode: false, currentPage: 2, showPageGuides: false } }));
    const store = useEditorSessionStore();
    expect(store.ensure('t1').ui).toEqual({
      allowEdit: false, redlineEnabled: false, paneTab: 'comments', zoom: 0.8,
      singlePageMode: false, currentPage: 2, showPageGuides: false, selectedKey: null,
    });
  });

  it('clear() は ui と永続分も消す', () => {
    const store = useEditorSessionStore();
    store.ensure('t1').ui.zoom = 0.8; store.persistUi('t1');
    store.clear('t1');
    expect(store.ensure('t1').ui.zoom).toBeNull();
    expect(JSON.parse(localStorage.getItem('editor:session:ui:local') ?? '{}').t1).toBeUndefined();
  });
```

- [ ] **Step 2: RED — e2e 2 本目**

```ts
test('プレビュー往復で編集許可・赤入れ表示・右ペインのタブ・倍率・ページ表示・選択が残る', async ({ page }) => {
  test.setTimeout(120_000);
  await login(page);
  const frame = await openEditor(page);
  const widthOf = async () => (await page.locator('iframe.gjs-frame').boundingBox())?.width ?? 0;
  await page.getByRole('button', { name: '拡大' }).click();
  await page.getByRole('button', { name: '拡大' }).click();
  await expect.poll(widthOf, { timeout: 15_000 }).toBeGreaterThan(794 * 1.2 - 2);
  await page.getByRole('button', { name: '閲覧のみ(クリックで編集を許可)' }).click();
  await page.getByRole('button', { name: '変更箇所の赤入れを隠す' }).click();
  await page.locator('[data-pane-tab="comments"]').click();
  await page.getByRole('button', { name: '全ページを連続表示' }).click();
  await page.getByRole('button', { name: 'ページ境界を隠す' }).click();
  await selectPart(frame, frame.locator('.page > *').nth(3));

  await page.getByRole('button', { name: 'プレビュー' }).click();
  await page.waitForURL(/\/preview\//);
  await page.getByRole('button', { name: 'エディターに戻る' }).click();
  await page.waitForURL(/\/edit\//);
  const back = page.frameLocator('iframe.gjs-frame');
  await back.locator('.page').first().waitFor({ state: 'visible', timeout: 30_000 });

  await expect.poll(widthOf, { timeout: 15_000 }).toBeGreaterThan(794 * 1.2 - 2);
  await expect(page.getByRole('button', { name: '編集中(クリックで閲覧のみに戻す)' })).toBeVisible();
  await expect(page.getByRole('button', { name: '変更箇所を赤入れで表示' })).toBeVisible();
  await expect(page.locator('[data-pane-tab="comments"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: '1 ページだけ表示' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'ページ境界を表示' })).toBeVisible();
  await expect(back.locator('.gjs-selected')).toHaveCount(1, { timeout: 15_000 });

  // リロードでは倍率・表示系は残り、編集許可と選択は既定へ戻る
  await page.reload({ waitUntil: 'commit' });
  const re = page.frameLocator('iframe.gjs-frame');
  await re.locator('.page').first().waitFor({ state: 'visible', timeout: 30_000 });
  await expect.poll(widthOf, { timeout: 15_000 }).toBeGreaterThan(794 * 1.2 - 2);
  await expect(page.getByRole('button', { name: '閲覧のみ(クリックで編集を許可)' })).toBeVisible();
  await expect(re.locator('.gjs-selected')).toHaveCount(0);
});
```

Run: 単体 → `defaultEditorUiState` 未定義で FAIL。e2e → FAIL。

- [ ] **Step 3: ストア実装**

`storageKeys.ts`: `const UI_STATE_PREFIX = 'editor:session:ui'; export function editorUiKey() { return `${UI_STATE_PREFIX}:${userScope()}`; }`（後片付け配列にも追加）。

`editorSession.ts`:

```ts
export interface EditorUiState {
  /** 「編集を許可」トグル(永続しない — リロード後は安全側の既定 OFF)。 */
  allowEdit: boolean;
  redlineEnabled: boolean;
  paneTab: 'props' | 'comments';
  /** canvas の倍率。null は「まだ決めていない」= 起動時の既定(100%)。 */
  zoom: number | null;
  singlePageMode: boolean;
  currentPage: number;
  showPageGuides: boolean;
  /** 選択パーツの構造キー(永続しない — リロード後は未選択から)。 */
  selectedKey: string | null;
}
export function defaultEditorUiState(): EditorUiState {
  return { allowEdit: false, redlineEnabled: true, paneTab: 'props', zoom: null, singlePageMode: true, currentPage: 0, showPageGuides: true, selectedKey: null };
}
type PersistedUi = Omit<EditorUiState, 'allowEdit' | 'selectedKey'>;
type UiMap = Record<string, PersistedUi>;
function readUiMap(): UiMap { try { return JSON.parse(localStorage.getItem(editorUiKey()) ?? '{}') as UiMap; } catch { return {}; } }
function writeUiMap(map: UiMap): void { try { localStorage.setItem(editorUiKey(), JSON.stringify(map)); } catch { /* 諦める(倍率が戻らないだけ) */ } }
```

`EditSession` に `ui: EditorUiState`、`ensure` で `ui: { ...defaultEditorUiState(), ...(readUiMap()[templateId] ?? {}) }`（`allowEdit`/`selectedKey` は既定のまま）、`persistUi(templateId)`（`allowEdit`/`selectedKey` を除いて書く）、`clear` で `readUiMap()` から削除して書き戻す。

- [ ] **Step 4: 画面側**

`useTemplateEditor.ts`: `const allowEdit = ref(sess.ui.allowEdit);`、`redline.enabled.value = sess.ui.redlineEnabled;`、以下の watch（`persistUi` は倍率・表示系の変更時のみ）:

```ts
  // ── UI 状態の往復保持(`sess.ui`)。倍率・表示系は永続、編集許可・選択はメモリのみ ──
  watch(allowEdit, (v) => { sess.ui.allowEdit = v; });
  watch(redline.enabled, (v) => { sess.ui.redlineEnabled = v; sessionStore.persistUi(id); });
  watch(g.zoom, (v) => { sess.ui.zoom = v; sessionStore.persistUi(id); });
  watch(g.singlePageMode, (v) => { sess.ui.singlePageMode = v; sessionStore.persistUi(id); });
  watch(g.currentPageIndex, (v) => { sess.ui.currentPage = v; sessionStore.persistUi(id); });
  watch(() => g.selected.value, () => { sess.ui.selectedKey = currentNoteKey(); });
  let restoredSelection = false;
  watch(() => g.pageEls.value, (els) => {
    if (restoredSelection || els.length === 0) return;
    restoredSelection = true;
    if (sess.ui.selectedKey) selectPartByKey(sess.ui.selectedKey);
  });
```

`onMounted` の `g.init` 直後: `g.setInitialZoom(sess.ui.zoom ?? 1); g.setSinglePageMode(sess.ui.singlePageMode);`、load 後の rAF で `if (g.singlePageMode.value && sess.ui.currentPage > 0) g.goToPage(sess.ui.currentPage);`。return に `ui: sess.ui`。

`EditorView.vue`: `const paneTab = ref(ui.paneTab); watch(paneTab, (v) => { ui.paneTab = v; sessionStore.persistUi(props.id); });`、`showPageGuides` も同様（`useEditorSessionStore` を import）。

- [ ] **Step 5: GREEN + 設計正典 + コミット**

Run: `cd editor/web && pnpm exec vitest run test/editorSession.dom.test.ts` / `cd editor && pnpm exec playwright test e2e/canvas.spec.ts e2e/tabbed_layout.spec.ts --project chromium` / `pnpm run typecheck`。

設計正典「編集セッションはブラウザタブの寿命」項の末尾に:

```markdown
  画面の UI 状態も同じセッションの一部でプレビュー往復で戻す（`stores/editorSession.ts` の `ui`）。
  倍率・ページ表示・右ペインのタブ・赤入れ表示・guide は localStorage へ永続しリロードでも戻る。
  **`allowEdit` と選択は永続しない**（リロード後は安全側の既定 OFF・未選択）。
```

「してはならないこと」へ「`allowEdit` を永続する」。

```bash
pnpm exec biome check --write editor/web/src editor/web/test editor/e2e
git add editor/web/src/stores/editorSession.ts editor/web/src/lib/storageKeys.ts editor/web/src/api/local/store.ts editor/web/src/features/editor editor/web/test/editorSession.dom.test.ts editor/e2e/canvas.spec.ts "docs/editor/src/設計正典.md"
git commit -m "fix(editor): プレビュー往復で編集画面の UI 状態を戻す(倍率・表示系は永続、編集許可と選択はメモリのみ)"
```

---

## Task 6: ② コメント種別（メモ / 修正依頼 / 質問）を廃止しメモのみ

**Files:**
- Modify: `editor/shared/src/schemas.ts:593,615,637`、`editor/shared/src/index.ts:167`、`editor/shared/src/repositories/NoteRepository.ts`
- Modify: `editor/server/src/repositories/noteRepo.ts`、`editor/server/src/files/notesFile.ts:94-121`、`editor/server/src/routes/notes.routes.ts:36`
- Modify: `editor/web/src/api/local/noteRepo.ts`、`editor/web/src/api/rest/noteRepo.ts:26`、`editor/web/src/features/editor/useComments.ts:96-108`、`editor/web/src/features/editor/comments/commentFilter.ts`、`editor/web/src/features/editor/comments/CommentPanel.vue`、`editor/web/src/features/editor/NoteBubble.vue`、`editor/web/src/features/editor/EditorView.vue:547`、`editor/web/src/features/reviews/ReviewTabView.vue:321`
- Regenerate: `editor/server/openapi/openapi.json`（`cd editor/server && pnpm run openapi:gen`）
- Test: `editor/shared/test/partNote.test.ts`、`editor/server/test/{noteRepo,notes.routes,notesFile.thread}.test.ts`、`editor/web/test/{noteRepo.dom,commentPanel.dom,commentFilter,restRepos.dom,reviewTabView.dom}.test.ts`
- Docs: `docs/editor/src/操作手順書.md:44,176,274`、`docs/editor/src/設計書.md:528`、`docs/editor/src/設計正典.md:82,91`

**Interfaces:**
- Produces: `PartNoteEntry` に `kind` 無し。`AddNoteRequest { pathKey, content, replyTo }`。`AddNoteOptions { replyTo? }`。`commentFilter.STATUS_LABEL: Record<'open'|'resolved', string> = { open: '未対応', resolved: '解決済み' }`。`CommentPanel` の emit `add: [content: string]`。

- [ ] **Step 1: RED — テストを「種別を持たない・旧 kind は捨てる」へ**

- `shared/test/partNote.test.ts`: `NoteKind` import 削除。「status / replyTo / kind を持つ形を受理する」→ `{ ...base, status: 'resolved', replyTo: 'p1' }`。「3 フィールド」→「2 フィールド」。追加: `it('旧形式の kind は捨てる', () => { expect(PartNoteEntry.parse({ ...base, status: 'open', replyTo: null, kind: 'question' })).not.toHaveProperty('kind'); })`。「列挙の外」から `NoteKind` 行を削除。「AddNoteRequest の返信と種別」→「返信」: `replyTo` 省略で null / `kind: 'fix-request'` を渡しても出力に無い。
- `server/test/noteRepo.test.ts`: `PARENT = { replyTo: null }`、`kind: 'note' as const` 行を削除、`{ replyTo: p.id, kind: 'note' }` → `{ replyTo: p.id }`。「指定した種別で保存」→「種別は持たない」（`expect(e).not.toHaveProperty('kind')`）。
- `server/test/notes.routes.test.ts`: 70 行 `expect(parsed).not.toHaveProperty('kind')`（payload に `kind:'note'` を渡して捨てられることを確認）。106 行の `kind: 'note',` 削除 + `not.toHaveProperty('kind')`。117 行 `toMatchObject({ replyTo: parent.json().id })` + `not.toHaveProperty('kind')`。
- `server/test/notesFile.thread.test.ts`: 155/181/200 行付近の `kind: 'note'` 期待を外し `not.toHaveProperty('kind')`。
- `web/test/noteRepo.dom.test.ts`: 「指定した種別」→ `addNote(KOUFU, KEY, '質問')` で `not.toHaveProperty('kind')`。既定値補完の期待から `kind` を外す。
- `web/test/commentPanel.dom.test.ts`: fixture から `kind` を削除。「種別付きで add」→ `toEqual(['これは確定値ですか'])`。「種別チェックボックス」→ `it('種別の入力欄・絞り込みは出さず、行のバッジは状態(未対応 / 解決済み)を示す')`（`[data-add-kind]`/`[data-filter-kind]` が無い、行テキストに `未対応` / `解決済み`、`メモ` を含まない）。
- `web/test/commentFilter.test.ts`: fixture の `kind` 削除、`kinds` の絞り込み assertion 削除。
- `web/test/restRepos.dom.test.ts:175-195`: body から `kind` を外す。`web/test/reviewTabView.dom.test.ts:36,342`: fixture の `kind` 削除、`toHaveBeenCalledWith(TPL, COVER, '本文', {})`。

Run: shared / server / web の該当テスト → 複数 FAIL。

- [ ] **Step 2: 実装**

- `schemas.ts`: `NoteKind` 定義と `kind:` 2 箇所を削除。`index.ts` の `export type NoteKind` 削除。`NoteRepository.ts` の `kind?` 削除。
- server: `noteRepo.ts` の `AddNoteOptions.kind` と `kind: opts.kind` 削除、import から `NoteKind`。`notesFile.ts`: `NOTE_KINDS` 削除、`withCommentDefaults` から `kind` を外す（旧形式の `kind` は読まない旨のコメント）。`notes.routes.ts`: `{ replyTo: body.replyTo }`。
- web: local `noteRepo.ts` の `withCommentDefaults` は `const { kind: _legacyKind, ...rest } = raw as PartNoteEntry & { kind?: unknown }; return { ...rest, status, replyTo };`、`kind: opts.kind ?? 'note'` 削除。rest `noteRepo.ts` body から `kind`。`useComments.reply` の `kind: parent.kind` 削除。`commentFilter.ts`: `kinds`・`KIND_LABEL` 削除、`STATUS_LABEL` 追加。`CommentPanel.vue`: 種別セレクト・`kindChecked`・チェックボックス削除、バッジ `{{ STATUS_LABEL[t.parent.status] }}`、「解決済み」の重複 span 削除、emit `add: [content: string]`。`NoteBubble.vue`: `.note-entry-kind` → `.note-entry-status`（`STATUS_LABEL[t.parent.status]`）。`EditorView.vue` `@add="(content) => addNote(content)"`、`ReviewTabView.vue` `@add="(content) => comments.add(content, {}, selectedKey[m.id] ?? undefined)"`。
- `cd editor/server && pnpm run openapi:gen`。

- [ ] **Step 3: GREEN**

Run: `cd editor/shared && pnpm exec vitest run` / `cd editor/server && pnpm exec vitest run` / `cd editor/web && pnpm exec vitest run` / `pnpm run typecheck` / `cd editor && pnpm exec playwright test e2e/comment_panel.spec.ts e2e/note_bubble.spec.ts e2e/review_tab.spec.ts --project chromium`。server の `notes.limits.test.ts` は負荷で 5 秒を超えることがあるので単独再実行で判定。

- [ ] **Step 4: docs + コミット**

操作手順書 44/176/274 行から種別を外し、設計書 528 行を「`kind` は持たない」、設計正典 82 行「`kind`(note / fix-request / question)」を「種別は持たない（コメントはメモ 1 種類。旧データ・旧クライアントの `kind` は読み取りで捨てる）」、91 行「状態・種別・投稿者」→「状態・投稿者」。`py -3.13 docs/_build/build_all.py --project editor`。

```bash
pnpm exec biome check --write editor/shared/src editor/server/src editor/web/src editor/web/test editor/server/test editor/shared/test
git add editor/shared editor/server editor/web docs/editor
git commit -m "feat(editor): コメントの種別(メモ / 修正依頼 / 質問)を廃止し、メモ 1 種類にする"
```

---

## 完了条件

- `pnpm run ci` 相当が緑（`check:comments` / `ci:offline`（Pester）/ typecheck / unit / e2e）。
- editor-data の汚染修正コミットが済んでいる。
- 設計正典の追記 4 点（保存形式・未確定判定・起動ズーム・UI 状態）と「してはならないこと」5 件が入っている。
- push はユーザーへ依頼（各コミットの auto-push が失敗していれば `git push`）。
