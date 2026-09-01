# オフライン構築・実動作確認 検証計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to run this
> plan phase-by-phase. Steps use checkbox (`- [ ]`) syntax for tracking.
> 本計画は「コードを書く計画」ではなく「配布物と実アプリの動作を確認する計画」である。
> したがって各ステップは TDD の RED-GREEN ではなく、**実行コマンド → 期待出力 → 合否判定 →
> 失敗時の対処**の形を取る。

**Goal:** オフライン配布物（`offline/` フォルダ + GitHub Releases の重量物）から別フォルダへ
環境を丸ごと構築し、CI・E2E・editor の実 UI（local / rest 両モード）・pie-chart・docs ビルドまで
「実際に動く」ことを確認する。あわせてリポジトリ分離プロジェクトの残項目 2 件を消化する。

**Architecture:** 検証は 2 フォルダに分ける。`local/` は完全オフライン経路
（`setup-offline-local.bat`、ソースは手元から配置）で構築し、そこで CI・UI・DB・pie-chart・docs の
全動作確認を行う。`full/` は素の `offline/` フォルダだけを置いた状態から
`setup-offline.bat` を走らせ、配布先端末の初回体験（HTTPS 取得を含む完全ブートストラップ）を
再現する。現ワークスペース `C:\Users\caads\workspace` と `C:\Users\caads\editor-data` には
一切変更を加えない。

**Tech Stack:** Windows x64 / PowerShell 5.1 / Node.js 24 / pnpm 11.18.0 / Playwright(Chromium) /
SQL Server 2022 Express LocalDB / Python 3.13

**Spec:** 本計画の設計判断は本ファイル冒頭の「設計判断」節が保持する（独立した spec は作らない）。
関連する正典は `offline/README-offline.txt`、`docs/editor/src/設計正典.md`、
`docs/pie-chart/src/設計正典.md`、`docs/superpowers/plans/2026-08-30-phase5-monorepo-removal.md`
の「実測記録」節。

---

## 設計判断（承認済み）

- **判断 A: pin を HEAD へ更新してから検証する。** 現 pin の `source-commit` は
  `4fcad7f`（履歴初期化のルートコミット）で、以後 5 コミット先行している。すなわち現在の配布物には
  editor の修正 2 本（`58fb84a` / `1deaa66`）と docs 追随が入っていない。
  `4fcad7f..HEAD` の範囲で content-key 対象（`pnpm-lock.yaml` / `package.json` /
  各 `requirements.txt` / `git-tools/manifest.txt` / `docs/_build/vendor/manifest.txt` /
  `native-prebuilds/manifest.txt`）に変更が無いことを確認済みのため、`Publish-Assets` は
  `if (-not $bundleChanged) { return }` で早期 return し、**1.1GB の再アップロードは起きない**。
  publish のソース zip 取得は `gh auth token` による**認証取得**なので、pin 更新に
  Public 化は不要である。
- **判断 B: 検証フォルダは 2 つ（`local/` と `full/`）。** `setup-offline-local.bat` は
  「ソースは既に手元にある」前提の展開＋構築専用、`setup-offline.bat` はソース zip も取る
  完全ブートストラップである。同一フォルダで両方を走らせると 2 本目が上書きになり、
  配布先の初回体験を再現できない。ディスク所要は重量物実測（bundle 1.1GB・展開後
  `.pnpm-store` 863MB / `ms-playwright` 1.4GB / `git-tools` 481MB / `python-wheelhouse` 2MB）から
  1 フォルダあたり約 5GB、2 フォルダで 10GB 前後。空き容量 70GB に対して十分。
- **判断 C: rest モードの DB は既存 LocalDB を共用する。** 接続先
  `(localdb)\MSSQLLocalDB` の DB `usrap` / スキーマ `ug01` をそのまま使う。検証で承認・監査ログの
  行が増えるが実運用 DB ではない。sproc 適用手順そのものの検証（専用 DB の新規作成）は
  本計画のスコープ外とする。

## Global Constraints

- **現ワークスペースを壊さない。** `C:\Users\caads\workspace` および
  `C:\Users\caads\editor-data` へは、Phase 0 の pin 更新コミットと Phase 7 の記録コミットを除いて
  一切書き込まない。検証フォルダは `C:\Users\caads\offline-verify\` 配下に閉じる。
- **検証フォルダはローカルドライブ限定。** `Assert-LocalRepoRoot` がネットワークドライブを
  拒否する（pnpm の symlink / hardlink 構成が成立しないため）。
- **ポート 24680 / 24681 は同時に 1 プロセスのみ。** 検証サーバを起動する前に、現ワークスペース側の
  dev サーバ・rest サーバが動いていないことを確認する。稼働中のまま Playwright を走らせると
  E2E が誤接続して落ちる（2026-08-02 実績）。
- **不具合を見つけても本計画では直さない。** 発見はすべて Phase 7 の記録へ集約し、修正は
  別タスクとして切る。検証の途中で実装を触ると、何を検証した結果なのかが失われる。
- **10 分を超えるコマンドはユーザーに `!` 実行を依頼する。** 背景実行の上限（10 分）を超えるため、
  `pnpm run ci`（13〜15 分）と `setup-offline.bat`（回線次第で 20〜40 分）はエージェントが
  直接実行しない。
- **リポジトリは Public 運用（2026-09-01 にユーザーが意図的な公開であることを確認）。**
  フェーズ 5 の実測記録にある「一時 Public 窓 → PRIVATE 復帰」の運用は現在当てはまらない。
  本計画では可視性を変更しない。Phase 6 の `setup-offline.bat` は Public のまま無認証で
  取得できるため、窓の開閉操作そのものが不要になる。

---

## Phase 0: 準備と pin 更新

**Files:**
- Modify: `offline/pinned-release.txt`（publish が自動更新。手で編集しない）
- Create: `C:\Users\caads\offline-verify\local\workspace\`（検証用ツリー）
- Create: `C:\Users\caads\offline-verify\full\workspace\offline\`（full 用の素のフォルダ）

**Interfaces:**
- Produces: pin の `source-commit`（Phase 1 のソース export と Phase 6 の取得対象が共有する）
- Produces: 検証フォルダのパス（以降の全 Phase が使う）

- [x] **Step 1: リポジトリ可視性の意図をユーザーに確認する**

**結果（2026-09-01）: 意図的な Public 運用**。よって本計画では可視性を変更しない。
Phase 6 Step 1（Public 化）と Step 5（Private 復帰）、Phase 7 Step 1（Private 最終確認）は
不要になったため、それぞれ「現状の確認のみ」へ縮退させた。

- [ ] **Step 2: 前提ツールの存在を確認する**

```powershell
node -v                       # v24.x であること
gh auth status                # koichi-araki-0801 でログイン済みであること
py -3.13 --version            # check:comments が使う
where.exe tar curl            # Windows 標準。両方見つかること
Get-PSDrive C | Select-Object Used,Free   # 空き 20GB 以上あること
```

期待: すべて成功。`node -v` が v24 未満なら以降すべて成立しないので中止する。

- [ ] **Step 3: 稼働中の editor サーバが無いことを確認する**

```powershell
Get-NetTCPConnection -LocalPort 24680,24681 -State Listen -ErrorAction SilentlyContinue
```

期待: 何も返らない。返る場合は該当プロセスを停止してから進む。

- [ ] **Step 4: 現ワークスペースがクリーンであることを確認する**

```powershell
git -C C:\Users\caads\workspace status --porcelain
git -C C:\Users\caads\workspace log --oneline -1
```

期待: 出力が空（clean）で、HEAD が `1deaa66` またはそれ以降。dirty なら先にコミットするか
退避する（publish が pin ファイルを書き換えるため、他の変更と混ざると切り分けできない）。

- [ ] **Step 5: publish を実行して pin を HEAD へ進める**

この端末に PowerShell 7（`pwsh`）は入っていないため、Windows PowerShell 5.1 で起動する。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File C:\Users\caads\workspace\offline\publish-offline-bundle.ps1
```

期待する出力の要点:
- `[info] アセットをアップロード` が **出ない**こと（content-key 無変更 → `Publish-Assets` が
  早期 return する）。もし出たら content-key が変わっている＝前提が崩れているので、
  何が変わったかを確認してからユーザーに判断を仰ぐ。
- `[info] pin 用にソース zip を取得: https://github.com/koichi-araki-0801/workspace/archive/<sha>.zip`
- 最後に `offline\pinned-release.txt` が更新される。

**ハングした場合の対処（既知の弱点・実績 2 回）:** pin 生成段のソース zip 取得には
timeout が無く、停滞するとプロセスが応答を失う。5 分以上進まなければ Ctrl+C で中断し、
次の手動手順で pin を更新する。

```powershell
$sha = (git -C C:\Users\caads\workspace rev-parse HEAD)
$tmp = "$env:TEMP\pinned-source.zip"
"Authorization: Bearer $(gh auth token)" | curl.exe -L --fail --retry 3 --max-time 600 -H '@-' -o $tmp "https://github.com/koichi-araki-0801/workspace/archive/$sha.zip"
(Get-FileHash -LiteralPath $tmp -Algorithm SHA256).Hash.ToLower()
```

得られた sha256 と `$sha` で `offline\pinned-release.txt` の `source-commit` /
`source-zip-sha256` の 2 行を書き換える（`bundle-sha256` は据え置き）。ファイルは
**UTF-8 BOM 付き**を保つこと。

- [ ] **Step 6: pin 更新をコミットする**

```powershell
git -C C:\Users\caads\workspace add offline/pinned-release.txt
git -C C:\Users\caads\workspace commit -m "chore(offline): 実動作確認に先立ち pin を最新コミットへ更新する"
```

post-commit フックがローリングタグ `offline-bundle-v1` を新 HEAD へ移動する（`-TagOnly`）。
auto-push フックが origin へ push する。

- [ ] **Step 7: pin の内容を記録する**

```powershell
Get-Content C:\Users\caads\workspace\offline\pinned-release.txt
```

`source-commit` の値を以降 `<PINNED_SHA>` と呼ぶ。Phase 1 のソース export と Phase 6 の
取得対象は**同一のこの値**でなければならない。値を本計画のこの行に追記する。

- [ ] **Step 8: 検証フォルダを作り、local 用のソースを配置する**

```powershell
$V = 'C:\Users\caads\offline-verify'
New-Item -ItemType Directory -Force -Path "$V\local\workspace","$V\full\workspace" | Out-Null

# pin が指すコミットのツリーをそのまま取り出す（作業ツリーの汚れを持ち込まない）。
$sha = ((Get-Content C:\Users\caads\workspace\offline\pinned-release.txt |
  Select-String '^source-commit ').Line -split ' ')[1]
git -C C:\Users\caads\workspace archive --format=zip -o "$env:TEMP\src-$sha.zip" $sha
tar -xf "$env:TEMP\src-$sha.zip" -C "$V\local\workspace"
```

- [ ] **Step 9: 配布用の `offline/` フォルダを両方の検証フォルダへ上書き配置する**

pin ファイルは `<PINNED_SHA>` の**後**のコミットで更新されているため、git archive の中身は
古い pin を含む。配布先へ手渡しされるのは常に最新の作業ツリーの `offline/` なので、そちらで
上書きする。

```powershell
$V = 'C:\Users\caads\offline-verify'
Copy-Item -Recurse -Force C:\Users\caads\workspace\offline "$V\local\workspace\"
Copy-Item -Recurse -Force C:\Users\caads\workspace\offline "$V\full\workspace\"
```

検証: 両フォルダの `offline\pinned-release.txt` の `source-commit` が `<PINNED_SHA>` と一致すること。

- [ ] **Step 10: local 用の重量物資材をコピーする**

```powershell
$V = 'C:\Users\caads\offline-verify'
Copy-Item -Force C:\Users\caads\workspace\offline-deps-bundle.tar.gz     "$V\local\workspace\"
Copy-Item -Force C:\Users\caads\workspace\offline-deps-bundle.tar.gz.sig "$V\local\workspace\"
Copy-Item -Force C:\Users\caads\workspace\bundle.key                     "$V\local\workspace\"
```

`.sha256` は**あえてコピーしない**（配信元由来の値は判定に使わない設計であり、無くても
通ることを同時に確認する）。`full\workspace\` には `offline\` 以外を置かない
（素の状態から setup が全部取ってくることの確認）。

- [ ] **Step 11: 配置結果を確認する**

```powershell
Get-ChildItem C:\Users\caads\offline-verify\local\workspace | Select-Object Name
Get-ChildItem C:\Users\caads\offline-verify\full\workspace  | Select-Object Name
```

期待: `local\workspace` に `offline` / `editor` / `pie-chart` / `docs` / `scripts` /
`package.json` / `pnpm-lock.yaml` / `offline-deps-bundle.tar.gz` / `.sig` / `bundle.key` などが
並ぶ。`full\workspace` は `offline` **のみ**。

- [ ] **Step 12: setup が書き換えるユーザー環境変数の現在値を控える**

`offline\lib\git-tools.ps1` は PortableGit を展開したあと、ユーザー環境変数 `GIT_BIN` を
**上書き**し、User PATH へ PortableGit の `cmd` ディレクトリを**追記**する。検証フォルダで
setup を走らせると両者が検証フォルダ側を指すため、Phase 7 でフォルダを削除すると
存在しないパスを指したまま残り、現ワークスペースの editor（確定保存のたびに git を呼ぶ）が
壊れる。復元できるよう現在値を記録する。

**記録した現在値（2026-09-01）:**
- `GIT_BIN`（User）= `C:\Users\caads\workspace\git-tools\portablegit\cmd\git.exe`
- User PATH に含まれる git 関連エントリ = `C:\Users\caads\workspace\git-tools\portablegit\cmd`
- `git` の解決先 = `C:\Program Files\Git\cmd\git.exe`（システム側が優先されている）

```powershell
[Environment]::GetEnvironmentVariable('GIT_BIN','User')
([Environment]::GetEnvironmentVariable('Path','User') -split ';') | Where-Object { $_ -match 'git' }
```

---

## Phase 1: 完全オフライン構築（local）

**Files:**
- Execute: `C:\Users\caads\offline-verify\local\workspace\offline\setup-offline-local.bat`

**Interfaces:**
- Consumes: Phase 0 で配置したソース・`offline/`・重量物資材
- Produces: 依存導入済み・build 済みのツリー（Phase 2〜5 が使う）

- [ ] **Step 1: setup を実行する（ユーザーに `!` 実行を依頼）**

所要 10〜20 分。依頼する文面:

```
! cd C:\Users\caads\offline-verify\local\workspace && offline\setup-offline-local.bat
```

- [ ] **Step 2: 検証段の出力を確認する**

期待する要点（いずれか欠けたら**中止**。この 3 つは fail closed の設計であり、
「無ければスキップ」は起きてはならない）:
- `offline\pinned-release.txt` の `bundle-sha256` と実体の突き合わせが一致
- `bundle-signing.pub.xml` による分離署名 `.sig` の RSA 検証が OK
- 展開後の `bundle.key` と現ツリーの content-key が一致（lockfile 整合）

- [ ] **Step 3: 完了表示と成果物を確認する**

期待: 最終行に `[OK] セットアップ完了。`

```powershell
$W = 'C:\Users\caads\offline-verify\local\workspace'
Get-ChildItem $W | Select-Object Name              # .pnpm-store / ms-playwright / git-tools / node_modules / bk
Test-Path "$W\editor\web\dist"                     # build 成果物: True
Get-ChildItem "$W\native-prebuilds"                # msnodesqlv8 prebuild が展開されている
```

- [ ] **Step 4: msnodesqlv8 のネイティブモジュールが配置されたことを確認する**

```powershell
Get-ChildItem -Recurse -Filter '*.node' C:\Users\caads\offline-verify\local\workspace\node_modules\.pnpm |
  Where-Object { $_.FullName -like '*msnodesqlv8*' } | Select-Object FullName
```

期待: 1 件以上見つかる。ここが空だと Phase 4（rest）が起動時に落ちる。

- [ ] **Step 5: 結果を記録する**

Phase 1 の所要時間・出力の要点・想定外の差異を、Phase 7 の記録用に手元へ控える。

---

## Phase 2: CI 一括（自動 E2E 込み）

**Files:**
- Execute: `pnpm run ci`（`check:comments` → `check:claude-hooks` → `check:ci` →
  `test:scripts` → `typecheck` → `test:coverage` → `build` → `test:e2e`）

**Interfaces:**
- Consumes: Phase 1 で構築したツリー
- Produces: 8 段すべての合否（Phase 3 以降の前提）

- [ ] **Step 1: CI を実行する（ユーザーに `!` 実行を依頼）**

所要 13〜15 分。背景実行の 10 分上限を超えるため、必ずユーザーに依頼する。

```
! cd C:\Users\caads\offline-verify\local\workspace && corepack pnpm run ci
```

- [ ] **Step 2: 段ごとの結果を確認する**

期待: 8 段すべて緑。E2E は `editor/e2e` の 3 spec（`smoke.spec.ts` / `canvas.spec.ts` /
`capture_docs.spec.ts`）が chromium で通る。

- [ ] **Step 3: 既知の負荷フレークを切り分ける**

次の 4 つは実機 8GB の資源上限に由来する既知のフレークで、**実装の不具合ではない**。
出たら該当テストを単独で実行し、green であることを確認してから CI 全体をリトライする。

- `hostGuard` のタイムアウト
- E2E `smoke.spec.ts` のタイムアウト
- coverage の一時ファイル ENOENT
- 終了コード `0xC0000142`

単独実行の例:

```powershell
cd C:\Users\caads\offline-verify\local\workspace
corepack pnpm exec vitest run --project server -t hostGuard
corepack pnpm exec playwright test -c editor/playwright.config.ts e2e/smoke.spec.ts
```

- [ ] **Step 4: `capture_docs` が作った差分を確認する（コミットはしない）**

`capture_docs.spec.ts` は `docs/editor/images/` を再撮影する。検証フォルダは git 管理外なので
差分は放置してよい。**現ワークスペース側の同名ファイルが変わっていないこと**だけ確認する。

```powershell
git -C C:\Users\caads\workspace status --porcelain docs/editor/images
```

期待: 出力が空。

- [ ] **Step 5: 落ちた段があれば記録し、Phase 3 へ進むか判断する**

E2E だけが落ちて他が緑なら、手動 UI（Phase 3）で同じ経路を人の目で確認する価値がある。
typecheck / build が落ちた場合はオフライン構築そのものが不完全なので Phase 1 へ戻る。

---

## Phase 3: editor 手動 UI 一巡（local モード）

**Files:**
- Execute: `editor\scripts\init-data-repo.bat`（テンプレ実体の data リポジトリ初期化）
- Execute: `editor\start.bat dev local`

**Interfaces:**
- Consumes: Phase 1 のビルド済みツリー
- Produces: `C:\Users\caads\offline-verify\local\editor-data\`（Phase 4 も使う）

- [ ] **Step 1: data リポジトリを初期化する**

`dataRoot` の既定は「editor の 2 つ上」＝ `C:\Users\caads\offline-verify\local\editor-data` で、
既存の `C:\Users\caads\editor-data` とは別物になる。

```powershell
cd C:\Users\caads\offline-verify\local\workspace\editor
scripts\init-data-repo.bat
```

期待: `..\..\editor-data` に `templates` / `css` / `drafts` / `pending` / `reviews` が作られ、
git リポジトリとして初期化される。

```powershell
git -C C:\Users\caads\offline-verify\local\editor-data log --oneline -1
```

- [ ] **Step 2: dev サーバを起動する（ユーザーに `!` 実行を依頼。常駐するため)**

```
! cd C:\Users\caads\offline-verify\local\workspace\editor && start.bat dev local
```

期待: Fastify が :24680、Vite が :24681 で待ち受ける。

```powershell
Invoke-WebRequest http://localhost:24680/api/health -UseBasicParsing | Select-Object StatusCode
```

- [ ] **Step 3: テンプレ作成タブで新規テンプレを作る**

ブラウザで `http://localhost:24681` を開き、テンプレ作成タブから属性を指定して生成する。

確認する不変条件（`docs/editor/src/設計正典.md`「中核原則」）:
- URL が `/edit/:id?created=1` になる
- 差し込み値が **placeholder としてハイライト表示される**（作成経路 = `toFilled` + ハイライト有り）

- [ ] **Step 4: 編集タブで既存テンプレを開く**

確認する不変条件:
- URL が `/edit/:id`（query 無し）
- 差し込み値が**ハイライトされず**、ファンドごとの実値が地の本文として出る
  （編集経路 = `tpl.filled` + ハイライト無し）

これが崩れていたら過去の退行（`aa9bd65` / `42938a0`）の再来なので、必ず記録する。

- [ ] **Step 5: 3 ペイン編集を一巡する**

- 左ペインのブロック追加・右ペインのスタイル変更が canvas に反映される
- テキスト編集後に保存（下書き）でき、リロードしても内容が残る

- [ ] **Step 6: プレビュー画面で組版されることを確認する**

確認する要点（`docs/editor/src/設計正典.md`「画面内プレビュー」）:
- ページが**実際に組版されて表示される**（loading のまま止まらない）。止まる場合は
  ホストページ CSP の `connect-src` から `data:` が落ちている疑いがある（5/5 再現の実績あり）
- 表を含むテンプレでも中断しない
- ペインをリサイズしてもズームフィットのみが追随し、再組版で固まらない

- [ ] **Step 7: PDF を出力する**

期待: vivliostyle worker pool 経由で PDF が生成され、ダウンロードできる。テンプレに JS が
埋まっている場合、その実行結果が PDF にも反映されている（body 末尾のインライン `<script>` に限る）。

- [ ] **Step 8: サーバを停止する**

Ctrl+C。ポート 24680 / 24681 が解放されたことを確認する。

```powershell
Get-NetTCPConnection -LocalPort 24680,24681 -State Listen -ErrorAction SilentlyContinue
```

---

## Phase 4: editor rest モード（LocalDB + 認証 + 承認 + git）

**Files:**
- Execute: `editor\start.bat dev rest`（環境変数 `DB_SERVER` 付き）

**Interfaces:**
- Consumes: Phase 3 で初期化した `offline-verify\local\editor-data`、既存 LocalDB `usrap` / `ug01`
- Produces: 承認完結による git コミット（確定保存の関所を通ったことの証跡）

- [ ] **Step 1: LocalDB が起動していることを確認する**

```powershell
sqllocaldb info MSSQLLocalDB
```

期待: `State: Running`（停止していれば `sqllocaldb start MSSQLLocalDB`）。

- [ ] **Step 2: rest モードで起動する（ユーザーに `!` 実行を依頼。常駐するため）**

```
! cd C:\Users\caads\offline-verify\local\workspace\editor && powershell -NoProfile -Command "$env:DB_SERVER='(localdb)\MSSQLLocalDB'; .\start.bat dev rest"
```

期待: 起動時に msnodesqlv8 のロードで落ちない（Phase 1 Step 4 の prebuild 配置が効いている）。
`AUTH_REQUIRED` は loopback なので既定で起動できる。

- [ ] **Step 3: ログインする**

`http://localhost:24681` を開く。検証ユーザー（この端末に構築済み）:

- `admin` / `Admin#2026`（承認者・管理者）
- `editor` / `Editor#2026`（申請者）
- `viewer` / `viewer`（閲覧のみ）

確認: ログイン失敗時の応答が、未知 ID でもパスワード誤りでも同一の文言・ステータス・`code` で
返る（存在オラクルにならない）。

- [ ] **Step 4: `editor` で編集し、確定保存を申請する**

期待: 申請が `dataRoot\reviews\` にファイルとして作られる（DB ではない）。

- [ ] **Step 5: 自己承認が拒否されることを確認する**

`editor` のまま自分の申請を承認しようとする。期待: 拒否される（職務分掌）。

- [ ] **Step 6: `admin` でログインし直して承認する**

期待:
- 差分表示が出る（承認者が「差分を見られないので承認できない」状態にならない）
- 承認すると確定保存が実ファイルへ反映される

- [ ] **Step 7: git コミットが載ったことを確認する**

```powershell
git -C C:\Users\caads\offline-verify\local\editor-data log --oneline -3
git -C C:\Users\caads\offline-verify\local\editor-data show --stat HEAD
```

期待: 承認によるコミットが 1 件増えており、変更対象が `templates/` 配下の該当ファイルに
限られている（`pending/` は git 管理外なので混入しない）。

- [ ] **Step 8: 却下経路も 1 回確認する**

`editor` で再度申請 → `admin` で却下。期待: 却下理由が必須で、理由なしでは却下できない。

- [ ] **Step 9: サーバを停止する**

Ctrl+C。ポート解放を確認する（Phase 3 Step 8 と同じコマンド）。

---

## Phase 5: pie-chart と docs ビルド

**Files:**
- Execute: `pnpm --filter pie-chart run batch` / `batch:diff`
- Execute: `docs\_build\build_all.bat`

**Interfaces:**
- Consumes: Phase 1 で構築したツリー、現ワークスペースの `pie-chart\out\_baseline`
- Produces: SVG の byte 一致判定、docs HTML の生成可否

- [ ] **Step 1: baseline を現ワークスペースからコピーする**

`out/` は git 管理外なので検証フォルダには存在しない。現ワークスペースの baseline を持ち込むことで、
「別環境で構築しても同一 SVG が出るか」という決定性の検証になる。

現ワークスペースに baseline が 83 件そろっていることは確認済み（2026-09-01）。

```powershell
$src = 'C:\Users\caads\workspace\pie-chart\out\_baseline'
$dst = 'C:\Users\caads\offline-verify\local\workspace\pie-chart\out'
New-Item -ItemType Directory -Force -Path $dst | Out-Null
Copy-Item -Recurse -Force $src $dst
(Get-ChildItem "$dst\_baseline").Count      # 83 であること
```

- [ ] **Step 2: batch を実行して SVG を生成する**

```powershell
cd C:\Users\caads\offline-verify\local\workspace
corepack pnpm run pie-chart:batch
```

- [ ] **Step 3: byte-diff を取る**

```powershell
corepack pnpm run pie-chart:batch:diff
```

期待: **83/83 サンプルが byte 一致**。1 件でもズレたら、オフライン構築で入った依存
（`subset-font` / フォント埋め込み）が現ワークスペースと違う可能性がある。差分の内容を記録する。

- [ ] **Step 4: docs をビルドする**

```powershell
cd C:\Users\caads\offline-verify\local\workspace
docs\_build\build_all.bat
```

期待: `python-wheelhouse` から `--no-index` で依存が導入され（ネット接続なし）、
`docs\editor\editor_手引き.html` / `editor_設計.html` などが生成される。

- [ ] **Step 5: 生成された HTML を目視確認する**

1 冊をブラウザで開き、次を確認する:
- ライトモード固定で崩れていない
- Mermaid 図が **ELK 直交ルーティング**で描画される（`docs/_build/vendor/` の mermaid が
  setup で展開されている。未配置なら dagre + step にフォールバックする）
- 画像が base64 インラインで表示される（HTML 1 枚で自己完結している）

- [ ] **Step 6: docs のテストを実行する**

```powershell
cd C:\Users\caads\offline-verify\local\workspace
corepack pnpm run test:docs
```

期待: pytest が緑。

---

## Phase 6: full E2E（`setup-offline.bat` / 取得込み）

**Files:**
- Execute: `C:\Users\caads\offline-verify\full\workspace\offline\setup-offline.bat`

**Interfaces:**
- Consumes: Phase 0 で配置した素の `offline/` フォルダ、GitHub Releases の重量物
- Produces: 残項目①の消化（配布先の初回体験が完走することの実証）

- [ ] **Step 1: 取得可能な可視性であることを確認する**

Public 運用（Phase 0 Step 1 の判断）なので窓の開閉は行わない。取得前に現状だけ確認する。

```powershell
gh repo view --json visibility     # PUBLIC であることを確認してから次へ
```

- [ ] **Step 2: setup を実行する（ユーザーに `!` 実行を依頼）**

所要 20〜40 分（1.1GB + ソース zip の DL を含む。回線次第）。

```
! cd C:\Users\caads\offline-verify\full\workspace && offline\setup-offline.bat
```

- [ ] **Step 3: 6 段の進行を確認する**

期待する要点:
1. ソース ZIP を pin の**不変コミット** `<PINNED_SHA>` から HTTPS 直取得 → pin の sha256 と一致
2. 親フォルダ（＝ `full\workspace`）へ展開。実行中の `offline/` 自身は上書きされない
3. 重量物バンドルを取得 → pin の sha256 と一致 → `bundle-signing.pub.xml` で分離署名を検証
4. 展開 → `bundle.key` で lockfile 整合チェック
5. 同梱 pnpm を corepack 登録 → オフライン install → build → Playwright 配置
6. ダウンロードしたアーカイブを `bk\` へ退避

最終行に `[OK] セットアップ完了。`

- [ ] **Step 4: DL が停滞したら中断してユーザーへ報告する**

PowerShell 版のダウンロードには timeout が無い（既知の弱点）。10 分以上進捗が無ければ Ctrl+C で
中断し、停滞した段（ソース zip か重量物か）を記録してから再開を検討する。

- [x] **Step 5: （不要）可視性を戻す操作** — Public 運用のため実施しない。

- [ ] **Step 6: 展開されたソースが pin と一致することを確認する**

```powershell
$W = 'C:\Users\caads\offline-verify\full\workspace'
Get-ChildItem $W | Select-Object Name
Get-Content "$W\offline\pinned-release.txt" | Select-String '^source-commit '
```

期待: `local` 側と同じ `<PINNED_SHA>`。両フォルダで `editor\package.json` などが一致すること。

- [ ] **Step 7: full 側でも最小の動作確認をする**

CI 全体は local 側で済んでいるので、ここでは構築の完全性だけを見る。

```powershell
cd C:\Users\caads\offline-verify\full\workspace
corepack pnpm run typecheck
corepack pnpm run test:pie-chart
```

期待: どちらも緑。

---

## Phase 7: 後始末・記録・残項目の消化

**Files:**
- Modify: `docs/superpowers/plans/2026-09-01-offline-e2e-verification.md`（本ファイル末尾に実測記録）
- Modify: メモリ `repo-split-progress.md`（残項目の状態更新）

- [ ] **Step 1: 可視性が検証開始時と変わっていないことを確認する**

```powershell
gh repo view --json nameWithOwner,visibility
```

期待: `"visibility":"PUBLIC"`（Phase 0 Step 1 の判断どおり）。検証の途中で誰も変えていないことの確認。

- [ ] **Step 2: 残項目②（配布先端末の有無）をユーザーに確認する**

`offline/` フォルダを配布済みの端末が存在するかを聞く。存在する場合、その端末が持つ
`pinned-release.txt` の `source-commit` は**旧 pin**（`4fcad7f`）を指しており、GitHub の
GC 後は該当 zip が 404 になりうる。その場合は Phase 0 で更新した最新の `offline/` フォルダ一式を
再配布する必要がある。結果を本ファイルの実測記録へ書く。

- [ ] **Step 3: 検証で見つかった不具合を一覧化する**

Phase 1〜6 で記録した想定外・失敗をすべて並べ、次のいずれかに分類する。

- 実装の不具合 → 別タスクとして起票（本計画では直さない）
- 既知の負荷フレーク → 記録のみ
- 手順・ドキュメントの不備 → `offline/README-offline.txt` などの修正タスクとして起票

- [ ] **Step 4: 実測記録を本ファイル末尾へ書く**

各 Phase の所要時間、通った検証段、想定外の差異、残項目②の回答を記録する。

- [ ] **Step 5: 記録をコミットする**

```powershell
git -C C:\Users\caads\workspace add docs/superpowers/plans/2026-09-01-offline-e2e-verification.md
git -C C:\Users\caads\workspace commit -m "docs: オフライン構築・実動作確認の検証計画と実測記録を残す"
```

- [ ] **Step 6: メモリを更新する**

`repo-split-progress.md` の「残項目 2 件」を実際の状態へ更新する
（①が完了したならその旨、②の回答内容）。

- [ ] **Step 7: ユーザー環境変数を検証前の値へ戻す**

Phase 0 Step 12 で控えた値へ戻す。**検証フォルダを削除する前に必ず実行する**（順序を逆にすると、
壊れた状態のまま気づかない）。

```powershell
[Environment]::SetEnvironmentVariable('GIT_BIN','C:\Users\caads\workspace\git-tools\portablegit\cmd\git.exe','User')
$p = ([Environment]::GetEnvironmentVariable('Path','User') -split ';' |
  Where-Object { $_ -and $_ -notlike 'C:\Users\caads\offline-verify\*' }) -join ';'
[Environment]::SetEnvironmentVariable('Path',$p,'User')
```

確認:

```powershell
[Environment]::GetEnvironmentVariable('GIT_BIN','User')     # workspace 側を指すこと
([Environment]::GetEnvironmentVariable('Path','User') -split ';') | Where-Object { $_ -match 'offline-verify' }
```

期待: `GIT_BIN` が `C:\Users\caads\workspace\git-tools\...` に戻り、PATH に `offline-verify` を
含むエントリが 1 件も残らない。

- [ ] **Step 8: 検証フォルダの扱いをユーザーに確認する**

`C:\Users\caads\offline-verify\` は約 10GB を占める。次のいずれかを選んでもらう。

- 削除する: `Remove-Item -Recurse -Force C:\Users\caads\offline-verify`
- 残す: 次回の検証で `setup-offline-local.bat` の再実行（receipt 経路）を試せる

---

## スコープ外（必要になったら別タスク）

- pie-chart の **exe（Node SEA）ビルド**。署名鍵（`NonExportable`・有効期間 1 年・thumbprint 明示）が
  前提で、署名失敗＝ビルド失敗の設計。鍵の扱いを含むため独立したタスクとする。
- **python-tools リポジトリ**のオフライン検証（別リポジトリに独立した `offline/` と
  `setup-dev.bat` を持つ）。
- **LAN 公開 / HTTPS 経路**（`start.bat rest lan`・PFX 証明書・ファイアウォール設定）。
- **rest 用 DB の新規構築**（sproc 適用手順そのものの検証）。判断 C により既存 LocalDB を共用する。

---

## 実測記録

（Phase 7 Step 4 でここへ記入する）
