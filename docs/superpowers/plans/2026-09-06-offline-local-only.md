# オフライン配布機構の縮退 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** オフライン配布機構を「この端末でバンドルを作って Release へ上げる（git 管理外の `local-only/`）/ 他端末は git clone + HTTPS 取得で環境を作る（追跡側 `offline/`）」の 2 役に縮退し、署名・pin・一時 Public 化・コミットフック連動を両リポジトリから撤去する。

**Architecture:** 追跡側 `offline/` は展開側だけを持ち、content-key（既存の `content-key.ps1` / `bundle_common.py`。ロジック不変）で Release の `bundle.key` と手元の lockfile / requirements の整合を検査する。生成・upload は `local-only/offline-publish/`（gitignore）に置き、追跡側の lib を相対パスで参照する。変更前の実装は `local-only/archive-github-dist/` へ verbatim 複製して保守対象から外す。

**Tech Stack:** Windows PowerShell 5.1（monorepo `.ps1` + Pester）、Python 3.13（python-tools、pytest）、GitHub Releases（`gh` は publish 側のみ）、`git`。

**Spec:** `docs/superpowers/specs/2026-09-06-offline-local-only-design.md`

## Global Constraints

- 日本語を含む `.ps1` は UTF-8 **BOM 付き**で保存する（cp932 環境での文字化け回避）。`.bat` は ASCII 主体・CRLF。`.ps1` には同名 `.bat` を同階層に併設する（dot-source 専用 lib は例外）。
- コメント規約は `docs/コメント規約.md`（両リポジトリ共通）。経緯（変更日・所見番号・「旧実装では」）はコメントに書かない。
- python-tools では `.ps1` / `.mjs` を新規追加しない（Python 第一）。
- monorepo の `editor/**` は触らない（lint-staged の対象外なので `biome` 先行実行は不要）。
- `offline/lib/content-key.ps1` と `bundle_common.compute_content_key` の算出ロジックは変更しない（Release の `bundle.key` との互換を保つ）。
- monorepo のコミットは常設ブランチ `chore/deps-latest-offline-bundle` へ、python-tools は `main` 直コミット。commit のたび auto-push フックが走る（monorepo は pre-push で `ci:affected`、python-tools は pytest 一式 約 100 秒）。
- Windows のパス区切りは `\`。シェルは PowerShell 5.1（`&&` 不可）。Python は `py -3.13`。
- Task 1〜7 は monorepo（`C:\Users\caads\workspace`）、Task 8〜13 は python-tools（`C:\Users\caads\python-tools`）、Task 14 は両方。

**spec からの変更（実装の都合で決めた 2 点）:**
- monorepo の pre-push は「タグのみの分岐を撤去」ではなく `scripts/pre-push.mjs` ごと削除し、`.husky/pre-push` が `scripts/ci-affected.mjs` を直接呼ぶ（タグ判定を外すと残る判定は「stdin が空なら upstream 差分で決める」だけで、ブランチ push 以外に pre-push が走る経路が無くなるため）。python-tools の `pre_push.py` も同様に判定関数を全部外す。
- python-tools の `setup_offline.py` が `publish_bundle.py` から import していた定数・部品（`BUNDLE_NAME` / `resolve_tar_exe` 等）は `bundle_common.py` へ移す（publish が git 管理外へ出るため）。

---

## ファイル構成（変更後）

monorepo:

```
offline/
  setup-offline.ps1 / .bat      … 統合版（直下/bk\ のバンドル優先、無ければ Release から HTTPS 取得）
  README-offline.txt            … 書き直し
  lib/content-key.ps1           … 不変
  lib/git-tools.ps1             … 不変
  lib/verify.ps1                … requirements 検査 / manifest 解決 / Assert-LocalRepoRoot / Assert-FileSha256 のみ
  lib/verify.Tests.ps1          … 上記の分だけ
local-only/                     … gitignore
  README.md
  offline-publish/publish-offline-bundle.ps1 / .bat
  archive-github-dist/README.md, offline/（変更前の複製）, hooks/post-commit, hooks/pre-push.mjs, hooks/pre-push.test.mjs
.husky/post-commit              … 削除
.husky/pre-push                 … `node scripts/ci-affected.mjs` を直接呼ぶ
scripts/pre-push.mjs / .test.mjs … 削除
```

python-tools:

```
offline/
  setup_offline.py / setup-offline.bat … 書き直し
  README-offline.md                    … 書き直し
  lib/bundle_common.py                 … requirements 列挙 / content-key / bundle.key / バンドル共通定数（publish から移設）
local-only/                            … gitignore
  README.md
  offline-publish/publish_bundle.py / publish-bundle.bat
  archive-github-dist/README.md, offline/（変更前の複製）, hooks/post_commit.py, hooks/pre_push.py
scripts/check_requirements.py          … pip 入口ガードを吸収
scripts/hooks/post_commit.py           … auto-push のみ
scripts/hooks/pre_push.py              … 常に check_comments → pytest
```

---

### Task 1: monorepo `local-only/` の作成と変更前実装の退避

**Files:**
- Create: `local-only/README.md`, `local-only/archive-github-dist/README.md`
- Copy: `offline/**` → `local-only/archive-github-dist/offline/`、`.husky/post-commit` → `local-only/archive-github-dist/hooks/post-commit`、`scripts/pre-push.mjs`・`scripts/pre-push.test.mjs` → `local-only/archive-github-dist/hooks/`
- Modify: `.gitignore`（`local-only/` 追加）、`scripts/check-comments.py:48-66,76-105`（両 REPO_CONFIGS の `skip_dir_names` / `ps1_skip_dir_names` に `"local-only"` 追加）

**Interfaces:**
- Produces: `local-only/archive-github-dist/offline/` に変更前 `offline/` の全ファイル（Task 4・5 の publish 側はここから複製して作る）。

- [ ] **Step 1: 退避元コミット SHA を控える**

Run: `git -C C:\Users\caads\workspace rev-parse HEAD`
Expected: 40 桁の SHA（以下 `<SHA>` と書く）。

- [ ] **Step 2: 複製する**

```powershell
$root = 'C:\Users\caads\workspace'
New-Item -ItemType Directory -Force "$root\local-only\archive-github-dist\hooks" | Out-Null
Copy-Item -Recurse -Force "$root\offline" "$root\local-only\archive-github-dist\offline"
Copy-Item -Force "$root\.husky\post-commit" "$root\local-only\archive-github-dist\hooks\post-commit"
Copy-Item -Force "$root\scripts\pre-push.mjs" "$root\local-only\archive-github-dist\hooks\pre-push.mjs"
Copy-Item -Force "$root\scripts\pre-push.test.mjs" "$root\local-only\archive-github-dist\hooks\pre-push.test.mjs"
```

- [ ] **Step 3: README 2 つを書く**

`local-only/README.md`:

```markdown
# local-only（git 管理外・この端末専用）

このフォルダは `.gitignore` で除外されており、GitHub には存在しない。配布担当の端末にだけ置く。

- `offline-publish/` … オフライン重量物バンドルの生成と GitHub Releases への upload。
  依存（`pnpm-lock.yaml` / `packageManager` / 各 `requirements.txt` / `git-tools/manifest.txt` /
  `docs/_build/vendor/manifest.txt` / `native-prebuilds/manifest.txt`）を変えたら
  `offline-publish\publish-offline-bundle.bat` を手動で実行する。自動化フックは無い。
- `archive-github-dist/` … 2026-09-06 に GitHub から撤去した配布機構（署名・pin・ソース ZIP 取得・
  ローリングタグ移動・post-commit 連動）の変更前実装。参照専用で保守しない。

他端末の手順は追跡側の `offline/README-offline.txt` を読む。
```

`local-only/archive-github-dist/README.md`:

```markdown
# archive-github-dist（変更前の配布機構の複製）

- 退避元コミット: `<SHA>`（chore/deps-latest-offline-bundle）
- 退避日: 2026-09-06
- 内容: `offline/`（変更前の全ファイル）、`hooks/post-commit`（旧 `.husky/post-commit`）、
  `hooks/pre-push.mjs` と `hooks/pre-push.test.mjs`（旧 `scripts/`）。

## 撤去した理由

配布先は git clone と GitHub Releases からの HTTPS 取得で環境を作る運用に決めた。
RSA 分離署名・pin（`pinned-release.txt`）・ソース ZIP の取得・一時 Public 化・コミットのたびの
ローリングタグ移動は、その運用では使わない。

## Release とタグの扱い

- Release `offline-bundle-v1` は配布経路として現役。`local-only/offline-publish/` が
  `gh release upload --clobber` でアセット（`offline-deps-bundle.tar.gz` / `.sha256` / `bundle.key`）を差し替える。
- タグ `offline-bundle-v1` はもう動かさない。GitHub が自動添付する Source code は陳腐化するが、
  ソースは git clone で配るので使わない。

## 注意

この複製は `$PSScriptRoot` 相対の参照を持つため、この場所からは動かない。動かす必要も無い。
```

- [ ] **Step 4: `.gitignore` に追加する**

`.gitignore` の `CLAUDE.md` 行の直後に追加:

```
# 配布担当の端末にだけ置くバンドル生成スクリプトと、撤去した配布機構の複製
local-only/
```

併せて、分離署名の控えに関する 2 行コメントと `offline-deps-bundle.tar.gz.sig` の行、`_bundle_verify/` の行を削除する（`offline-deps-bundle.tar.gz.sha256` / `bundle.key` / `_bundle_stage/` / `bk/` は残す）。

- [ ] **Step 5: `scripts/check-comments.py` の走査除外に `local-only` を足す**

`REPO_CONFIGS["python-tools"]` と `REPO_CONFIGS["workspace"]` の両方で、`skip_dir_names` の集合と `ps1_skip_dir_names` の集合に `"local-only",` を追加する（4 箇所）。コメントは `"python-wheelhouse"` の隣に置くだけでよい。

- [ ] **Step 6: 検査を通す**

Run: `git -C C:\Users\caads\workspace status --short`
Expected: `local-only/` が表示されない（ignore されている）。`.gitignore` と `scripts/check-comments.py` だけが変更。

Run: `pnpm run check:comments`
Expected: exit 0。

- [ ] **Step 7: コミット**

```
git add .gitignore scripts/check-comments.py
git commit -m "chore(offline): 配布担当専用の local-only/ を git 管理外にし、コメント検査の走査から外す"
```

---

### Task 2: monorepo のコミットフック連動を撤去する

**Files:**
- Delete: `.husky/post-commit`, `scripts/pre-push.mjs`, `scripts/pre-push.test.mjs`
- Modify: `.husky/pre-push`, `package.json:37`（`test:scripts`）, `scripts/ci-affected.mjs`（コメントのみ）, `scripts/clean.mjs:66,77-84,188`
- Config: `git config --unset offline.publish`

**Interfaces:**
- Produces: `.husky/pre-push` は `node scripts/ci-affected.mjs` を直接実行する。`scripts/pre-push.mjs` は存在しない。

- [ ] **Step 1: テストを先に落とす**

`package.json` の `test:scripts` から `scripts/pre-push.test.mjs` を外す:

```json
"test:scripts": "node --test scripts/clean.test.mjs scripts/ci-affected.test.mjs scripts/check-ports.test.mjs",
```

Run: `pnpm run test:scripts`
Expected: PASS（pre-push のテストが列挙から消えているだけ）。

- [ ] **Step 2: フックとスクリプトを削除する**

```powershell
$root = 'C:\Users\caads\workspace'
Remove-Item "$root\.husky\post-commit", "$root\scripts\pre-push.mjs", "$root\scripts\pre-push.test.mjs"
git -C $root config --unset offline.publish
```

`.husky/pre-push` を次の内容にする（ファイル全体）:

```sh
# ブランチ push のたび変更領域だけの CI を走らせる(振り分けは scripts/ci-affected.mjs)。
node scripts/ci-affected.mjs
```

- [ ] **Step 3: 参照を直す**

`scripts/ci-affected.mjs` のコメントで `scripts/pre-push.mjs` に触れている箇所（`grep -n "pre-push" scripts/ci-affected.mjs`）を「`.husky/pre-push` から直接呼ばれる」の表現へ直す。

`scripts/clean.mjs`:
- 66 行目のコメント `offline/setup-offline-local` → `offline/setup-offline`。
- 77 行目のコメント `` `offline/publish-offline-bundle.ps1` `` → `` `local-only/offline-publish/publish-offline-bundle.ps1` ``。
- 188 行目の案内文 `offline/setup-offline-local` → `offline/setup-offline`。

- [ ] **Step 4: 検査**

Run: `pnpm run test:scripts`
Expected: PASS。

Run: `git -C C:\Users\caads\workspace config --get offline.publish`
Expected: 出力なし（exit 1）。

- [ ] **Step 5: コミット**

```
git add -A .husky scripts/pre-push.mjs scripts/pre-push.test.mjs scripts/ci-affected.mjs scripts/clean.mjs package.json
git commit -m "chore(hooks): post-commit の Release 連動とタグのみ push の CI スキップを撤去する"
```

コミット後、post-commit が走らないこと（`[info] repo root:` の行が出ないこと）を確認する。

---

### Task 3: `offline/lib/verify.ps1` から署名・pin・receipt を外す

**Files:**
- Modify: `offline/lib/verify.ps1`, `offline/lib/verify.Tests.ps1`

**Interfaces:**
- Produces: `verify.ps1` に残る関数 = `Read-Utf8Lines` / `Test-OfflineRequirementLine` / `Test-OfflineRequirementsFile` / `Assert-OfflineRequirementsFile` / `Get-GitToolsManifestEntries` / `Resolve-VerifiedManifestFile` / `Assert-LocalRepoRoot` / `Assert-FileSha256`。

- [ ] **Step 1: テストから消える関数の Describe を削除する**

`offline/lib/verify.Tests.ps1` から次の Describe ブロックを丸ごと削除する:
- `Describe 'Verification receipt（検証済みフラグ）'`（126〜167 行）
- `Describe 'Test-PinnedCommitId'`（194〜216 行）
- `Describe 'Get-OfflinePin（手渡しで運ばれる期待値の読み取り）'`（218〜262 行）
- `Describe '分離署名の検証（Test-DetachedSignature / Assert-BundleSignature）'`（264〜331 行）

`Describe 'Assert-FileSha256（pin との突き合わせ）'` は残し、名前を `'Assert-FileSha256（期待値との突き合わせ）'` に、It `'別リリースの期待値では停止する'` はそのまま残す。

Run: `pnpm run ci:offline`
Expected: PASS（残した Describe だけが走る）。

- [ ] **Step 2: 関数を削除する**

`offline/lib/verify.ps1` から次を削除する:
- 冒頭コメントの「設計方針」2 項目（配信元 digest / fail closed）を次の 2 行に置き換える:
  ```
  # 設計方針: 入力（requirements / manifest）は許可リストで受け、検証に失敗したら止まる
  # （fail closed）。「無ければスキップ」はここでは提供しない。
  ```
  1 行目の SYNOPSIS 相当も `# 共通ライブラリ: offline 配布物の入力検査（requirements 許可リスト / manifest 照合 / sha256）。` に直す。
- `# ── pinned commit id の形式検証 ──` から `Get-OfflinePin` の終わりまで（155〜205 行）。
- `# ── RSA 分離署名 ──` から `Assert-BundleSignature` の終わりまで（207〜292 行）。
- `# ── 検証済み receipt ──` から末尾まで（346〜397 行）。
- `Assert-FileSha256` のメッセージ `"$Label の sha256 が pin と一致しません。"` → `"$Label の sha256 が期待値と一致しません。"`、`expected(pin):` → `expected:`、末尾の `取得物が期待したリリースのものでない。` は残す。その直前のコメント `# 期待値は offline/ 同梱の pin から渡すこと（配信元から取った .sha256 を渡さない）。` を `# 期待値は Release に並ぶ .sha256（転送破損の検知）または呼び出し側が持つ値を渡す。` に直す。

- [ ] **Step 3: 検査**

Run: `pnpm run ci:offline`
Expected: PASS。

Run: `pnpm run check:requirements -- docs/_build/requirements.txt`（無ければ `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\check-requirements.ps1 -Path docs\_build\requirements.txt`）
Expected: exit 0（`Assert-OfflineRequirementsFile` が残っている）。

Run: `pnpm run check:comments`
Expected: exit 0。

- [ ] **Step 4: コミット**

```
git add offline/lib/verify.ps1 offline/lib/verify.Tests.ps1
git commit -m "refactor(offline): verify.ps1 から署名・pin・receipt を外し入力検査だけにする"
```

---

### Task 4: 追跡側 `offline/setup-offline.ps1` を 1 本に統合する

**Files:**
- Rewrite: `offline/setup-offline.ps1`, `offline/setup-offline.bat`
- Delete: `offline/setup-offline-local.ps1`, `offline/setup-offline-local.bat`, `offline/publish-offline-bundle.ps1`, `offline/publish-offline-bundle.bat`, `offline/new-bundle-signing-key.ps1`, `offline/new-bundle-signing-key.bat`, `offline/bundle-signing.pub.xml`, `offline/pinned-release.txt`

**Interfaces:**
- Consumes: `Get-LockContentKey` / `Get-PackageManagerString` / `Resolve-Tar`（content-key.ps1）、`Assert-LocalRepoRoot` / `Assert-FileSha256`（verify.ps1）、`Install-GitTools`（git-tools.ps1）。
- Produces: 他端末の唯一の入口 `offline\setup-offline.bat`。引数 `-Owner` / `-Repo` / `-Tag` / `-SkipBuild` / `-InstallTortoiseGit`。

- [ ] **Step 1: 不要ファイルを削除する**

```powershell
$o = 'C:\Users\caads\workspace\offline'
Remove-Item "$o\setup-offline-local.ps1", "$o\setup-offline-local.bat", "$o\publish-offline-bundle.ps1", "$o\publish-offline-bundle.bat", "$o\new-bundle-signing-key.ps1", "$o\new-bundle-signing-key.bat", "$o\bundle-signing.pub.xml", "$o\pinned-release.txt"
```

- [ ] **Step 2: `offline/setup-offline.ps1` を書く（UTF-8 BOM）**

以下を全文として保存する。環境構築部（corepack 登録〜Playwright 配置〜git-tools）は旧 `setup-offline.ps1` の `[5/6]` ブロックと `Install-GitTools` の呼び出しを**そのまま**移す（下記の `# ---- [5/6] ----` 相当）。

```powershell
#requires -Version 5.1
<#
.SYNOPSIS
  git clone 済みのリポジトリに、オフライン重量物バンドルを展開して開発環境を構築する。

.DESCRIPTION
  重量物（.pnpm-store / pnpm.tgz / ms-playwright / python-wheelhouse / git-tools /
  docs の mermaid JS / native-prebuilds）は git に入れず GitHub Releases（タグ offline-bundle-v1）に
  置いてある。本スクリプトは次を 1 本で行う:
    1. バンドルの用意。リポジトリ直下または bk\ に offline-deps-bundle.tar.gz と bundle.key が
       あればそれを使う（取得しない）。無ければ Release から HTTPS で直取得する（gh 不要。
       リポジトリは Public）。取得したときは Release の .sha256 と突き合わせて転送破損を検知する。
    2. 展開 → bundle.key と手元の pnpm-lock.yaml / packageManager / requirements / manifest から
       算出する content-key の一致検査。不一致は「ソースと重量物が別の組」なので中止する
       （続けても pnpm install --offline が落ちるだけで、原因が見えにくくなる）。
    3. 同梱 pnpm を corepack 登録 → node_modules / dist を消してオフライン install → build →
       Playwright 配置 → msnodesqlv8 prebuild 配置 → PortableGit 展開。
    4. 取得物を bk\ へ退避する。

  ソースコードは取得しない（git clone が前提）。バンドルの真正性は検証しない: 配布担当だけが
  Release を更新でき、配布先は同じ所有者の Public リポジトリを clone している前提で受け入れる。
  content-key の不一致は改ざんではなく「依存を変えたのに publish していない」状態で、
  配布担当に local-only\offline-publish\publish-offline-bundle.bat の実行を依頼する。

.PARAMETER Owner
  GitHub オーナー名。既定 koichi-araki-0801。

.PARAMETER Repo
  リポジトリ名。既定 workspace。

.PARAMETER Tag
  重量物アセットの取得元タグ。既定 offline-bundle-v1。

.PARAMETER SkipBuild
  取得・展開・整合検査のみ行い、install / build / Playwright 配置を省略する。

.PARAMETER InstallTortoiseGit
  TortoiseGit の MSI を msiexec /qn（サイレント・昇格）で導入する。既定では導入しない。

.EXAMPLE
  offline\setup-offline.bat
.EXAMPLE
  offline\setup-offline.bat -SkipBuild
#>
[CmdletBinding()]
param(
  [string]$Owner = 'koichi-araki-0801',
  [string]$Repo  = 'workspace',
  [string]$Tag   = 'offline-bundle-v1',
  [switch]$SkipBuild,
  [switch]$InstallTortoiseGit
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'lib\content-key.ps1')
. (Join-Path $PSScriptRoot 'lib\verify.ps1')
. (Join-Path $PSScriptRoot 'lib\git-tools.ps1')

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Bk       = Join-Path $RepoRoot 'bk'
Write-Host "[info] repo root: $RepoRoot"
# ネットワークドライブ上では pnpm の symlink/hardlink 構成が成立しないため開始前に止める。
Assert-LocalRepoRoot -Path $RepoRoot

$TarExe     = Resolve-Tar
$BundleName = 'offline-deps-bundle.tar.gz'
$AssetBase  = "https://github.com/$Owner/$Repo/releases/download/$Tag"
$LockFile   = Join-Path $RepoRoot 'pnpm-lock.yaml'
$PkgJson    = Join-Path $RepoRoot 'package.json'
foreach ($f in @($LockFile, $PkgJson)) {
  if (-not (Test-Path -LiteralPath $f)) {
    Write-Error "[error] $f がありません。リポジトリを git clone した直下で実行してください。"; exit 1
  }
}

# リポジトリ直下を優先し、無ければ bk\ から資材を探す。
function Find-Local([string]$name) {
  $a = Join-Path $RepoRoot $name
  if (Test-Path -LiteralPath $a) { return $a }
  $b = Join-Path $Bk $name
  if (Test-Path -LiteralPath $b) { return $b }
  return $null
}

# curl.exe があればストリーミング DL、無ければ Invoke-WebRequest（PS5.1 の進捗描画は大容量で極端に遅い）。
$curl = Get-Command 'curl.exe' -ErrorAction SilentlyContinue
function Download-File([string]$url, [string]$dest) {
  Write-Host "       <- $url"
  if ($curl) {
    & $curl.Source -L --fail --retry 3 -o $dest $url
    if ($LASTEXITCODE -ne 0) { throw "ダウンロードに失敗: $url" }
  } else {
    $old = $ProgressPreference
    $ProgressPreference = 'SilentlyContinue'
    try { Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing }
    finally { $ProgressPreference = $old }
  }
}

# ---- [1/5] バンドルの用意（手元優先、無ければ Release から取得） ----
Write-Host '[1/5] バンドルを確認...'
$Bundle  = Find-Local $BundleName
$KeyFile = Find-Local 'bundle.key'
$downloaded = $false
if ($Bundle -and $KeyFile) {
  Write-Host "[info] 手元のバンドルを使います: $Bundle"
} else {
  Write-Host "[info] 手元にバンドルが無いため Release $Tag から HTTPS で取得します..."
  $Bundle  = Join-Path $RepoRoot $BundleName
  $KeyFile = Join-Path $RepoRoot 'bundle.key'
  $Sha     = "$Bundle.sha256"
  try {
    Download-File "$AssetBase/$BundleName"        $Bundle
    Download-File "$AssetBase/$BundleName.sha256" $Sha
    Download-File "$AssetBase/bundle.key"         $KeyFile
  } catch {
    Write-Error "[error] $($_.Exception.Message)`n  タグ / ネットワーク / リポジトリの公開状態を確認してください。"; exit 1
  }
  $downloaded = $true
  # Release に並ぶ .sha256 で転送破損を検知する（形式: "<sha256>  <ファイル名>"）。
  $expected = ((Get-Content -LiteralPath $Sha -Raw).Trim() -split '\s+')[0]
  Assert-FileSha256 -File $Bundle -ExpectedSha256 $expected -Label 'bundle'
}

# ---- [2/5] 展開 ----
Write-Host '[2/5] 重量物を直下へ展開...'
& $TarExe -xzf $Bundle -C $RepoRoot
if ($LASTEXITCODE -ne 0) { Write-Error '[error] 展開に失敗しました。'; exit 1 }
foreach ($p in @('.pnpm-store', 'pnpm.tgz', 'ms-playwright', 'python-wheelhouse', 'git-tools',
    'docs\_build\vendor\mermaid.min.js', 'docs\_build\vendor\mermaid-layout-elk.min.js',
    'native-prebuilds\manifest.txt')) {
  if (-not (Test-Path (Join-Path $RepoRoot $p))) { Write-Error "[error] 展開後に $p が見つかりません。バンドルが不完全です。"; exit 1 }
}

# ---- [3/5] content-key の一致検査（展開後 = git-tools\manifest.txt が在る状態で測る） ----
# content-key の入力に git-tools\manifest.txt（バンドル同梱・git 管理外）が含まれるため、
# 展開前に測ると manifest を欠いて publish 側と必ずズレる。
Write-Host '[3/5] bundle.key と手元のソースの整合を検査...'
$packageManager = Get-PackageManagerString $PkgJson
$localKey = Get-LockContentKey -LockFile $LockFile -PackageManager $packageManager
$publishedKey = (Get-Content -LiteralPath $KeyFile -Raw).Trim().ToLower()
if ($localKey -ne $publishedKey) {
  Write-Error ("[error] ソースと重量物が対応していません。`n  code (local) : $localKey" +
    "`n  bundle.key   : $publishedKey`n  依存を変えたのに Release を更新していない可能性があります。" +
    "`n  配布担当に local-only\offline-publish\publish-offline-bundle.bat の実行を依頼するか、" +
    "`n  bundle.key に対応するコミットへ checkout し直してください。")
  exit 1
}
Write-Host "[info] content-key 一致: $localKey"

# ---- [4/5] オフライン環境構築 ----
if (-not $SkipBuild) {
  # （旧 setup-offline.ps1 の [5/6] ブロックをここへそのまま移す: corepack が無ければ中止、
  #   COREPACK_ENABLE_DOWNLOAD_PROMPT=0 / CI=true、Push-Location $RepoRoot、corepack install -g pnpm.tgz、
  #   node_modules / dist / tsbuildinfo の purge、pnpm install --offline --frozen-lockfile --store-dir、
  #   msnodesqlv8 prebuild の展開と require 疎通確認、pnpm build、ms-playwright の xcopy。
  #   表示は '[4/5] 環境構築: ...' に変える。）
} else {
  Write-Host '[4/5] -SkipBuild: 取得・展開・整合検査のみ。環境構築をスキップしました。'
}

# editor のテンプレ版管理は git CLI を使う。同梱 PortableGit を展開して PATH/GIT_BIN を通す。
Install-GitTools -RepoRoot $RepoRoot -InstallTortoiseGit:$InstallTortoiseGit

# ---- [5/5] 取得物を bk\ へ退避（手元のバンドルを使った回は動かさない） ----
if ($downloaded) {
  Write-Host '[5/5] ダウンロード物を bk/ へ退避...'
  New-Item -ItemType Directory -Path $Bk -Force | Out-Null
  function Move-ToBk([string]$src) {
    if (-not (Test-Path -LiteralPath $src)) { return }
    $dst = Join-Path $Bk (Split-Path $src -Leaf)
    if (Test-Path -LiteralPath $dst) { Remove-Item -LiteralPath $dst -Recurse -Force -ErrorAction SilentlyContinue }
    # 一時的なファイルロック（AV スキャン等）に備え、軽くリトライしてから移す。
    for ($i = 1; $i -le 3; $i++) {
      try { Move-Item -LiteralPath $src -Destination $dst -Force; break }
      catch { if ($i -eq 3) { throw }; Start-Sleep -Milliseconds 400 }
    }
    Write-Host "       -> bk\$(Split-Path $src -Leaf)"
  }
  # 記憶した変数パスへの Test-Path はビルド直後の一時ロックで false を返すことがあるため、
  # 実ディスクの列挙を正として複数パスで掃き出す。
  $names = @($BundleName, "$BundleName.sha256", 'bundle.key')
  for ($pass = 1; $pass -le 3; $pass++) {
    $hits = Get-ChildItem -LiteralPath $RepoRoot -File -Force -ErrorAction SilentlyContinue |
      Where-Object { $names -contains $_.Name }
    if (-not $hits) { break }
    foreach ($fi in $hits) { Move-ToBk $fi.FullName }
    Start-Sleep -Milliseconds 300
  }
} else {
  Write-Host '[5/5] 手元のバンドルを使ったため退避はありません。'
}

Write-Host ''
if ($SkipBuild) {
  Write-Host '[OK] 展開完了（build はスキップ）。'
} else {
  Write-Host '[OK] セットアップ完了。'
  Write-Host '  - 型チェック: corepack pnpm typecheck'
  Write-Host '  - テスト:     corepack pnpm test'
  Write-Host '  - E2E:        corepack pnpm test:e2e'
  Write-Host '  - 開発サーバ: corepack pnpm dev'
  Write-Host '  - エディタ起動: editor\start.bat'
  Write-Host '  ( corepack enable を一度実行すれば、以後は pnpm だけで実行可能 )'
  Write-Host ''
  Write-Host '  PDF 出力はシステムの Microsoft Edge を自動使用します（追加ブラウザ不要）。'
}
```

`[4/5]` の中身は `local-only/archive-github-dist/offline/setup-offline.ps1` の 158〜236 行（`if (-not (Get-Command 'corepack' ...` から `} finally { Pop-Location }` まで）を貼る。`'[5/6] 環境構築:'` の文字列は `'[4/5] 環境構築:'` に直す。

- [ ] **Step 3: `offline/setup-offline.bat` を書く（ASCII・CRLF）**

```bat
@echo off
chcp 65001 >nul
title Offline setup - extract and build
rem Launches setup-offline.ps1 with ExecutionPolicy Bypass (args forwarded).
rem Prerequisite: this repository is already git-cloned. Uses the bundle found at the
rem repo root (or bk\); otherwise downloads it from GitHub Releases over HTTPS.
rem   setup-offline.bat                     extract (download if needed) + offline build
rem   setup-offline.bat -SkipBuild          extract only, no install/build
rem   setup-offline.bat -InstallTortoiseGit also install TortoiseGit (elevated MSI)
rem ASCII only on purpose: cmd garbles multi-byte rem/title lines in .bat files.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-offline.ps1" %*
exit /b %ERRORLEVEL%
```

- [ ] **Step 4: 構文と BOM を検査する**

Run:
```powershell
$p = 'C:\Users\caads\workspace\offline\setup-offline.ps1'
$null = [scriptblock]::Create((Get-Content -Raw -LiteralPath $p)); 'parse OK'
[System.IO.File]::ReadAllBytes($p)[0..2] -join ','
```
Expected: `parse OK` と `239,187,191`。

Run: `pnpm run check:comments`
Expected: exit 0（`.bat` 併設・BOM）。

- [ ] **Step 5: `-SkipBuild` で手元のバンドルを使う経路を実走する**

前提: リポジトリ直下に `offline-deps-bundle.tar.gz` と `bundle.key` がある（無ければ `bk\` から戻す）。

Run: `offline\setup-offline.bat -SkipBuild`
Expected: `[1/5]` で「手元のバンドルを使います」、`[3/5]` で `content-key 一致`、`[5/5]` で「退避はありません」、`[OK] 展開完了`。

- [ ] **Step 6: コミット**

```
git add -A offline
git commit -m "feat(offline): setup を 1 本に統合し、手元のバンドル優先で無ければ Release から取得する"
```

---

### Task 5: `local-only/offline-publish/publish-offline-bundle.ps1`（この端末専用）

**Files:**
- Create: `local-only/offline-publish/publish-offline-bundle.ps1`, `local-only/offline-publish/publish-offline-bundle.bat`

**Interfaces:**
- Consumes: 追跡側 `offline/lib/content-key.ps1`（`Get-LockContentKey` / `Get-OfflineRequirementsFiles` / `Resolve-Tar`）、`offline/lib/verify.ps1`（`Test-OfflineRequirementsFile`）。
- Produces: リポジトリ直下に `offline-deps-bundle.tar.gz` / `.sha256` / `bundle.key`。Release `offline-bundle-v1` のアセット差し替え。

- [ ] **Step 1: 変更前の publish を複製して土台にする**

```powershell
$root = 'C:\Users\caads\workspace'
New-Item -ItemType Directory -Force "$root\local-only\offline-publish" | Out-Null
Copy-Item "$root\local-only\archive-github-dist\offline\publish-offline-bundle.ps1" "$root\local-only\offline-publish\publish-offline-bundle.ps1"
```

- [ ] **Step 2: 複製へ次の編集を施す**

1. comment-based help を次に差し替える:
   ```
   <#
   .SYNOPSIS
     オフライン重量物バンドルを生成し、GitHub Releases（タグ offline-bundle-v1）のアセットを差し替える。
   .DESCRIPTION
     配布担当の端末だけで手動実行する（git 管理外の local-only/ に置く。自動化フックは無い）。
     content-key = sha256( pnpm-lock.yaml ‖ packageManager ‖ 各 requirements.txt ‖ 各 manifest.txt )
     を算出し、Release 側の bundle.key と一致すれば何もしない。不一致（または -Force）なら
     .pnpm-store / pnpm.tgz / ms-playwright / python-wheelhouse / git-tools / mermaid JS /
     native-prebuilds を再生成して tar.gz へ固め、.sha256 と bundle.key と一緒に upload する。
     タグは動かさない。ソースは git clone で配る。
   .PARAMETER Tag
     公開先タグ。既定 offline-bundle-v1。
   .PARAMETER Force
     変更検知を無視して常に再生成・再アップロードする。
   .PARAMETER SkipRegen
     再生成を省略し、ディスク上の成果物をそのまま固めてアップロードする。
   .EXAMPLE
     local-only\offline-publish\publish-offline-bundle.bat
   #>
   ```
2. `param(` から `-TagOnly` と `-SigningKey` を外す（残す: `$Tag` / `$Force` / `$SkipRegen`）。
3. dot-source を追跡側 lib へ向ける（`$PSScriptRoot` 直下の `lib\` ではない）:
   ```powershell
   $LibDir = Join-Path $PSScriptRoot '..\..\offline\lib'
   . (Join-Path $LibDir 'content-key.ps1')
   . (Join-Path $LibDir 'verify.ps1')
   ```
   `$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path` に直す。
4. `-TagOnly` の分岐（`if ($TagOnly -and $bundleChanged) { ... exit 0 }`）と、それ以降の `$TagOnly` 参照をすべて削除する。
5. `$SigFile` / `$PinFile` / `$PubKeyFile` / `$signingKeyXml` の宣言、署名鍵の存在確認ブロック、`New-DetachedSignatureBase64` 〜 `Write-Host '[info] 署名 OK。'` のブロックを削除する。
6. `# ---- Release 説明（notes） ----` から `# ---- 公開コミットの解決とローリングタグ移動ヘルパ ----` の `Move-RollingTag` 関数まで、および `# ---- pin ファイル ----` 以降の pin 生成ブロック全体を削除する。
7. Release 作成/更新の分岐を次に置き換える:
   ```powershell
   # ---- Release のアセット差し替え ----
   if (-not $bundleChanged) {
     Write-Host "[OK] 重量物は Release $Tag と一致しています（変更なし）。"
     Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
     exit 0
   }
   if (-not $releaseExists) {
     Write-Error "[error] Release $Tag がありません。GitHub で先に作成してください（タグはこのスクリプトでは作りません）。"; exit 1
   }
   Write-Host '[info] アセットをアップロード（--clobber で差し替え）...'
   & gh release upload $Tag $Bundle $Sha $KeyFile --clobber
   if ($LASTEXITCODE -ne 0) { Write-Error '[error] gh release upload に失敗しました。'; exit 1 }
   Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
   Write-Host "[OK] 公開完了: $Tag に $BundleName (${sizeMB}MB) / .sha256 / bundle.key を反映しました。"
   ```
8. `Require-Cmd 'git'` は残す（`git rev-parse` は使わないので削除してもよい。残す場合は害なし）。

- [ ] **Step 3: `.bat` を書く（ASCII・CRLF）**

```bat
@echo off
chcp 65001 >nul
title Offline bundle - publish (this machine only)
rem Launches publish-offline-bundle.ps1 with ExecutionPolicy Bypass (args forwarded).
rem Run manually after changing pnpm-lock.yaml / requirements / manifests.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0publish-offline-bundle.ps1" %*
exit /b %ERRORLEVEL%
```

- [ ] **Step 4: 構文検査と「変更なし」経路の実走**

Run:
```powershell
$p = 'C:\Users\caads\workspace\local-only\offline-publish\publish-offline-bundle.ps1'
$null = [scriptblock]::Create((Get-Content -Raw -LiteralPath $p)); 'parse OK'
[System.IO.File]::ReadAllBytes($p)[0..2] -join ','
```
Expected: `parse OK` と `239,187,191`。

Run: `local-only\offline-publish\publish-offline-bundle.bat`
Expected: `[info] current content key:` と `[info] published key:` が同じ値、`[OK] 重量物は Release offline-bundle-v1 と一致しています（変更なし）。` で終了。`gh release upload` は走らない。

- [ ] **Step 5: コミット対象は無い**

`local-only/` は git 管理外。`git status --short` に何も出ないことを確認する。

---

### Task 6: monorepo の docs を新しい手順へ直す

**Files:**
- Rewrite: `offline/README-offline.txt`
- Modify: `README.md`（15-16 行の 3 コマンド、42-43 行・55 行の入口一覧、95-96 行のタグ段落）、`docs/トラブルシュート.md:15-22`、`docs/editor/src/デプロイ運用手順書.md:25-26`、`docs/editor/src/設計書.md:741`、`docs/コメント規約.md:97-106`、ローカル `CLAUDE.md`（post-commit / pre-push の記述）
- Regenerate: `docs/editor/editor_設計.html`

- [ ] **Step 1: `offline/README-offline.txt` を書き直す（UTF-8 BOM。全文）**

```
==============================================================================
 オフライン環境構築（Windows x64）
==============================================================================

重量物（依存パッケージ・ブラウザ・wheel・git ツールなど約 1.1GB）は git に入れず、GitHub Releases の
タグ offline-bundle-v1 に offline-deps-bundle.tar.gz として置いてある。ソースコードは git clone で受け取る。

■ 重量物の内訳（Release のアセット offline-deps-bundle.tar.gz に同梱）
  - .pnpm-store/        … 依存パッケージのオフラインストア
  - pnpm.tgz            … pnpm 本体（corepack 用）
  - ms-playwright/      … Playwright 用 Chromium（E2E テスト用）
  - python-wheelhouse/  … Python 依存の wheel（docs 閲覧 HTML のビルドとテスト用）
  - git-tools/          … PortableGit / TortoiseGit（editor のテンプレ版管理に使う git）
  - docs/_build/vendor/mermaid*.js … docs の Mermaid 描画ランタイム + ELK レイアウト
  - native-prebuilds/   … msnodesqlv8 の公式 prebuild（Node 24.x 専用）
  同じ場所の bundle.key は、そのバンドルがどの pnpm-lock.yaml / requirements / manifest から
  作られたかを示す content-key。setup はこれと手元のソースを突き合わせる。

------------------------------------------------------------------------------
■ 前提
------------------------------------------------------------------------------
  - Windows x64、Node.js 24 以降（corepack 同梱）、tar / curl.exe（Windows 10/11 標準）
  - PDF 出力には Microsoft Edge を使用（Windows 標準）
  - git clone できること（リポジトリは Public）

------------------------------------------------------------------------------
■ 手順（他端末）
------------------------------------------------------------------------------
1) リポジトリを clone する
     git clone https://github.com/koichi-araki-0801/workspace.git
2) セットアップを実行する
     offline\setup-offline.bat
   これだけで次を全自動で行う:
     - リポジトリ直下（または bk\）に offline-deps-bundle.tar.gz と bundle.key があればそれを使い、
       無ければ Release から HTTPS で直取得する（gh 不要）。取得したときは Release の .sha256 で
       転送破損を検査する
     - 展開 → bundle.key と手元のソースの content-key を突き合わせる（不一致は中止）
     - 同梱 pnpm を corepack 登録 → 依存をオフライン install → build → Playwright 配置 →
       PortableGit 展開
     - 取得物を bk\ へ退避
   「[OK] セットアップ完了。」が出れば完了。
   ※ 展開・整合検査だけ行う場合:  offline\setup-offline.bat -SkipBuild
   ※ ネットに出られない端末では、別の端末で Release から offline-deps-bundle.tar.gz と bundle.key を
      落としてリポジトリ直下へ置いてから実行する。
3)（任意）動作確認
     corepack pnpm run ci

------------------------------------------------------------------------------
■ 重量物の更新（配布担当の端末のみ）
------------------------------------------------------------------------------
  生成と Release への upload は git 管理外の local-only\offline-publish\publish-offline-bundle.bat で行う
  （このフォルダは配布担当の端末にだけある）。pnpm-lock.yaml / package.json の packageManager /
  各 requirements.txt / git-tools/manifest.txt / docs/_build/vendor/manifest.txt /
  native-prebuilds/manifest.txt のどれかを変えて push したら、忘れずに実行する。
  実行を忘れると、他端末の setup は content-key 不一致で止まる（黙って古い重量物を使うことはない）。
  コミットフックからは何も自動実行しない。

------------------------------------------------------------------------------
■ 前提と受け入れているリスク
------------------------------------------------------------------------------
  - Release のアセットのすり替えは検出しない。.sha256 は Release と同じ場所にあるので転送破損の
    検知にしか使えない。Release を更新できるのはリポジトリ所有者だけで、配布先は同じ所有者の
    Public リポジトリを clone している前提で受け入れる。
  - ソースと重量物の整合は content-key（bundle.key）で担保する。

------------------------------------------------------------------------------
■ トラブルシュート
------------------------------------------------------------------------------
  - 「ソースと重量物が対応していません」で止まる
      → 配布担当に publish-offline-bundle.bat の実行を依頼する。または bundle.key に対応する
        コミットへ checkout し直す。
  - ダウンロードが 404
      → タグ名（-Tag）とリポジトリの公開状態を確認する。
  - corepack が見つからない
      → Node.js 24+ をインストールする。
==============================================================================
```

- [ ] **Step 2: `README.md` を直す**

- 15〜16 行: `- セットアップ: \`offline\setup-offline.bat\`（git clone 後。重量物は Release から自動取得）または \`pnpm install\``
- 入口一覧: `offline/setup-offline.bat` の行を「git clone 済みリポジトリへ重量物を展開して構築（無ければ Release から取得）」に、`offline/setup-offline-local.bat` の行を削除。
- 裏方一覧: `offline/publish-offline-bundle.bat` の行を削除し、代わりに次の 1 行を表の下に置く:
  `重量物バンドルの生成と Release への upload は配布担当の端末にある git 管理外の \`local-only/offline-publish/\` で手動実行する（\`offline/README-offline.txt\`）。`
- 95〜97 行の「**タグのみの push（...）は CI をスキップする**（...）」の 1 文を削除する。

- [ ] **Step 3: `docs/トラブルシュート.md` の post-commit 節（15〜22 行「## コミット直後に長い処理や gh の警告が出る」）を削除する**

- [ ] **Step 4: `docs/editor/src/デプロイ運用手順書.md` の 25〜26 行を直す**

```
1. **調達**: 配布担当の端末で重量物バンドルを生成し GitHub Releases へ置く（git 管理外の `local-only/offline-publish/`。依存を変えたら手動で実行する）。
2. **持ち込み・展開**: 運用端末でリポジトリを `git clone` し、`offline/setup-offline.bat` を実行して、Release からの取得〜展開〜`pnpm install --offline`〜`pnpm build` まで完走させる（ネイティブバイナリの追加取得が走らないこと）。ネットに出られない端末では別端末で落としたバンドルと `bundle.key` を直下に置く。
```

- [ ] **Step 5: `docs/editor/src/設計書.md` の 741 行を直す**

```
依存の追加・更新はオフラインバンドル運用（重量物は GitHub Releases。生成と upload は配布担当の端末の `local-only/offline-publish/`、展開は `offline/setup-offline.bat`）と連動するため、`package.json` だけ変えても配布先には届かない点に注意。
```

- [ ] **Step 6: `docs/コメント規約.md` 付録 C の例文を差し替える（97〜106 行）**

```powershell
  #requires -Version 5.1
  <#
  .SYNOPSIS
    git clone 済みのリポジトリにオフライン重量物バンドルを展開して開発環境を構築する。
  .DESCRIPTION
    重量物は git に入れず GitHub Releases に置く（理由を散文で）。
  .PARAMETER Tag
    重量物アセットの取得元タグ。既定 offline-bundle-v1。
  #>
```

- [ ] **Step 7: ローカル `CLAUDE.md`（git 管理外）を直す**

「コミット / push フック」節から **post-commit** の項目を削除し、**pre-push** の項目を「`.husky/pre-push` が `scripts/ci-affected.mjs` を直接呼ぶ」に書き換える（タグのみ push の記述を削除）。

- [ ] **Step 8: docs HTML を再生成して検査する**

Run: `py -3.13 docs/_build/build_all.py --project editor`
Expected: `docs/editor/editor_設計.html` が更新される。

Run: `pnpm run check:comments`
Expected: exit 0。

- [ ] **Step 9: コミット**

```
git add offline/README-offline.txt README.md docs/トラブルシュート.md docs/editor/src/デプロイ運用手順書.md docs/editor/src/設計書.md docs/コメント規約.md docs/editor/editor_設計.html
git commit -m "docs(offline): 配布手順を git clone + Release 取得へ書き直し、post-commit 連動の記述を消す"
```

---

### Task 7: monorepo の回帰確認

- [ ] **Step 1: フル CI**

Run: `pnpm run ci`
Expected: exit 0（所要 4〜6 分）。

- [ ] **Step 2: タグが動いていないことの確認**

Run: `git ls-remote --tags origin offline-bundle-v1`
Expected: Task 1 のコミット後に post-commit が最後に動かした SHA のまま（Task 2 以降のコミットで変わっていない）。

- [ ] **Step 3: push 状態**

Run: `git status -sb`
Expected: `ahead` が 0（auto-push が完了している）。残っていれば `git push` を実行する。

---

### Task 8: python-tools `local-only/` の作成と退避、走査除外

**Files:**
- Create: `local-only/README.md`, `local-only/archive-github-dist/README.md`
- Copy: `offline/**` → `local-only/archive-github-dist/offline/`、`scripts/hooks/post_commit.py`・`pre_push.py` → `local-only/archive-github-dist/hooks/`
- Modify: `.gitignore`（`local-only/` 追加、`*.key.pem` 削除）、`scripts/check_comments.py`（両 REPO_CONFIGS の `skip_dir_names` / `ps1_skip_dir_names` に `"local-only"`）

- [ ] **Step 1: 複製と README**

```powershell
$root = 'C:\Users\caads\python-tools'
New-Item -ItemType Directory -Force "$root\local-only\archive-github-dist\hooks" | Out-Null
Copy-Item -Recurse -Force "$root\offline" "$root\local-only\archive-github-dist\offline"
Copy-Item -Force "$root\scripts\hooks\post_commit.py", "$root\scripts\hooks\pre_push.py" "$root\local-only\archive-github-dist\hooks\"
```

README は Task 1 の 2 つを python-tools 向けに書く（`offline-publish/` は `publish-bundle.bat`、依存の列挙は「各 `requirements.txt` / `docs/_build/vendor/manifest.txt`」、hooks は `post_commit.py` / `pre_push.py`、退避元 SHA は `git -C C:\Users\caads\python-tools rev-parse HEAD`）。

- [ ] **Step 2: `.gitignore`**

`*.key.pem` の行を削除し、末尾に追加:

```
# 配布担当の端末にだけ置くバンドル生成スクリプトと、撤去した配布機構の複製
local-only/
```

- [ ] **Step 3: `scripts/check_comments.py`**

Task 1 Step 5 と同じ 4 箇所に `"local-only",` を追加する（両リポジトリの `check_comments.py` は同一実装を保つ）。

- [ ] **Step 4: 検査とコミット**

Run: `py -3.13 scripts\check_comments.py`
Expected: exit 0。

Run: `git status --short`
Expected: `.gitignore` と `scripts/check_comments.py` のみ。

```
git add .gitignore scripts/check_comments.py
git commit -m "chore(offline): 配布担当専用の local-only/ を git 管理外にし、コメント検査の走査から外す"
```

---

### Task 9: `bundle_common.py` から pin・署名を外し、バンドル共通部品を集約する

**Files:**
- Modify: `offline/lib/bundle_common.py`, `scripts/test_python_tools_scripts.py`

**Interfaces:**
- Produces（`bundle_common` の公開名）: 既存 `list_requirements_files_via_git` / `list_requirements_files_via_filesystem` / `list_requirements_files` / `compute_content_key` / `write_bundle_key` / `read_bundle_key` / `VENDOR_MANIFEST_REL` に加え、`publish_bundle.py` から移す `DEFAULT_TAG` / `BUNDLE_NAME` / `BUNDLE_KEY_NAME = "bundle.key"` / `WHEELHOUSE_DIR_NAME` / `VENDOR_DIR_POSIX` / `VENDOR_JS_ASSET_NAMES` / `VENDOR_REQUIRED_ASSET_NAMES` / `assert_vendor_assets_present(repo_root)` / `sha256_file(path)` / `resolve_tar_exe()` / `build_tar_command(tar_exe, bundle_path, repo_root)` / `default_runner(cmd, **kwargs)`。
- 削除: `PublishPin` / `format_pin` / `write_pin` / `read_pin` / `generate_signing_key_pair` / `sign_bytes` / `sign_file` / `verify_signature_bytes` / `verify_signature` / `assert_bundle_signature`。

- [ ] **Step 1: 移設先のテストを書く**

`scripts/test_python_tools_scripts.py` の `# ── bundle_common: bundle.key の読み書き ──` の直後に追加:

```python
# ── bundle_common: バンドル共通部品 ──
def test_build_tar_command_includes_wheelhouse_and_vendor_from_bundle_common(tmp_path):
    cmd = bundle_common.build_tar_command("tar", tmp_path / "b.tar.gz", tmp_path)
    assert cmd[:2] == ["tar", "-czf"]
    assert bundle_common.WHEELHOUSE_DIR_NAME in cmd
    assert bundle_common.VENDOR_DIR_POSIX in cmd


def test_sha256_file_matches_hashlib(tmp_path):
    p = tmp_path / "x.bin"
    p.write_bytes(b"payload")
    assert bundle_common.sha256_file(p) == hashlib.sha256(b"payload").hexdigest()


def test_assert_vendor_assets_present_raises_when_js_missing(tmp_path):
    vendor = tmp_path / "docs" / "_build" / "vendor"
    vendor.mkdir(parents=True)
    (vendor / "manifest.txt").write_text("v1\n", encoding="utf-8")
    with pytest.raises(RuntimeError):
        bundle_common.assert_vendor_assets_present(tmp_path)
```

Run: `py -3.13 -m pytest scripts -q -k "bundle_common or sha256_file or vendor_assets"`
Expected: 新 3 件が `AttributeError` で FAIL。

- [ ] **Step 2: `bundle_common.py` を編集する**

1. モジュール docstring の 1 行目を `"""共通ライブラリ: offline 重量物バンドルの content-key 算出・bundle.key の読み書き・バンドル共通定数。` に、`署名鍵は Ed25519-PEM ...` の文と、`cryptography` に関するコメントブロック（`# \`cryptography\` はここでは import しない` の段落）を削除する。`import base64` / `import binascii` / `from dataclasses import dataclass` を削除し、`import hashlib` / `import os` / `import shutil` / `import subprocess` / `from pathlib import Path` / `from typing import Callable` を残す（`os` / `shutil` / `Callable` は追加）。
2. `# ── pin(offline/pinned-release.txt)の読み書き ──` から `read_pin` の終わりまで、`# ── Ed25519 分離署名 ──` から末尾までを削除する。
3. 末尾に追加する（`publish_bundle.py` からの移設。中身は変えない）:

```python
# ── バンドルの共通定数・部品(publish と setup の両側から参照する) ──

DEFAULT_TAG = "offline-bundle-v1"
BUNDLE_NAME = "offline-deps-bundle.tar.gz"
BUNDLE_KEY_NAME = "bundle.key"
WHEELHOUSE_DIR_NAME = "python-wheelhouse"
VENDOR_DIR_POSIX = "docs/_build/vendor"

# vendor 配下でバンドル由来(= `.gitignore` 対象・git 管理外)なのはこの JS 2 件だけ。
# `manifest.txt` は git 管理下なので setup 側の削除対象には含めない。
VENDOR_JS_ASSET_NAMES = ("mermaid.min.js", "mermaid-layout-elk.min.js")
VENDOR_REQUIRED_ASSET_NAMES = ("manifest.txt", *VENDOR_JS_ASSET_NAMES)

Runner = Callable[..., subprocess.CompletedProcess]


def default_runner(cmd: list[str], **kwargs) -> subprocess.CompletedProcess:
    kwargs.setdefault("capture_output", True)
    kwargs.setdefault("text", True)
    kwargs.setdefault("encoding", "utf-8")
    kwargs.setdefault("errors", "replace")
    return subprocess.run(cmd, **kwargs)


def assert_vendor_assets_present(repo_root: Path) -> None:
    vendor_dir = repo_root / "docs" / "_build" / "vendor"
    missing = [name for name in VENDOR_REQUIRED_ASSET_NAMES if not (vendor_dir / name).is_file()]
    if missing:
        raise RuntimeError(
            f"docs/_build/vendor に不足があります: {missing}\n"
            "  offline\\setup-offline.bat で vendor 一式を展開してください。"
        )


def sha256_file(path: Path) -> str:
    hasher = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            hasher.update(chunk)
    return hasher.hexdigest()


def resolve_tar_exe() -> str:
    """Windows 標準 tar(`System32\\tar.exe`)を優先解決する。

    Git Bash 同梱の MSYS tar が PATH 先頭にあると `-C <Windows パス>` を rsh の
    host:path と誤認して失敗するため。
    """
    system_root = os.environ.get("SystemRoot", r"C:\Windows")
    candidate = Path(system_root) / "System32" / "tar.exe"
    if candidate.is_file():
        return str(candidate)
    found = shutil.which("tar")
    if found:
        return found
    raise RuntimeError("'tar' が見つかりません(Windows 10/11 標準の tar.exe が必要)。")


def build_tar_command(tar_exe: str, bundle_path: Path, repo_root: Path) -> list[str]:
    """重量物を固める `tar -czf` の引数列を組み立てる(実行はしない)。"""
    return [
        tar_exe,
        "-czf",
        str(bundle_path),
        "-C",
        str(repo_root),
        WHEELHOUSE_DIR_NAME,
        VENDOR_DIR_POSIX,
    ]
```

`default_runner` の中身は `offline/publish_bundle.py` の 74〜84 行を写す（上記は要点。実物を確認して同じにする）。

- [ ] **Step 3: テストから pin・署名の分を削除する**

`scripts/test_python_tools_scripts.py` から次を削除する:
- `# ── bundle_common: pin ... ──` 節（`test_pin_round_trip` 〜 `test_read_pin_rejects_missing_key`）。
- `# ── bundle_common: Ed25519 署名 ──` 節（`test_sign_and_verify_round_trip` 〜 `test_assert_bundle_signature_passes_on_success`）。
- `_DUMMY_PIN` の定義。

この時点では `publish_bundle` / `setup_offline` / `new_signing_key` が `bundle_common` の消えた名前を参照して import 段階で落ちる。Task 10・11 で解消するため、ここでは `-k` で bundle_common のテストだけ通す。

Run: `py -3.13 -c "import sys; sys.path.insert(0,'offline/lib'); import bundle_common; print(bundle_common.BUNDLE_NAME)"`
Expected: `offline-deps-bundle.tar.gz`。

- [ ] **Step 4: コミットは Task 11 でまとめる**

`publish_bundle.py` / `setup_offline.py` が壊れた中間状態を単独でコミットしない（pre-push の pytest が落ちて auto-push が止まる）。Task 10・11 と一緒にコミットする。

---

### Task 10: pip 入口ガードを `scripts/check_requirements.py` へ移す

**Files:**
- Modify: `scripts/check_requirements.py`, `scripts/test_python_tools_scripts.py:1095-1150`, `scripts/setup_dev.py:121`（docstring の参照）

**Interfaces:**
- Produces: `check_requirements.KNOWN_PIP_ENTRYPOINTS` / `check_requirements.has_check_requirements_marker(text)` / `check_requirements.find_pip_call_files(repo_root, *, runner=None)`。

- [ ] **Step 1: テストを `check_requirements` 参照へ書き換える**

`# ── pip 入口列挙ガード ──` 節の `publish_bundle.` を `check_requirements.` に置換し、`test_pip_entrypoint_guard_detects_publish_bundle_itself` を次に置き換える:

```python
def test_pip_entrypoint_guard_detects_setup_dev_itself():
    # 検出ロジックが壊れて何も見つからなくなる(ガードが常に無風で通る)ことを防ぐ回帰確認。
    found = check_requirements.find_pip_call_files(REPO_ROOT)
    assert "scripts/setup_dev.py" in found
```

Run: `py -3.13 -m pytest scripts -q -k pip_entrypoint`
Expected: FAIL（`check_requirements` に属性が無い）。

- [ ] **Step 2: `check_requirements.py` の末尾（`_parse_args` の前）に移設する**

`offline/publish_bundle.py` の `# ── pip 入口列挙ガード ──` 節（`KNOWN_PIP_ENTRYPOINTS` から `find_pip_call_files` の終わりまで）を丸ごと写し、次を変える:
- `KNOWN_PIP_ENTRYPOINTS` から `"offline/publish_bundle.py"` と `"offline/setup_offline.py"` を外す。
- `find_pip_call_files` の `runner` 型は `Callable[..., subprocess.CompletedProcess]`、既定は `None` にして関数内で `subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")` を使う（`bundle_common` へ依存させない）。docstring の「同型の修正が …」の 1 文は削除する。
- ファイル冒頭の import に `import subprocess` を足す。
- モジュール docstring に 1 段落追加: `pip を呼ぶ入口の列挙ガード(\`KNOWN_PIP_ENTRYPOINTS\` / \`find_pip_call_files\`)もここに置く。検査を経ない pip 入口を作らないための機械検査で、\`scripts/test_python_tools_scripts.py\` が既知集合との一致を固定する。`

`scripts/setup_dev.py:121` の `` `offline/publish_bundle.py` (`find_pip_call_files`) `` を `` `scripts/check_requirements.py` (`find_pip_call_files`) `` に直す。

- [ ] **Step 3: テスト**

Run: `py -3.13 -m pytest scripts -q -k "pip_entrypoint or find_pip_call_files"`
Expected: PASS（`.github/workflows/ci.yml` / `docs/_build/build_all.bat` / `scripts/setup_dev.py` / `scripts/lib/build_venv.py` が検出され、いずれも check_requirements マーカーを持つ）。

- [ ] **Step 4: コミットは Task 11 でまとめる**

---

### Task 11: `offline/setup_offline.py` を HTTPS 取得 + 整合検査 + 展開へ書き直し、不要ファイルを消す

**Files:**
- Rewrite: `offline/setup_offline.py`
- Delete: `offline/publish_bundle.py`, `offline/publish-bundle.bat`, `offline/new_signing_key.py`, `offline/bundle-signing.pub.pem`, `offline/pinned-release.txt`, `offline/dev-requirements.txt`
- Modify: `scripts/test_python_tools_scripts.py`（`publish_bundle` / `new_signing_key` / `setup_offline` 手順 1・2・6・7・8 のテストを削除し、新 setup のテストを追加）, `.github/workflows/ci.yml:42-44`（コメント）

**Interfaces:**
- Produces（`setup_offline` の公開名）: `find_local_bundle(repo_root) -> tuple[Path, Path] | None` / `download_release_assets(tag, dest_dir, *, owner, repo, http_download) -> tuple[Path, Path, Path]` / `verify_bundle_sha256_sidecar(bundle_path, sha_path)` / `verify_local_checkout_matches_bundle_key(key_path, repo_root)` / `extract_bundle(bundle_path, repo_root)` / `remove_extracted_bundle(repo_root)` / `main(argv)`。

- [ ] **Step 1: 削除**

```powershell
$o = 'C:\Users\caads\python-tools\offline'
Remove-Item "$o\publish_bundle.py", "$o\publish-bundle.bat", "$o\new_signing_key.py", "$o\bundle-signing.pub.pem", "$o\pinned-release.txt", "$o\dev-requirements.txt"
```

- [ ] **Step 2: テストを書き換える**

`scripts/test_python_tools_scripts.py`:
- import から `import publish_bundle` / `import new_signing_key` を削除。
- モジュール docstring の `offline/publish_bundle.py` に関する 2 段落と `setup_offline` の説明を、「`offline/setup_offline.py` は手元のバンドル探索 → Release からの HTTPS 取得 → `.sha256` 照合 → content-key 照合 → 展開の各部品を対象とする。HTTP 取得は注入可能で実ネットワークへはアクセスしない。」に差し替える。
- 次の節を削除: `# ── publish_bundle: 純粋な判定/構築部品 ──` から `# ── main: bundle_hash フォールバック ──` の終わり（`test_main_raises_when_neither_pin_nor_sha_file_available`）まで、`_FakeRunner` / `_completed` を含む。`test_create_signing_key_pair_*`（4 件）と `_NoAuthRedirectHandler` の 2 件、`load_pin_and_public_key` 3 件、`gh_download_bundle_assets` / `fetch_bundle_assets` 6 件と `_make_bundle_asset_files`、`verify_bundle_sha256` 2 件、`build_pip_install_command` 1 件、`verify_bundle_signature_or_cleanup` 3 件、`gh_auth_token` 〜 `verify_source_zip_sha256` 8 件、`test_main_runs_bootstrap_steps_in_correct_order`。
- `_make_bundle_tar` と `extract_bundle` / `remove_extracted_bundle` / `verify_local_checkout_matches_bundle_key` / `test_i3_...` のテストは残し、`publish_bundle.` → `bundle_common.` に置換する。
- 次を追加する（`# ── extract_bundle / remove_extracted_bundle ──` 節の前）:

```python
# ── find_local_bundle: 直下優先、無ければ bk\ ──
def test_find_local_bundle_prefers_repo_root(tmp_path):
    (tmp_path / bundle_common.BUNDLE_NAME).write_bytes(b"b")
    (tmp_path / bundle_common.BUNDLE_KEY_NAME).write_text("k", encoding="ascii")
    bk = tmp_path / "bk"
    bk.mkdir()
    (bk / bundle_common.BUNDLE_NAME).write_bytes(b"old")
    (bk / bundle_common.BUNDLE_KEY_NAME).write_text("old", encoding="ascii")
    found = setup_offline.find_local_bundle(tmp_path)
    assert found == (tmp_path / bundle_common.BUNDLE_NAME, tmp_path / bundle_common.BUNDLE_KEY_NAME)


def test_find_local_bundle_falls_back_to_bk(tmp_path):
    bk = tmp_path / "bk"
    bk.mkdir()
    (bk / bundle_common.BUNDLE_NAME).write_bytes(b"b")
    (bk / bundle_common.BUNDLE_KEY_NAME).write_text("k", encoding="ascii")
    assert setup_offline.find_local_bundle(tmp_path) == (bk / bundle_common.BUNDLE_NAME, bk / bundle_common.BUNDLE_KEY_NAME)


def test_find_local_bundle_requires_both_files(tmp_path):
    (tmp_path / bundle_common.BUNDLE_NAME).write_bytes(b"b")
    assert setup_offline.find_local_bundle(tmp_path) is None


# ── download_release_assets: 3 アセットを HTTPS で取得(注入したダウンローダで検証) ──
def test_download_release_assets_fetches_bundle_sha256_and_key(tmp_path):
    urls: list[str] = []

    def fake_download(url, dest):
        urls.append(url)
        dest.write_bytes(b"x")

    bundle, sha, key = setup_offline.download_release_assets(
        "offline-bundle-v1", tmp_path, owner="o", repo="r", http_download=fake_download
    )
    base = "https://github.com/o/r/releases/download/offline-bundle-v1"
    assert urls == [
        f"{base}/{bundle_common.BUNDLE_NAME}",
        f"{base}/{bundle_common.BUNDLE_NAME}.sha256",
        f"{base}/{bundle_common.BUNDLE_KEY_NAME}",
    ]
    assert bundle.is_file() and sha.is_file() and key.is_file()


def test_download_release_assets_raises_when_download_fails(tmp_path):
    def failing(url, dest):
        raise OSError("boom")

    with pytest.raises(RuntimeError):
        setup_offline.download_release_assets("t", tmp_path, owner="o", repo="r", http_download=failing)


# ── verify_bundle_sha256_sidecar: Release の .sha256(転送破損の検知) ──
def test_verify_bundle_sha256_sidecar_passes_on_match(tmp_path):
    b = tmp_path / "b.tar.gz"
    b.write_bytes(b"payload")
    s = tmp_path / "b.tar.gz.sha256"
    s.write_text(f"{hashlib.sha256(b'payload').hexdigest()}  b.tar.gz", encoding="ascii")
    setup_offline.verify_bundle_sha256_sidecar(b, s)


def test_verify_bundle_sha256_sidecar_raises_on_mismatch(tmp_path):
    b = tmp_path / "b.tar.gz"
    b.write_bytes(b"payload")
    s = tmp_path / "b.tar.gz.sha256"
    s.write_text(f"{'0' * 64}  b.tar.gz", encoding="ascii")
    with pytest.raises(RuntimeError):
        setup_offline.verify_bundle_sha256_sidecar(b, s)


# ── main: 手元のバンドルがあれば取得しない / 無ければ取得して .sha256 を照合する ──
def test_main_uses_local_bundle_without_download(monkeypatch, tmp_path):
    calls: list[str] = []
    monkeypatch.setattr(setup_offline, "ROOT", tmp_path)
    monkeypatch.setattr(setup_offline, "find_local_bundle", lambda root: (tmp_path / "b", tmp_path / "k"))
    monkeypatch.setattr(setup_offline, "download_release_assets", lambda *a, **k: calls.append("download"))
    monkeypatch.setattr(setup_offline, "verify_bundle_sha256_sidecar", lambda *a, **k: calls.append("sha256"))
    monkeypatch.setattr(
        setup_offline, "verify_local_checkout_matches_bundle_key", lambda *a, **k: calls.append("key")
    )
    monkeypatch.setattr(setup_offline, "extract_bundle", lambda *a, **k: calls.append("extract"))
    assert setup_offline.main([]) == 0
    assert calls == ["key", "extract"]


def test_main_downloads_and_checks_sidecar_when_no_local_bundle(monkeypatch, tmp_path):
    calls: list[str] = []
    monkeypatch.setattr(setup_offline, "ROOT", tmp_path)
    monkeypatch.setattr(setup_offline, "find_local_bundle", lambda root: None)

    def fake_download(tag, dest_dir, **kwargs):
        calls.append("download")
        return dest_dir / "b", dest_dir / "b.sha256", dest_dir / "k"

    monkeypatch.setattr(setup_offline, "download_release_assets", fake_download)
    monkeypatch.setattr(setup_offline, "verify_bundle_sha256_sidecar", lambda *a, **k: calls.append("sha256"))
    monkeypatch.setattr(
        setup_offline, "verify_local_checkout_matches_bundle_key", lambda *a, **k: calls.append("key")
    )
    monkeypatch.setattr(setup_offline, "extract_bundle", lambda *a, **k: calls.append("extract"))
    assert setup_offline.main([]) == 0
    assert calls == ["download", "sha256", "key", "extract"]
```

Run: `py -3.13 -m pytest scripts -q`
Expected: 収集エラー（`setup_offline` の import 失敗）または新テストの FAIL。

- [ ] **Step 3: `offline/setup_offline.py` を書く（全文）**

```python
# -*- coding: utf-8 -*-
"""offline 重量物バンドルの取得・整合検査・展開(配布先のセットアップ)。

重量物(`python-wheelhouse/` + `docs/_build/vendor/` の mermaid JS)は git に入れず GitHub
Releases(タグ `offline-bundle-v1`)に置いてある。ソースコードは `git clone` で手元にある前提。

手順:
  1. リポジトリ直下(または `bk\\`)に `offline-deps-bundle.tar.gz` と `bundle.key` があれば
     それを使う。無ければ Release から HTTPS で直取得し(`gh` 不要。リポジトリは Public)、
     Release に並ぶ `.sha256` と突き合わせて転送破損を検知する。
  2. **展開の前に**、手元のソース(git 管理下の requirements.txt / manifest.txt)が重量物と
     対の組であることを `bundle.key`(content-key)で確認する。展開の後に測ると、バンドル
     同梱の manifest.txt が git 管理下の実体を上書きし、以後の照合が「バンドル自身との
     堂々巡り」になって manifest の差分を検知できなくなる。
  3. 展開する。

バンドルの真正性は検証しない。Release を更新できるのはリポジトリ所有者だけで、配布先は同じ
所有者の Public リポジトリを clone している前提で受け入れる。content-key の不一致は改ざんではなく
「依存を変えたのに publish していない」状態で、配布担当に
`local-only\\offline-publish\\publish-bundle.bat` の実行を依頼する。

HTTP 取得を行う関数は呼び出し側から差し替え可能にしている(単体テストは偽ダウンローダを注入し、
実ネットワークへはアクセスしない)。
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
import tempfile
import urllib.request
from pathlib import Path
from typing import Callable

_HERE = Path(__file__).resolve().parent
ROOT = _HERE.parent
sys.path.insert(0, str(_HERE / "lib"))

import bundle_common  # noqa: E402

DEFAULT_OWNER = "koichi-araki-0801"
DEFAULT_REPO = "python-tools"

Downloader = Callable[[str, Path], None]

# GitHub Releases の 1 アセット上限(2GB)と同じ値で天井を切り、想定外の巨大応答を受け続けない。
_DOWNLOAD_TIMEOUT_SECONDS = 300
_MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024 * 1024


# ── 手順1a: 手元のバンドル探索 ──


def find_local_bundle(repo_root: Path) -> tuple[Path, Path] | None:
    """直下、無ければ `bk\\` から `(バンドル, bundle.key)` を探す。両方揃った場所だけを返す。"""
    for directory in (repo_root, repo_root / "bk"):
        bundle = directory / bundle_common.BUNDLE_NAME
        key = directory / bundle_common.BUNDLE_KEY_NAME
        if bundle.is_file() and key.is_file():
            return bundle, key
    return None


# ── 手順1b: Release からの HTTPS 取得 ──


def _http_download(url: str, dest: Path) -> None:
    with urllib.request.urlopen(url, timeout=_DOWNLOAD_TIMEOUT_SECONDS) as response:  # noqa: S310
        total = 0
        with dest.open("wb") as out:
            while True:
                chunk = response.read(1024 * 1024)
                if not chunk:
                    break
                total += len(chunk)
                if total > _MAX_DOWNLOAD_BYTES:
                    raise RuntimeError(f"ダウンロードが上限({_MAX_DOWNLOAD_BYTES} bytes)を超えました: {url}")
                out.write(chunk)


def download_release_assets(
    tag: str,
    dest_dir: Path,
    *,
    owner: str = DEFAULT_OWNER,
    repo: str = DEFAULT_REPO,
    http_download: Downloader = _http_download,
) -> tuple[Path, Path, Path]:
    """Release からバンドル本体・`.sha256`・`bundle.key` を取得し `(bundle, sha256, key)` を返す。"""
    base = f"https://github.com/{owner}/{repo}/releases/download/{tag}"
    bundle_path = dest_dir / bundle_common.BUNDLE_NAME
    sha_path = dest_dir / f"{bundle_common.BUNDLE_NAME}.sha256"
    key_path = dest_dir / bundle_common.BUNDLE_KEY_NAME
    try:
        http_download(f"{base}/{bundle_common.BUNDLE_NAME}", bundle_path)
        http_download(f"{base}/{bundle_common.BUNDLE_NAME}.sha256", sha_path)
        http_download(f"{base}/{bundle_common.BUNDLE_KEY_NAME}", key_path)
    except Exception as exc:
        raise RuntimeError(
            f"重量物バンドルの取得に失敗しました(タグ {tag} / ネットワーク / リポジトリの公開状態を"
            f"確認してください)。詳細: {exc}"
        ) from exc
    if not (bundle_path.is_file() and sha_path.is_file() and key_path.is_file()):
        raise RuntimeError("重量物バンドルの取得に失敗しました(ファイルが作成されませんでした)。")
    return bundle_path, sha_path, key_path


def verify_bundle_sha256_sidecar(bundle_path: Path, sha_path: Path) -> None:
    """Release に並ぶ `.sha256`(形式 `<hex>  <name>`)と実ファイルを照合する(転送破損の検知)。"""
    expected = sha_path.read_text(encoding="ascii").strip().split()[0].lower()
    actual = bundle_common.sha256_file(bundle_path)
    if actual != expected:
        raise RuntimeError(
            f"バンドルの sha256 が Release の .sha256 と一致しません(期待={expected} / 実際={actual})。\n"
            "  転送中の破損の可能性があります。取得し直してください。"
        )


# ── 手順2: 手元のソースが重量物と対の組であることの確認(展開の前に行う) ──


def remove_extracted_bundle(repo_root: Path = ROOT) -> None:
    """展開済みの重量物(python-wheelhouse / vendor の JS 2 件)を削除する。manifest.txt は git 管理下なので残す。"""
    wheelhouse_dir = repo_root / bundle_common.WHEELHOUSE_DIR_NAME
    if wheelhouse_dir.is_dir():
        shutil.rmtree(wheelhouse_dir, ignore_errors=True)
    vendor_dir = repo_root / "docs" / "_build" / "vendor"
    for name in bundle_common.VENDOR_JS_ASSET_NAMES:
        p = vendor_dir / name
        if p.is_file():
            p.unlink(missing_ok=True)


def verify_local_checkout_matches_bundle_key(key_path: Path, repo_root: Path = ROOT) -> None:
    """手元の checkout が、取得した重量物と対の組であることを content-key で確かめる。

    **必ず `extract_bundle` の前に呼ぶこと。** `docs/_build/vendor/manifest.txt` は git 追跡下で
    clean clone に必ず存在するため展開前でも算出できる。展開後に測ると、バンドル同梱の
    manifest.txt が git 管理下の実体を上書きし、manifest だけの差分を検知できなくなる。
    """
    bundle_key = bundle_common.read_bundle_key(key_path)
    local_key = bundle_common.compute_content_key(repo_root)
    if local_key != bundle_key:
        remove_extracted_bundle(repo_root)
        raise RuntimeError(
            "手元のソースと重量物が対の組ではありません"
            f"(ローカル content-key={local_key} / bundle.key={bundle_key})。\n"
            "  requirements.txt や docs/_build/vendor/manifest.txt を変えたのに Release を更新していない"
            "可能性があります。配布担当に local-only\\offline-publish\\publish-bundle.bat の実行を"
            "依頼するか、bundle.key に対応するコミットへ checkout し直してください。"
        )


# ── 手順3: 展開 ──


def extract_bundle(bundle_path: Path, repo_root: Path = ROOT) -> None:
    """バンドルを repo_root 直下へ展開する(python-wheelhouse / docs/_build/vendor)。"""
    tar_exe = bundle_common.resolve_tar_exe()
    result = subprocess.run([tar_exe, "-xzf", str(bundle_path), "-C", str(repo_root)])
    if result.returncode != 0:
        raise RuntimeError("重量物の展開(tar)に失敗しました。")
    wheelhouse_dir = repo_root / bundle_common.WHEELHOUSE_DIR_NAME
    if not wheelhouse_dir.is_dir():
        raise RuntimeError(f"展開後に {wheelhouse_dir} が見つかりません(バンドルが不完全です)。")
    bundle_common.assert_vendor_assets_present(repo_root)


# ── CLI ──


def parse_args(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--owner", default=DEFAULT_OWNER, help=f"GitHub オーナー名(既定 {DEFAULT_OWNER})")
    parser.add_argument("--repo", default=DEFAULT_REPO, help=f"リポジトリ名(既定 {DEFAULT_REPO})")
    parser.add_argument(
        "--tag", default=bundle_common.DEFAULT_TAG, help=f"取得元タグ(既定 {bundle_common.DEFAULT_TAG})"
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)

    with tempfile.TemporaryDirectory(prefix="python-tools-setup-") as tmp_name:
        tmp_dir = Path(tmp_name)
        local = find_local_bundle(ROOT)
        if local is not None:
            bundle_path, key_path = local
            print(f"[1/3] 手元のバンドルを使います: {bundle_path}")
        else:
            print(f"[1/3] Release {args.tag} からバンドルを HTTPS で取得します...")
            bundle_path, sha_path, key_path = download_release_assets(
                args.tag, tmp_dir, owner=args.owner, repo=args.repo
            )
            verify_bundle_sha256_sidecar(bundle_path, sha_path)
            print("[info] sha256 OK(転送破損なし)。")

        print("[2/3] 手元のソースが重量物と対の組であることを bundle.key で確認します...")
        verify_local_checkout_matches_bundle_key(key_path)
        print("[info] content key 一致。")

        print("[3/3] バンドルを展開します(python-wheelhouse / docs/_build/vendor)...")
        extract_bundle(bundle_path)

    print()
    print("=" * 60)
    print(" offline セットアップ完了")
    print("=" * 60)
    print(f"  wheelhouse : {ROOT / bundle_common.WHEELHOUSE_DIR_NAME}")
    print(f"  vendor     : {ROOT / 'docs' / '_build' / 'vendor'}")
    print()
    print("次は setup-dev.bat を実行して開発依存を導入してください。")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (RuntimeError, ValueError) as exc:
        print(f"[error] {exc}", file=sys.stderr)
        sys.exit(1)
```

- [ ] **Step 4: `ci.yml` のコメントを直す**

42〜44 行の `正典は \`offline/publish_bundle.py\` の \`KNOWN_PIP_ENTRYPOINTS\`` を `正典は \`scripts/check_requirements.py\` の \`KNOWN_PIP_ENTRYPOINTS\`` に、62 行の `offline 一式` を `offline の setup` に直す。

- [ ] **Step 5: テストとコメント検査**

Run: `py -3.13 -m pytest scripts -q`
Expected: PASS（Task 9・10・11 の分がすべて緑）。

Run: `py -3.13 scripts\check_comments.py`
Expected: exit 0。

Run: `py -3.13 offline\setup_offline.py`（この端末。直下に `offline-deps-bundle.tar.gz` と `bundle.key` がある）
Expected: `[1/3] 手元のバンドルを使います`。`[2/3]` は **content-key 不一致で中止する**（`dev-requirements.txt` を消したので手元の key が変わっている。Task 13 で publish して解消する）。エラーメッセージが上記の文言で出ることを確認する。

- [ ] **Step 6: コミット（Task 9・10・11 をまとめて）**

```
git add -A offline scripts/check_requirements.py scripts/setup_dev.py scripts/test_python_tools_scripts.py .github/workflows/ci.yml
git commit -m "refactor(offline): setup を HTTPS 取得と content-key 照合だけにし、署名・pin・gh 経路を外す"
```

pre-push の pytest 一式（約 100 秒）が通り auto-push されることを確認する。

---

### Task 12: `local-only/offline-publish/publish_bundle.py`（この端末専用）

**Files:**
- Create: `local-only/offline-publish/publish_bundle.py`, `local-only/offline-publish/publish-bundle.bat`

**Interfaces:**
- Consumes: `bundle_common`（`compute_content_key` / `list_requirements_files` / `assert_vendor_assets_present` / `build_tar_command` / `resolve_tar_exe` / `sha256_file` / `write_bundle_key` / `read_bundle_key` / `default_runner` / 定数）、`check_requirements.assert_requirements_file`。

- [ ] **Step 1: 書く（全文）**

```python
# -*- coding: utf-8 -*-
"""offline 重量物バンドル(`python-wheelhouse/` + `docs/_build/vendor/`)を生成し、GitHub Releases
(タグ `offline-bundle-v1`)のアセットを差し替える。配布担当の端末だけで手動実行する
(git 管理外の `local-only/` に置く。自動化フックは無い)。

行うこと:
  1. HEAD が origin へ push 済みであることを確認する(他端末が clone する HEAD と組の重量物を上げる)。
  2. content-key(`bundle_common.compute_content_key`)を算出し、Release 側の `bundle.key` と
     比較する。一致すれば何もしない(`--force` で強制)。
  3. vendor 前提(mermaid JS 2 件 + manifest.txt)を検査し、requirements を検査してから
     `pip download` で wheelhouse を組み、tar.gz へ固める。
  4. tar.gz / `.sha256` / `bundle.key` を `gh release upload --clobber` で差し替える。
     タグは動かさない。ソースは git clone で配る。
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

_HERE = Path(__file__).resolve().parent
ROOT = _HERE.parent.parent
sys.path.insert(0, str(ROOT / "offline" / "lib"))
sys.path.insert(0, str(ROOT / "scripts"))

import bundle_common  # noqa: E402
from check_requirements import assert_requirements_file  # noqa: E402

PYTHON_VERSION = "3.13"
_MAX_RELEASE_ASSET_BYTES = 2 * 1024 * 1024 * 1024


def _run(cmd: list[str]) -> subprocess.CompletedProcess:
    return bundle_common.default_runner(cmd)


def require_commands(names: list[str]) -> None:
    for name in names:
        if shutil.which(name) is None:
            raise RuntimeError(f"'{name}' が見つかりません。インストール/認証を確認してください。")


def assert_head_pushed() -> str:
    head = _run(["git", "-C", str(ROOT), "rev-parse", "HEAD"])
    if head.returncode != 0:
        raise RuntimeError("git HEAD を取得できません。")
    head_sha = head.stdout.strip()
    remote = _run(["git", "-C", str(ROOT), "ls-remote", "origin"])
    if remote.returncode != 0:
        raise RuntimeError("git ls-remote origin に失敗しました。")
    remote_shas = {line.split("\t", 1)[0] for line in remote.stdout.splitlines() if line.strip()}
    if head_sha not in remote_shas:
        raise RuntimeError(f"HEAD ({head_sha}) が origin へ push されていません。先に git push してください。")
    return head_sha


def fetch_published_key(tag: str, dest_dir: Path) -> str | None:
    result = _run(["gh", "release", "download", tag, "--pattern", "bundle.key", "--dir", str(dest_dir), "--clobber"])
    key_file = dest_dir / bundle_common.BUNDLE_KEY_NAME
    if result.returncode != 0 or not key_file.is_file():
        return None
    return bundle_common.read_bundle_key(key_file)


def build_wheelhouse(wheelhouse_dir: Path, requirements_files: list[Path]) -> None:
    # 検査(assert_requirements_file)は pip 実行の直前・全ファイルに対して行う。
    for req in requirements_files:
        assert_requirements_file(req)
    if wheelhouse_dir.exists():
        shutil.rmtree(wheelhouse_dir)
    wheelhouse_dir.mkdir(parents=True)
    # `--python-version 3.13 --only-binary=:all:` で wheel の ABI を cp313 に固定し sdist を排除する。
    cmd = [
        sys.executable, "-m", "pip", "download", "--no-input", "--disable-pip-version-check",
        "--python-version", PYTHON_VERSION, "--index-url", "https://pypi.org/simple",
        "--only-binary=:all:", "-d", str(wheelhouse_dir),
    ]
    for req in requirements_files:
        cmd += ["-r", str(req)]
    if subprocess.run(cmd, cwd=ROOT).returncode != 0:
        raise RuntimeError("pip download(wheelhouse 収集)に失敗しました。")


def build_bundle_tar(bundle_path: Path) -> None:
    if bundle_path.exists():
        bundle_path.unlink()
    cmd = bundle_common.build_tar_command(bundle_common.resolve_tar_exe(), bundle_path, ROOT)
    if subprocess.run(cmd).returncode != 0:
        raise RuntimeError("tar による重量物の梱包に失敗しました。")


def parse_args(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tag", default=bundle_common.DEFAULT_TAG, help=f"公開先タグ(既定 {bundle_common.DEFAULT_TAG})")
    parser.add_argument("--force", action="store_true", help="変更検知を無視して常に再生成・再アップロードする")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    require_commands(["git", "gh"])
    assert_head_pushed()

    requirements_files = bundle_common.list_requirements_files(ROOT)
    if not requirements_files:
        raise RuntimeError("requirements.txt が見つかりません。")
    current_key = bundle_common.compute_content_key(ROOT, requirements_files=requirements_files)
    print(f"[info] current content key: {current_key}")

    with tempfile.TemporaryDirectory(prefix="python-tools-publish-") as tmp_name:
        if _run(["gh", "release", "view", args.tag]).returncode != 0:
            raise RuntimeError(f"Release {args.tag} がありません。GitHub で先に作成してください。")
        published_key = fetch_published_key(args.tag, Path(tmp_name))
        print(f"[info] published key: {published_key or '(none)'}")
        if published_key == current_key and not args.force:
            print(f"[OK] 重量物は Release {args.tag} と一致しています(変更なし)。")
            return 0

    bundle_common.assert_vendor_assets_present(ROOT)
    build_wheelhouse(ROOT / bundle_common.WHEELHOUSE_DIR_NAME, requirements_files)
    bundle_path = ROOT / bundle_common.BUNDLE_NAME
    build_bundle_tar(bundle_path)
    size = bundle_path.stat().st_size
    if size >= _MAX_RELEASE_ASSET_BYTES:
        raise RuntimeError(f"{bundle_common.BUNDLE_NAME} が Release の上限 2GB を超えました({size} bytes)。")

    sha_path = ROOT / f"{bundle_common.BUNDLE_NAME}.sha256"
    key_path = ROOT / bundle_common.BUNDLE_KEY_NAME
    sha_path.write_text(f"{bundle_common.sha256_file(bundle_path)}  {bundle_common.BUNDLE_NAME}", encoding="ascii")
    bundle_common.write_bundle_key(key_path, current_key)

    result = _run(["gh", "release", "upload", args.tag, str(bundle_path), str(sha_path), str(key_path), "--clobber"])
    if result.returncode != 0:
        raise RuntimeError(f"gh release upload に失敗しました: {result.stderr}")
    print(f"[OK] 公開完了: {args.tag} に {bundle_common.BUNDLE_NAME} / .sha256 / bundle.key を反映しました。")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except RuntimeError as exc:
        print(f"[error] {exc}", file=sys.stderr)
        sys.exit(1)
```

`publish-bundle.bat`（CRLF）:

```bat
@echo off
chcp 65001 >nul
rem 同梱の publish_bundle.py を py -3.13 で実行する(引数はそのまま転送)。配布担当の端末専用。
py -3.13 "%~dp0publish_bundle.py" %*
exit /b %ERRORLEVEL%
```

- [ ] **Step 2: 構文検査**

Run: `py -3.13 -m py_compile local-only\offline-publish\publish_bundle.py`
Expected: exit 0。

- [ ] **Step 3: `git status --short` に `local-only` が出ないことを確認する**

---

### Task 13: python-tools のフック・README・CLAUDE.md を直す

**Files:**
- Modify: `scripts/hooks/post_commit.py`, `scripts/hooks/pre_push.py`, `scripts/test_python_tools_scripts.py`, `README.md:25-50`, `CLAUDE.md:18-32,64-66`, `offline/README-offline.md`（全面書き直し）

- [ ] **Step 1: テストを先に削る・直す**

`scripts/test_python_tools_scripts.py` から削除:
- `# ── parse_remote_refs ──` 〜 `# ── count_ahead_of_upstream ──` の各節（`test_parse_remote_refs_*` 6 件、`test_decide_pre_push_action_*` 8 件、`test_count_ahead_of_upstream_*` 2 件）。
- `# ── publish_tag_only ──` 節（3 件）と `test_main_still_runs_publish_tag_only_after_auto_push_raises`。

`test_main_always_returns_zero_even_when_steps_fail` は auto-push だけを差し替える形に直す（`publish_tag_only` への monkeypatch 行を削除）。`test_main_runs_check_comments_before_pytest_suite_and_stops_on_failure` / `test_main_runs_pytest_suite_after_check_comments_passes` は stdin を monkeypatch していれば、その行を削除する。

Run: `py -3.13 -m pytest scripts -q -k "pre_push or post_commit"`
Expected: 削除済みの参照は無いので PASS（あるいは stdin 関連で FAIL → Step 2 で解消）。

- [ ] **Step 2: `post_commit.py`**

- docstring の「2. `offline/publish_bundle.py --tag-only` …」段落と「`git` / `publish_bundle.py` を実際に呼ぶ処理は」の `publish_bundle.py` 部分を削除し、1 行目を `"""post-commit フック本体。auto-push のベストエフォート呼び出し。` にする。
- `PUBLISH_BUNDLE` の定義、`# ── 2. publish_bundle.py --tag-only ──` 節（`publish_tag_only` 関数）、`main` の `_run_best_effort_step("publish_bundle.py --tag-only", publish_tag_only)` を削除。`import os` が未使用になれば削除。

- [ ] **Step 3: `pre_push.py`**

- docstring の 1 行目を `"""pre-push フック本体。check_comments と pytest 一式を順に実行する。` にし、「判定ロジックは monorepo …」の段落（タグのみスキップの説明）を削除する。
- `parse_remote_refs` / `count_ahead_of_upstream` / `decide_pre_push_action` を削除する。
- `main` を次にする:

```python
def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")

    started = time.monotonic()
    code = run_check_comments()
    if code == 0:
        code = run_pytest_suite()
    elapsed = time.monotonic() - started
    print(f"[pre-push] 検証一式 合計 {elapsed:.1f}s (exit {code})")
    if code != 0:
        print("[pre-push] 検証が失敗しました。上記を修正してから push してください。", file=sys.stderr)
    return code
```

- [ ] **Step 4: README / CLAUDE.md / README-offline.md**

`README.md`:
- 25〜27 行: 「無ければ「先に `offline\setup-offline.bat` を実行してください」と表示して失敗する。」はそのまま。
- 「開発フロー(Git hooks)」の post-commit から「2. `offline/publish_bundle.py --tag-only` …」を削除。pre-push の「push 対象が**タグのみ**（…）なら … スキップする（実測 2 秒程度）。ブランチ ref を 1 つでも含む push では」を「毎回」に直す。
- 「セットアップ」節の直後に小節を足す:

```markdown
### オフライン重量物の取得

`offline\setup-offline.bat` は、リポジトリ直下(または `bk\`)に `offline-deps-bundle.tar.gz` と
`bundle.key` があればそれを、無ければ GitHub Releases(タグ `offline-bundle-v1`)から HTTPS で
取得して展開する。展開の前に `bundle.key` と手元の requirements / manifest の content-key を
突き合わせ、不一致なら止まる。詳細は `offline/README-offline.md`。重量物の生成と Release の
更新は配布担当の端末にある git 管理外の `local-only/offline-publish/publish-bundle.bat` で行う。
```

`CLAUDE.md`（git 管理外）: post-commit の `offline/publish_bundle.py --tag-only` の記述、pre-push の「タグのみならスキップ」を削除。65 行の雛形列挙から `offline/publish-bundle.bat` を外す。

`offline/README-offline.md` を全面書き直し（Task 6 Step 1 の内容を python-tools 向けに。重量物 = `python-wheelhouse/` と `docs/_build/vendor/` の JS 2 件、入口 = `offline\setup-offline.bat` → 続けて `setup-dev.bat`、生成 = `local-only\offline-publish\publish-bundle.bat`、content-key の入力 = 各 `requirements.txt` + `docs/_build/vendor/manifest.txt`。「一時 Public 化」「中断時は visibility を確認」「レート制限」の節はすべて削除）。

- [ ] **Step 5: 検査とコミット**

Run: `py -3.13 -m pytest scripts -q`
Expected: PASS。

Run: `py -3.13 scripts\check_comments.py`
Expected: exit 0。

```
git add scripts/hooks/post_commit.py scripts/hooks/pre_push.py scripts/test_python_tools_scripts.py README.md offline/README-offline.md
git commit -m "chore(hooks): post-commit の Release 連動とタグのみ push のスキップを撤去し、手順を書き直す"
```

コミット後、post-commit の出力が auto-push の 1 行だけであること、pre-push が pytest 一式を走らせて push されることを確認する。

---

### Task 14: 実機検証（両リポジトリ）

- [ ] **Step 1: python-tools の Release を更新する（content-key が変わった）**

Run: `C:\Users\caads\python-tools\local-only\offline-publish\publish-bundle.bat`
Expected: `[info] published key:` が current と不一致 → wheelhouse 再生成 → `[OK] 公開完了`。

Run: `gh release view offline-bundle-v1 -R koichi-araki-0801/python-tools --json assets -q ".assets[].name"`
Expected: `bundle.key` / `offline-deps-bundle.tar.gz` / `offline-deps-bundle.tar.gz.sha256`（`.sig` は古いまま残る。次で消す）。

Run: `gh release delete-asset offline-bundle-v1 offline-deps-bundle.tar.gz.sig -R koichi-araki-0801/python-tools -y`
Expected: 削除される。monorepo 側も同様に `.sig` を消す:
`gh release delete-asset offline-bundle-v1 offline-deps-bundle.tar.gz.sig -R koichi-araki-0801/workspace -y`

- [ ] **Step 2: monorepo の publish が「変更なし」で終わることを確認する**

Run: `C:\Users\caads\workspace\local-only\offline-publish\publish-offline-bundle.bat`
Expected: `[OK] 重量物は Release offline-bundle-v1 と一致しています（変更なし）。`

- [ ] **Step 3: 他端末相当の E2E（monorepo）**

```powershell
$v = 'C:\Users\Public\offline-verify\workspace-e2e'
if (Test-Path $v) { Remove-Item -Recurse -Force $v }
git clone https://github.com/koichi-araki-0801/workspace.git $v
git -C $v checkout chore/deps-latest-offline-bundle
$env:DATA_ROOT = "$v\editor-data-e2e"; $env:GIT_BIN = ''
& "$v\offline\setup-offline.bat"
```

Expected: `[1/5]` で Release から取得、`sha256 OK`、`[3/5] content-key 一致`、`[4/5]` の install / build 完走、`[OK] セットアップ完了。`、`bk\` に 3 ファイル。所要 10〜20 分。

続けて手元バンドル経路: `bk\` の 3 ファイルを `$v` 直下へ戻し `& "$v\offline\setup-offline.bat" -SkipBuild` → `手元のバンドルを使います` と `退避はありません`。

- [ ] **Step 4: 他端末相当の E2E（python-tools）**

```powershell
$v = 'C:\Users\Public\offline-verify\python-tools-e2e'
if (Test-Path $v) { Remove-Item -Recurse -Force $v }
git clone https://github.com/koichi-araki-0801/python-tools.git $v
& "$v\offline\setup-offline.bat"
& "$v\setup-dev.bat"
```

Expected: `[1/3] Release offline-bundle-v1 からバンドルを HTTPS で取得します`、`sha256 OK`、`content key 一致`、`offline セットアップ完了`。`setup-dev.bat` が wheelhouse から導入して完走。

- [ ] **Step 5: タグと push 状態**

Run: `git ls-remote --tags origin offline-bundle-v1`（両リポジトリ）
Expected: Task 7 Step 2 / Task 8 以降のコミットで SHA が変わっていない。

Run: `git status -sb`（両リポジトリ）
Expected: `ahead` 0。

- [ ] **Step 6: フル CI（monorepo）**

Run: `pnpm run ci`
Expected: exit 0。

- [ ] **Step 7: 記録**

`docs/superpowers/specs/2026-09-06-offline-local-only-design.md` の「状態」を `実装済み（2026-09-06。E2E 実測: monorepo <所要>、python-tools <所要>）` に更新してコミットする。
