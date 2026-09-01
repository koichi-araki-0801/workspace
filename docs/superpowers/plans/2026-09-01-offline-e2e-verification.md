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
  一切書き込まない。検証フォルダは `C:\Users\Public\offline-verify\` 配下に閉じる。
- **検証フォルダはローカルドライブ限定。** `Assert-LocalRepoRoot` がネットワークドライブを
  拒否する（pnpm の symlink / hardlink 構成が成立しないため）。
- **検証フォルダは他の git リポジトリの配下に置かない。** `C:\Users\caads\.git` が存在するため、
  当初の配置（`C:\Users\caads\offline-verify\...`）では `git -C <展開先> ls-files` が**そのリポジトリ**を
  見て exit 0 / 0 件を返し、`Get-OfflineRequirementsFilesViaGit` が null ではなく空配列を返す。
  結果 requirements.txt が content key に折り込まれず、setup が lockfile 不整合で必ず中止する
  （Phase 1 で実測）。配置は `C:\Users\Public\offline-verify\` とする。スクリプト側の修正は
  Phase 7 で起票する。
- **ポート 24680 / 24681 は同時に 1 プロセスのみ。** 検証サーバを起動する前に、現ワークスペース側の
  dev サーバ・rest サーバが動いていないことを確認する。稼働中のまま Playwright を走らせると
  E2E が誤接続して落ちる（2026-08-02 実績）。
- **不具合を見つけても本計画では直さない。** 発見はすべて Phase 7 の記録へ集約し、修正は
  別タスクとして切る。検証の途中で実装を触ると、何を検証した結果なのかが失われる。
- **10 分を超えるコマンドはデタッチ起動 + Monitor で回す。** エージェントの背景実行は 10 分で
  打ち切られる（Phase 1 で実測。展開の途中で kill された）。長い工程は次の形で起動し、
  ツールの寿命から切り離す。ユーザーに `!` 実行を頼むのは、対話入力や昇格が要る場合に限る。

```powershell
$log = 'C:\Users\Public\offline-verify\<name>.log'
$p = Start-Process -FilePath 'powershell.exe' `
  -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','<script.ps1>' `
  -RedirectStandardOutput $log -RedirectStandardError "$log.err" -PassThru -WindowStyle Hidden
$p.Id
```

  そのうえで Monitor（`timeout_ms` は最大 3600000）にログの節目と当該 PID の生存を追わせる。
  監視の grep は成功マーカーだけでなく失敗マーカーも含める（沈黙は成功ではない）。
  対象が `.bat` の場合も、中身は `powershell -File <同名 .ps1>` なので直接 `.ps1` を起動してよい。
- **リポジトリは Public 運用（2026-09-01 にユーザーが意図的な公開であることを確認）。**
  フェーズ 5 の実測記録にある「一時 Public 窓 → PRIVATE 復帰」の運用は現在当てはまらない。
  本計画では可視性を変更しない。Phase 6 の `setup-offline.bat` は Public のまま無認証で
  取得できるため、窓の開閉操作そのものが不要になる。

---

## Phase 0: 準備と pin 更新

**Files:**
- Modify: `offline/pinned-release.txt`（publish が自動更新。手で編集しない）
- Create: `C:\Users\Public\offline-verify\local\workspace\`（検証用ツリー）
- Create: `C:\Users\Public\offline-verify\full\workspace\offline\`（full 用の素のフォルダ）

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
$V = 'C:\Users\Public\offline-verify'
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
$V = 'C:\Users\Public\offline-verify'
Copy-Item -Recurse -Force C:\Users\caads\workspace\offline "$V\local\workspace\"
Copy-Item -Recurse -Force C:\Users\caads\workspace\offline "$V\full\workspace\"
```

検証: 両フォルダの `offline\pinned-release.txt` の `source-commit` が `<PINNED_SHA>` と一致すること。

- [ ] **Step 10: local 用の重量物資材をコピーする**

```powershell
$V = 'C:\Users\Public\offline-verify'
Copy-Item -Force C:\Users\caads\workspace\offline-deps-bundle.tar.gz     "$V\local\workspace\"
Copy-Item -Force C:\Users\caads\workspace\offline-deps-bundle.tar.gz.sig "$V\local\workspace\"
Copy-Item -Force C:\Users\caads\workspace\bundle.key                     "$V\local\workspace\"
```

`.sha256` は**あえてコピーしない**（配信元由来の値は判定に使わない設計であり、無くても
通ることを同時に確認する）。`full\workspace\` には `offline\` 以外を置かない
（素の状態から setup が全部取ってくることの確認）。

- [ ] **Step 11: 配置結果を確認する**

```powershell
Get-ChildItem C:\Users\Public\offline-verify\local\workspace | Select-Object Name
Get-ChildItem C:\Users\Public\offline-verify\full\workspace  | Select-Object Name
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
- Execute: `C:\Users\Public\offline-verify\local\workspace\offline\setup-offline-local.bat`

**Interfaces:**
- Consumes: Phase 0 で配置したソース・`offline/`・重量物資材
- Produces: 依存導入済み・build 済みのツリー（Phase 2〜5 が使う）

- [ ] **Step 1: setup をデタッチ起動する**

所要 10〜20 分。Global Constraints のデタッチ起動を使う。

```powershell
$log = 'C:\Users\Public\offline-verify\setup-local.log'
$p = Start-Process -FilePath 'powershell.exe' `
  -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','C:\Users\Public\offline-verify\local\workspace\offline\setup-offline-local.ps1' `
  -RedirectStandardOutput $log -RedirectStandardError "$log.err" -PassThru -WindowStyle Hidden
$p.Id
```

Monitor でログの `[N/4]` / `[OK]` / `[error]` と当該 PID の生存を追う。

- [ ] **Step 2: 検証段の出力を確認する**

期待する要点（いずれか欠けたら**中止**。この 3 つは fail closed の設計であり、
「無ければスキップ」は起きてはならない）:
- `offline\pinned-release.txt` の `bundle-sha256` と実体の突き合わせが一致
- `bundle-signing.pub.xml` による分離署名 `.sig` の RSA 検証が OK
- 展開後の `bundle.key` と現ツリーの content-key が一致（lockfile 整合）

- [ ] **Step 3: 完了表示と成果物を確認する**

期待: 最終行に `[OK] セットアップ完了。`

```powershell
$W = 'C:\Users\Public\offline-verify\local\workspace'
Get-ChildItem $W | Select-Object Name              # .pnpm-store / ms-playwright / git-tools / node_modules / bk
Test-Path "$W\editor\web\dist"                     # build 成果物: True
Get-ChildItem "$W\native-prebuilds"                # msnodesqlv8 prebuild が展開されている
```

- [ ] **Step 4: msnodesqlv8 のネイティブモジュールが配置されたことを確認する**

```powershell
Get-ChildItem -Recurse -Filter '*.node' C:\Users\Public\offline-verify\local\workspace\node_modules\.pnpm |
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

- [ ] **Step 1: CI をデタッチ起動する**

所要 13〜15 分。

```powershell
$log = 'C:\Users\Public\offline-verify\ci.log'
$p = Start-Process -FilePath 'cmd.exe' `
  -ArgumentList '/c','cd /d C:\Users\Public\offline-verify\local\workspace && corepack pnpm run ci' `
  -RedirectStandardOutput $log -RedirectStandardError "$log.err" -PassThru -WindowStyle Hidden
$p.Id
```

Monitor は成功・失敗の両方を拾う（沈黙は成功ではない）。拾う語:
`Test Files|Tests |passed|failed|FAIL|ERR_|error TS|✓|✗`。

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
cd C:\Users\Public\offline-verify\local\workspace
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
- Produces: `C:\Users\Public\offline-verify\local\editor-data\`（Phase 4 も使う）

- [ ] **Step 1: data リポジトリを初期化する**

`dataRoot` の既定は「editor の 2 つ上」＝ `C:\Users\Public\offline-verify\local\editor-data` で、
既存の `C:\Users\caads\editor-data` とは別物になる。

```powershell
cd C:\Users\Public\offline-verify\local\workspace\editor
scripts\init-data-repo.bat
```

期待: `..\..\editor-data` に `templates` / `css` / `drafts` / `pending` / `reviews` が作られ、
git リポジトリとして初期化される。

```powershell
git -C C:\Users\Public\offline-verify\local\editor-data log --oneline -1
```

- [ ] **Step 2: dev サーバをデタッチ起動する**

常駐プロセスなので必ずデタッチで起動し、PID を控えて Phase 3 Step 8 で止める。

```powershell
$log = 'C:\Users\Public\offline-verify\editor-local.log'
$p = Start-Process -FilePath 'cmd.exe' `
  -ArgumentList '/c','cd /d C:\Users\Public\offline-verify\local\workspace\editor && start.bat dev local' `
  -RedirectStandardOutput $log -RedirectStandardError "$log.err" -PassThru -WindowStyle Hidden
$p.Id
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
! cd C:\Users\Public\offline-verify\local\workspace\editor && powershell -NoProfile -Command "$env:DB_SERVER='(localdb)\MSSQLLocalDB'; .\start.bat dev rest"
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
git -C C:\Users\Public\offline-verify\local\editor-data log --oneline -3
git -C C:\Users\Public\offline-verify\local\editor-data show --stat HEAD
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
$dst = 'C:\Users\Public\offline-verify\local\workspace\pie-chart\out'
New-Item -ItemType Directory -Force -Path $dst | Out-Null
Copy-Item -Recurse -Force $src $dst
(Get-ChildItem "$dst\_baseline").Count      # 83 であること
```

- [ ] **Step 2: batch を実行して SVG を生成する**

```powershell
cd C:\Users\Public\offline-verify\local\workspace
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
cd C:\Users\Public\offline-verify\local\workspace
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
cd C:\Users\Public\offline-verify\local\workspace
corepack pnpm run test:docs
```

期待: pytest が緑。

---

## Phase 6: full E2E（`setup-offline.bat` / 取得込み）

**Files:**
- Execute: `C:\Users\Public\offline-verify\full\workspace\offline\setup-offline.bat`

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
! cd C:\Users\Public\offline-verify\full\workspace && offline\setup-offline.bat
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
$W = 'C:\Users\Public\offline-verify\full\workspace'
Get-ChildItem $W | Select-Object Name
Get-Content "$W\offline\pinned-release.txt" | Select-String '^source-commit '
```

期待: `local` 側と同じ `<PINNED_SHA>`。両フォルダで `editor\package.json` などが一致すること。

- [ ] **Step 7: full 側でも最小の動作確認をする**

CI 全体は local 側で済んでいるので、ここでは構築の完全性だけを見る。

```powershell
cd C:\Users\Public\offline-verify\full\workspace
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
  Where-Object { $_ -and $_ -notlike 'C:\Users\Public\offline-verify\*' }) -join ';'
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

`C:\Users\Public\offline-verify\` は約 10GB を占める。次のいずれかを選んでもらう。

- 削除する: `Remove-Item -Recurse -Force C:\Users\Public\offline-verify`
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

## 実測記録（2026-09-01）

### 実施範囲

- **Phase 0: 完了**（pin 更新・検証フォルダ構築）。
- **Phase 1: 1 回目は不具合で停止 → 修正後の 2 回目で完走**。オフライン構築が完走しない
  不具合を 2 つ踏んだ時点で一度中断し、修正を済ませてから再実行した。
  中断を挟んだ理由は、発見した不具合が「検証対象の一部」ではなく「検証の前提条件」
  だったため。`setup-offline-local` が完走しない限り Phase 2 以降は 1 つも実行できない。
- **Phase 2 以降**: 下記の該当節に記録する。

### Phase 0 の結果

- pin を `4fcad7f` → `77145719173f6603fcf74e06b50a38111e0d3d84` へ更新（手動。理由は発見 2）。
  ソース zip は 19,702,971 bytes、sha256 =
  `7bb0e922283c882990fc7e5a4383cffcb4d209003e5552edf1d4eb8e9b00ac29`。
- 重量物は content key 一致（`92b80d97de4e9f27b3e954d547a757afbd7ea7d4480e06f2093b3c60d0c3154f`）で
  再アップロードなし。タグ移動と Release 説明の更新は完了。
- 重量物の実測: bundle 1,109,350,471 bytes、展開後 `.pnpm-store` 863MB /
  `ms-playwright` 1.4GB / `git-tools` 481MB / `python-wheelhouse` 2MB。
- 検証フォルダは `C:\Users\Public\offline-verify\`（当初 `C:\Users\caads\offline-verify\` に
  置いたが発見 1 のため移動）。

### Phase 1 で通過した検証段

以下は**正しく動作した**。fail closed の設計自体は機能しており、いずれの不具合でも
「壊れた状態で先へ進む」ことはなかった。

- pin の `bundle-sha256` と実体の突き合わせ（`1fd1095c…` 一致）
- `bundle-signing.pub.xml` による分離署名 `.sig` の RSA 検証
- `bundle.key` と content key の照合（＝これが発見 1 を検出した）

### 発見 1: 展開先が別の git リポジトリ配下だと content key が乖離する

- **症状**: `[error] lockfile 不整合: 資材とソースが対応していません。`
  code (local) = `da022e56…` / bundle.key = `92b80d97…`。
- **原因**: `offline/lib/content-key.ps1` の `Get-OfflineRequirementsFilesViaGit` は
  `git ls-files` の終了コードだけを見て `$LASTEXITCODE -ne 0` のときに `$null` を返す。
  展開先が別リポジトリの配下にあると git は**その親リポジトリ**を見て **exit 0 / 0 件**を返すため、
  関数は `$null` ではなく**空配列**を返す。呼び出し元 `Get-OfflineRequirementsFiles` は
  `$null -ne $viaGit` で判定しているのでファイルシステム経路へフォールバックせず、
  `requirements.txt` が content key に 1 件も折り込まれない。
- **確認した事実**: `C:\Users\caads\.git` が存在し、
  `git -C C:\Users\caads\offline-verify\local\workspace rev-parse --show-toplevel` は
  `C:/Users/caads` を exit 0 で返す。同フォルダで `ls-files` は exit 0 / 0 件。
- **切り分けの経過**: `pnpm-lock.yaml` は CR 除去後のバイト列が完全一致（sha `77a0d90f…`、
  9939 行・差分 0 行）、`requirements.txt` / 各 `manifest.txt` の有意行もすべて一致。
  累積ハッシュを段階ごとに取ったところ、検証フォルダ側だけ requirements の折り込み段が
  丸ごと現れないことで確定した。
- **影響**: 配布先のホームが git 管理下（dotfiles 管理など）だと、オフライン構築が必ず失敗する。
- **修正案**: `git -C $RepoRoot rev-parse --show-toplevel` を先に呼び、正規化した戻り値が
  `$RepoRoot` 自身と一致するときだけ `ls-files` を使う。一致しなければ `$null` を返して
  ファイルシステム経路へ落とす。

### 発見 2: publish の pin 生成が `-H '@-'` で必ず失敗する

- **症状**: `curl: (22) The requested URL returned error: 400` →
  `[error] ソース zip の取得に失敗しました（pin を更新できません）。`
- **原因**: `offline/publish-offline-bundle.ps1` は認証ヘッダを標準入力から渡すため
  `curl.exe -H '@-'` を使うが、この環境（Windows PowerShell 5.1 + curl 8.21.0）では
  stdin からの読み取りが機能していない。
- **切り分け**（`https://api.github.com/rate_limit` への応答コード）:
  ヘッダ無し = 200 / **stdin `-H '@-'` = 400** / インライン `-H '…'` = 401 /
  一時ファイル `-H "@file"` = 401（LF・CRLF いずれも）。401 は「ヘッダが正しく届いて
  ダミートークンが拒否された」状態で、これが期待される挙動。
- **影響**: pin の更新が常に失敗する。フェーズ 5 の実測記録にある「pin 生成段で停滞」も
  同じ箇所で、症状が違うだけの同一原因と見てよい。
- **修正案**: ヘッダを一時ファイルへ LF 改行で書き、`-H "@$path"` で渡す（`finally` で削除）。
  コマンドライン引数には載らないため、`docs/editor/src/設計正典.md` の
  「アクセストークンをコマンドライン引数へ載せない」という要件を満たしたまま直せる。
  インライン `-H` へ戻す案は採らない。

### 発見 3: git 管理外の展開先では NativeCommandError で停止する

- **症状**: `git.exe : fatal: not a git repository (or any of the parent directories): .git`
  が `content-key.ps1:40` を発生場所として送出され、setup が `[3/4]` の直後で終了する。
- **原因**: `setup-offline-local.ps1` は `$ErrorActionPreference = 'Stop'` を設定している。
  ネイティブコマンドの stderr は PowerShell で `NativeCommandError` になるため、
  `2>$null` を付けても `Stop` のもとではスクリプトごと停止する。
- **影響**: 発見 1 を避けて git 管理外の場所（＝配布先として正しい置き方）へ展開すると、
  今度はこちらで落ちる。**発見 1 と合わせて、`setup-offline-local` は「リポジトリのルート自身」
  でしか完走しない**。つまり開発機でしか通らない。
- **修正案**: git 呼び出しの区間だけ `$ErrorActionPreference` を `'Continue'` へ退避するか、
  `git` の呼び出しを stderr ごと捨てられる形（`cmd /c … 2>nul` など）に包む。
  発見 1 の修正（`rev-parse` の一致確認）と同じ関数を触るので、まとめて直すのが自然。

### なぜ既存テストで検出できなかったか

`offline/lib/verify.Tests.ps1` の `Describe 'Get-OfflineRequirementsFiles'` は、すべての
ケースを `$repoRoot`（＝リポジトリのルート）で実行している。git 経路とファイルシステム経路が
「同じ結果になる」ことは検証しているが、**両経路が呼び分けられる条件そのもの**
（リポジトリ外・別リポジトリ配下）を再現していない。修正時は次の 2 条件を足すこと。

- `RepoRoot` が git 管理外 → `ViaGit` が `$null` を返し、`Get-OfflineRequirementsFiles` が
  ファイルシステム経路の結果を返す（かつ例外を投げない）。
- `RepoRoot` が別リポジトリの配下 → 同上（`ls-files` が exit 0 / 0 件でも空配列を返さない）。

### 修正が content key に与える影響

発見 1・3 の修正はいずれも「開発機（リポジトリのルート）での戻り値」を変えない。したがって
現行の `bundle.key`（`92b80d97…`）とは互換で、**重量物の再生成・再アップロードは不要**。
修正コミット後は pin の更新（発見 2 の手動手順、または発見 2 の修正後に publish 再実行）だけ
行えばよい。

### 残項目②（配布先端末の有無）の結果

**配布済みの端末は存在しない**（2026-09-01 ユーザー確認）。旧 pin を持つ端末が無いため、
再配布は不要。リポジトリ分離プロジェクトの残項目②はこれで完了とする。残項目①は上記の
不具合の修正後に再開する。

### Phase 1（再実行）の結果: 完走

修正後のソースと `offline/` を検証フォルダへ再配置し、`setup-offline-local.ps1` を再実行して
`[OK] 完全オフライン構築 完了。` まで到達した。**git 管理外の展開先で完走したのは今回が初めて**で、
修正 3 件が実地で効いたことの確認になっている。

通過した各段:

- pin の `bundle-sha256` 突き合わせ / 分離署名の RSA 検証（1 回目と同じく通過）
- **`[info] lockfile key 一致: 92b80d97…`**（1 回目はここで停止していた）
- オフライン install: 1042 packages・reused 1041（`.pnpm-store` から解決。ダウンロード 0）
- `[info] msnodesqlv8 ネイティブ .node を配置（require OK）。`
  実体 = `node_modules\.pnpm\msnodesqlv8@4.5.0\node_modules\msnodesqlv8\build\Release\sqlserverv8.node`
- build: `editor\shared\dist` と `editor\web\dist` が生成
- PortableGit の展開と導入（`git version 2.54.0.windows.1`）。TortoiseGit は既定どおり未導入

想定内の差異:

- `husky || true` が `.git can't be found` を出す。配布先のツリーは zip 展開で `.git` を持たない
  ため正常。`|| true` で握られており構築は止まらない。
- build の stderr にチャンクサイズ警告（500kB 超）が出る。既存の警告で、この検証で新しく
  生じたものではない。

### Phase 2 の結果: 8 段すべて緑

`corepack pnpm run ci` を 1 回で通過。既知の負荷フレーク（hostGuard タイムアウト・E2E smoke・
coverage の一時ファイル ENOENT・`0xC0000142`）は 1 つも出ず、リトライは不要だった。

- `check:comments` — 0 error / 0 warning（走査 720 files。現ワークスペースの 1342 files との差は
  git 管理外のファイルが配布ツリーに無いため）
- `check:claude-hooks` — `.claude/hooks が無いためスキップします。`（配布先では正常な分岐）
- `check:ci`（Biome） — 503 files / No fixes applied
- `test:scripts` / `typecheck` — エラーなし
- `test:coverage` — Test Files 187 passed | 1 skipped、Tests 2454 passed | 4 skipped
- `build` — 成功
- `test:e2e` — 10 passed（30.0s）。`smoke` / `canvas` / `capture_docs` の 3 spec。
  `canvas.spec.ts` の「編集 2 系統: 編集タブはハイライト無し / 作成経路 (`?created=1`) は有り」も
  この中で通っている。

補足: ログに `error: "PDF generation failed"` などの文字列が出るが、これはエラー処理の分岐を
検証するテストが用意している文言であり、実際の失敗ではない。

### Phase 3 の結果: local モードの画面確認

`editor\start.bat dev local` を起動し（Fastify `/api/health` が `{"ok":true}`、Vite が 200）、
ブラウザで一巡した。

**編集 2 系統の不変条件**（設計正典「中核原則」）を両経路で実測した。

| 経路 | URL | body の `jinja-vars-highlight` | chip の背景 |
|---|---|---|---|
| 編集 | `/edit/:id` | **無し** | 背景なし |
| 作成 | `/edit/:id?created=1` | **有り** | `rgba(245, 158, 11, 0.16)` |

素の `.jinja-chip.jinja-var` に背景が直書きされておらず、body のクラス経由で出し分けられている
ことを computed style で確認した（過去の `aa9bd65` 退行の再来なし）。編集経路の本文には
per-fund の実値（「コア投資戦略ファンド（切替型）」「基準価額 12,345 円」
「純資産総額 123,456 百万円」）が入っており、`42938a0` の退行（全ファンド共通ダミー化）も
起きていない。

**プレビュー**（設計正典「画面内プレビュー」）:

- iframe の src が `http://localhost:24681/api/preview-host/index.html`（サーバ配信のホストページ）
- `sandbox="allow-scripts"` で `allow-same-origin` が**無い**（opaque オリジン）
- 組版が完走し、ページナビが 1〜4 を表示。**loading のまま止まる既知症状は出なかった**
  （CSP の `connect-src` から `data:` が落ちたときの症状）

**PDF 出力**: `POST /api/build` に inline HTML + CSS を投げ、`application/pdf` /
31,888 bytes / 先頭 5 バイト `%PDF-` を得た（初回のため worker 起動込みで約 40 秒）。

想定内の差異と注意点:

- 検証環境の web は現ワークスペースと**同じオリジン**（`localhost:24681`）を使うため、
  ブラウザの localStorage を共有する。既存の `editor:pw` により `editor` ユーザーのパスワードが
  変更済みで、fixtures の `editor/editor` ではログインできなかった（`admin/admin` で入った）。
  同じ理由で以前の下書き（`editor:html`）が編集画面へ復元される。**local モードの検証結果を
  読むときはこの共有を勘定に入れること**。消すと現ワークスペース側の作業データも失われるため、
  今回は消さずに進めた。
- 検索フォームは条件が揃うまで検索を実行しない（`58fb84a` の修正どおりの挙動）。今回は
  テンプレート ID で `/edit/:id` を直接開いた。
- バックグラウンドのタブでは `Page.captureScreenshot` が 30 秒でタイムアウトする。
  確認は `get_page_text` と `javascript_tool` で行った。

### Phase 4 の結果: rest モード（LocalDB + 認証 + 承認 + git）

LocalDB を起動し、`DB_SERVER=(localdb)\MSSQLLocalDB` を渡して `start.bat dev rest` で立ち上げた。

- **msnodesqlv8 のネイティブモジュールが実際に動いた**。`POST /api/auth/login` が 200 を返し、
  SQL Server 由来のユーザー（`id` が UUID。fixtures の `u-admin` ではない）が返る。
  Phase 1 の prebuild 配置が机上でなく実地で効いていることの確認になる。
- テンプレートの取得（`GET /api/templates/:id`）が dataRoot のファイルから成立。編集画面も
  ハイライト無しで開き、rest 経路でも 2 系統の不変条件が保たれている。
- **申請 → 承認 → git コミット**が成立した。`editor` で申請し `admin` が承認すると、dataRoot に
  `確定保存(承認): AM01_510037_20240710_kr 申請=editor 承認=admin`（Author: admin /
  `Co-Authored-By: editor`）のコミットが載り、`templates/` の該当ファイルが更新された。
- **自己承認は拒否された**。`editor` が自分の申請を承認しようとすると 403
  `{"kind":"forbidden","message":"精査者(承認者)権限が必要です"}`。なお `admin` は
  自分の申請を承認できるが、これは仕様どおり（`reviewRepo.ts` の
  「自己承認は既定で拒否し、admin のみ例外とする」）。

UI 操作についての注記: CDP 経由の `type` がこのアプリのフォームへ値を届けられず（Vue の
ref が更新されない）、申請・承認は API を直接叩いて確認した。画面側の同等の経路は Phase 2 の
E2E（`capture_docs.spec.ts` の「申請 → 承認キュー → 精査」）が覆っている。

#### インシデント: 検証サーバが現ワークスペースの実データへ書き込んだ

**起きたこと**: 最初の rest 起動で、承認が現ワークスペースの `C:\Users\caads\editor-data`
に適用された。テンプレート 1 ファイルの 1 行が書き換わり、承認コミット `8f7d9fe` が載った。

**原因**: この端末にはユーザー環境変数 `DATA_ROOT = C:\Users\caads\editor-data` が設定されており
（2026-08 の検証時のもの）、`server/src/config.ts` の `resolvePath` は env を既定パスより
優先する。検証フォルダ側の editor を起動しても、dataRoot は実データを指したままだった。

**復旧**: `git revert 8f7d9fe`（→ `e466ab2`）で内容を戻した。現ワークスペースの editor-data は
作業ツリー clean・内容も元どおりで、以後の Phase では一切書き込んでいない。

**再発防止**: 検証用ランチャ（`run-editor-local.bat` / `run-editor-rest.bat`）で
`set DATA_ROOT=C:\Users\Public\offline-verify\local\editor-data` を明示した。効いていることは、
検証用 dataRoot にだけ入れた目印（`VERIFY-DATAROOT-MARKER`）が API 経由で見えることで確認した。

**この計画の欠陥だった点**: Phase 0 Step 12 で `GIT_BIN` は退避したのに、まったく同じ性質
（ユーザー環境変数が既定を上書きし、検証対象を実データへ向ける）を持つ `DATA_ROOT` を
数えていなかった。**環境変数は「setup が書くもの」だけでなく「アプリが読むもの」も列挙する**。

### Phase 5 の結果: pie-chart と docs

- **pie-chart**: `batch` が 83/83 OK（32 秒）、`batch:diff` が
  **「全 83 件が baseline と byte 一致」**。別環境でオフライン構築しても SVG 出力の決定性が
  保たれることの確認。
- **docs**: `build_all` が 4 冊（editor / pie-chart の手引き・設計）を 6 秒で生成。依存は
  `python-wheelhouse` から `--no-index` で導入でき、オフライン経路が成立している。
  `pytest docs/_build` は 12 passed。
- 生成 HTML の自己完結性を確認: mermaid をインライン保持、画像は `data:image/png;base64`、
  `src="http(s)://"` の外部参照は **0 件**。

### Phase 6 の結果: full E2E が完走（残項目①の消化）

`offline/` フォルダだけを置いた素のディレクトリで `setup-offline.ps1` を実行し、6 段すべてを
通過した。**これがリポジトリ分離プロジェクトの残項目①**で、これまで一度も実施されていなかった。

1. ソース zip を pin の不変コミット `ecc9aa5e…` から HTTPS 直取得 →
   sha256 `5dcf32b7…` が pin と一致
2. 親（`full\workspace`）へ展開。実行中の `offline/` 自身は上書きされない
3. 重量物バンドルを Release から取得 → sha256 `1fd1095c…` が pin と一致 → 分離署名の検証を通過
4. 展開 → **`[info] lockfile key 一致: 92b80d97…`**
5. corepack 登録 → オフライン install → build → `msnodesqlv8 ネイティブ .node を配置（require OK）`
   → PortableGit 導入（`git version 2.54.0.windows.1`）
6. ダウンロードしたアーカイブを `bk/` へ退避

full 側での最小の動作確認:

- `pnpm run typecheck` — exit 0（8 秒）
- `pnpm run test:pie-chart` — Test Files 21 passed | 1 skipped、Tests 318 passed | 4 skipped（131 秒）

**この経路は修正前には成立しなかった**。zip 展開したツリーは git 管理外なので、発見 1・3 の
どちらか（あるいは両方）で必ず止まっていた。full E2E が通ったこと自体が修正の妥当性の裏づけになる。

### 未修正の発見（別タスクとして起票する）

Phase 1 で見つかった 3 件は修正済み。以下の 2 件は本計画では直していない。

#### 発見 4: 却下理由がサーバで必須になっていない

- **症状**: `POST /api/review-requests/:reqId/reject` に空のボディを送ると 200 で差し戻しが成立する。
- **実装**: `ReviewDecisionBody` の `comment` は `z.string().optional()`、`reviewRepo.rejectReview` も
  有無を検査していない。理由の強制は画面側の制約に留まる。
- **設計正典との関係**: `docs/editor/src/設計正典.md` は確定保存の関所の性質として
  「自己承認拒否・**却下理由必須**・監査ログ」を挙げている。自己承認拒否は実際に効いていた
  （403 を実測）が、却下理由必須はサーバで強制されていない。
- **影響**: API を直接叩けば理由を残さず差し戻せる。権限昇格ではないが、「なぜ差し戻されたか」が
  監査ログに残らない経路がある。
- **修正案**: 却下時のみ `comment` を必須にする（承認時のメモは任意のまま）。スキーマを
  分けるか、`rejectReview` の入口で検査する。

#### 発見 5: docs のビルドとテストが `python` を直接呼ぶ

- **症状**: `docs\_build\build_all.bat` が `exit 9009`（コマンド未検出）で即座に失敗する。
  出力は「Python Python」で、これは Microsoft Store の python スタブの応答。
- **原因**: `build_all.bat` は `python -m pip` と `python build_all.py` を呼ぶ。この端末では
  `python` が `C:\Users\caads\AppData\Local\Microsoft\WindowsApps\python.exe`（Store スタブ）に
  解決され、実体は `py` ランチャ経由でしか使えない。`package.json` の `test:docs`
  （`python -m pytest docs/_build`）も同じ。
- **対比**: `check:comments` は `py -3.13 scripts/check-comments.py` と書かれており動く。
  同じリポジトリの中で呼び方が揃っていない。
- **確認**: `py -3.13` で同じ手順を踏むと成功する（wheelhouse からの `--no-index` 導入も
  build_all も pytest も通った）。**壊れているのは Python 環境ではなく起動の仕方**。
- **影響**: 配布先が `py` ランチャだけを持つ標準的な Windows 環境だと docs をビルドできない。
- **修正案**: `python` の解決可否を見て `py -3.13` へフォールバックする（`check-comments` と
  同じ呼び方へ揃える）。CLAUDE.md と README の手順記述も併せて直す。

### 最終状態

- **検証フォルダ** `C:\Users\Public\offline-verify\` は残置（ユーザー判断）。
  `local\workspace`（完全オフライン経路）と `full\workspace`（取得込み経路）の両方が構築済みで、
  次回の検証で再利用できる。
- **ユーザー環境変数は復元済み**。setup は local / full の両方で `GIT_BIN` と User PATH を
  書き換えたため、Phase 0 Step 12 に控えた値へ戻した。
  - `GIT_BIN` = `C:\Users\caads\workspace\git-tools\portablegit\cmd\git.exe`
  - User PATH から `C:\Users\Public\offline-verify\` 配下の 2 エントリを除去（残留なしを確認）
  - `DATA_ROOT`（= `C:\Users\caads\editor-data`）は**ユーザー判断により変更していない**。
    検証側はランチャの `set DATA_ROOT=…` で上書きする方式を採る。
- **現ワークスペースの editor-data** は作業ツリー clean・内容も検証前と同一
  （インシデントの `8f7d9fe` は `e466ab2` で revert 済み）。
- リポジトリの可視性は PUBLIC のまま（Phase 0 Step 1 の判断どおり変更していない）。
- **残項目②**（配布先端末の有無）は「配布済み端末なし」で完了。**残項目①**（full E2E）は
  Phase 6 の完走で消化。リポジトリ分離プロジェクトの残項目は 2 件とも閉じた。

### 修正の実施（同日・ユーザー判断により同一セッションで実施）

発見 3 件はいずれも修正済み。TDD で進め、追加した 2 件のテストが赤いことを確認してから実装した。

- `c7aff72` — 発見 1・3 の修正（`offline/lib/content-key.ps1`）。
  `Get-OfflineRequirementsFilesViaGit` が `rev-parse --show-toplevel` で `RepoRoot` 自身が
  リポジトリのルートであることを確かめてから `ls-files` を使うようにし、git を呼ぶ区間の
  `$ErrorActionPreference` を退避する。テストは `verify.Tests.ps1` に「git 管理外」
  「別リポジトリ配下」の 2 条件を追加（判定は `$null -eq`。`BeNullOrEmpty` は空配列と
  区別できずフォールバックの退行を通してしまう）。
- `ecc9aa5` — 発見 2 の修正（`offline/publish-offline-bundle.ps1`）。認証ヘッダを作業用一時
  ディレクトリへ LF で書き `-H "@<file>"` で渡す。トークンはコマンドライン引数に載らないまま。
- `31c33d2` — pin をスクリプトの実行結果で更新（`source-commit` = `ecc9aa5`、
  `source-zip-sha256` = `5dcf32b7…`）。

**検証結果:**

- `pnpm run ci:offline`（Pester）: 45 passed / 0 failed。
- content key は開発機・git 管理外の展開先の**どちらでも** `92b80d97…` になり、
  Release の `bundle.key` と一致。重量物の再生成は不要と確認。
- `publish-offline-bundle.ps1` を通常実行して完走。pin の生成まで手動介入なしで通った
  （修正前は必ず 400 で失敗していた段）。
- `pnpm run check:comments`: 0 error / 0 warning。

### 再開手順（実施済み）

1. 発見 1・3 を `offline/lib/content-key.ps1` で修正し、`verify.Tests.ps1` に 2 条件を足す。
2. 発見 2 を `offline/publish-offline-bundle.ps1` で修正する。
3. pin を更新する（`publish-offline-bundle.ps1` の通常実行で完結した）。
4. `C:\Users\Public\offline-verify\{local,full}\workspace\offline\` へ修正後の `offline/` を
   再配置し、`local\workspace` のソースも新しい pin のコミットから取り直す。
5. 本計画の Phase 1 から再開する。
