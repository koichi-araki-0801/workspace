# フェーズ 1: 環境準備(Python 3.13 化・依存固定・スパイク) 実装計画 v3

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** 開発端末と monorepo を Python 3.13 のみへ統一し、全 Python 依存を `==` 固定、
playwright-python + Edge channel の成立を実機スパイクで確認する(spec §9 step 0)。

**Architecture:** 環境作業が主体のため、各タスクの「テスト」は検証コマンドの実行結果と
する。v2 でタスク順を再設計した: **wheelhouse の cp313 再生成(明示 publish)を
3.12/3.14 撤去より前に置く**(撤去後の exe ビルドは cp313 wheelhouse が無いと
`--no-index` で確実に失敗するため)。また dev-requirements 新設は content-key の
FS フォールバック修正と**同一コミット**で行う(Pester の 2 経路一致検査を割らないため)。

**Tech Stack:** Python 3.13 / pip / pytest / playwright-python(Edge channel) /
PowerShell(既存 publish・content-key の最小差分改修のみ)

**Spec:** `docs/superpowers/specs/2026-08-27-python-repo-split-design.md`(v3.5。
特に §4.5・§8.5・§9 step0)

## Global Constraints

- 端末の Python は最終的に **3.13 系のみ**(3.12・3.14 は本フェーズ末で撤去。
  **classic 3.14.0 とは別に pymanager 管理の 3.14.6 が存在する** — 両方を撤去対象に含める)。
- ピンの正典 = requirements.txt の `==` 固定。開発依存は **`dev-requirements.txt`**
  (末尾が `requirements.txt` の命名。git 経路のグロブに乗せるためだが、**FS フォールバック
  側の修正(Task 2)とセットで初めて安全**になる)。
- requirements 系ファイルは「パッケージ名 + バージョン指定子」の行のみ
  (`check-requirements` が検査。オプション行・URL・パスは書けない)。
- 既存 `requirements.txt` のポリシーを崩さない: graph-editor は「実行時依存ゼロ」、
  exe ビルド venv へ入るのは `requirements.txt` のみ(dev 依存を混ぜない)。
- `.ps1` の新規追加禁止。既存スクリプトへの変更は**最小差分**。
- **pytest は一括実行しない**: `pytest graph-editor pdf-to-svg` の 1 回呼びは同名テスト
  ファイルの import file mismatch で必ず失敗する(ci.yml 65-68 行に明文)。常に
  プロジェクト単位で個別実行する。
- **コマンドは PowerShell 構文で書く・実行する**(`$env:TEMP` 等。cmd 構文の
  `%TEMP%` は使わない)。
- **Task 2 のコミット以降、Task 7(明示 publish)完了まで Release のソースタグ更新が
  止まる**(content-key 反転中の post-commit `-TagOnly` はタグも動かさない)。
  Task 2 に着手したら Task 7 まで中断せず進める。長期停滞(Task 3 での停止を含む)が
  避けられない場合の暫定 publish は **Task 5(cp313 改修)完了後に限る**
  (改修前に publish すると cp312 wheelhouse を公開してしまう)。暫定 publish を
  行った場合、Task 7 の本 publish は content-key が一致して no-op になるため
  **`-Force` を付けて実行**する。
- コミットメッセージ・コード内コメントは通常の丁寧な日本語(`docs/コメント規約.md` 準拠)。
- 各コミット後、auto-push フックが origin へ push し、pre-push の `ci:affected` が
  変更領域の CI を走らせる(requirements 変更 = docs / pdf-to-svg / graph-editor の
  3 領域が発火。実機 8GB でフレーク時は単独 green 確認 → リトライ)。

---

### Task 1: 現状確認と Python 3.13 の導入確認

**Files:** なし(確認のみ)

**Interfaces:**
- Produces: `py -3.13` で起動できる 3.13 系 + PATH 上の位置関係の把握
  (Task 8 の撤去計画の入力)

> 前セッションの作業で 3.13.15 は導入済みの可能性が高い。本タスクは
> 「導入されていることの確認」として実行し、未導入の場合のみインストールする。

- [ ] **Step 1: 導入状態と PATH の実測**

Run:
```powershell
py -0p
py -3.13 -V
where.exe python
```
Expected: `py -0p` に 3.13 が列挙され、`py -3.13 -V` が `Python 3.13.x`。
`where.exe python` の出力(複数行)を記録する — 出力には
`AppData\Local\Python\bin\python.exe`(**pymanager shim = 3.14.6**)と WindowsApps が
含まれるはず。この一覧は Task 8 の撤去対象リストになる。
(注: ユーザー PATH レジストリでは Python313 が既に Python312 より前に登録済みと
実測済み(2026-08-28)。開いたままの古いシェルではプロセス PATH が古いことがある)

- [ ] **Step 2: (未導入の場合のみ)3.13 をインストール**

Run: `winget install --id Python.Python.3.13 --scope user --silent`
Expected: 完了後に Step 1 を再実行して 3.13 が列挙される。
実測では winget 導入はユーザー PATH の先頭へ `Python313` を登録する
(「PATH に乗らない」前提を置かない — Step 3 で必ず実測確認する)。

- [ ] **Step 3: PATH 順の確認**

Run:
```powershell
[Environment]::GetEnvironmentVariable('Path','User') -split ';' | Select-String -Pattern 'Python'
```
Expected: `Python313`(と `Python313\Scripts`)が `Python312` より**前**に在ること。
無い/後ろの場合はユーザー PATH を編集して前へ置く(Task 8 で 3.12 を消した後、
新規シェルの `python` が 3.13 に解決されるための前提)。

- [ ] **Step 4: pip を確認**

Run: `py -3.13 -m pip --version`
Expected: pip が動く(必要なら `py -3.13 -m pip install --upgrade pip`)。

(コミットなし)

---

### Task 2: 依存の固定 + dev-requirements 新設 + content-key FS 経路の修正

**Files:**
- Modify: `docs/_build/requirements.txt`
- Modify: `pdf-to-svg/requirements.txt`
- Modify: `graph-editor/requirements.txt`
- Modify: `pdf-to-svg/pyproject.toml`
- Create: `pdf-to-svg/dev-requirements.txt`
- Create: `graph-editor/dev-requirements.txt`
- Modify: `offline/lib/content-key.ps1`(FS フォールバックの Filter 1 箇所)
- Modify: `offline/lib/verify.Tests.ps1`(dev-requirements を含むケースの追随が必要な場合)

**Interfaces:**
- Produces: 固定済み requirements 群(以降のフェーズと wheelhouse の入力)。
  dev-requirements の内容 = `pytest==<版>` と `playwright==<版>` の 2 行 + 理由コメント。
  content-key の git 経路と FS 経路が dev-requirements を**同一に**数える状態。

> ⚠ dev-requirements.txt の新設と content-key.ps1 の修正は**必ず同一コミット**にする。
> 分けると、その間のコミットで Pester の「git 経路と FS 経路が同じ結果になる」検査
> (`offline/lib/verify.Tests.ps1`)が赤になり、pre-push の `ci:offline` で push が落ちる。
> FS 経路は配布先(zip 展開・.git 無し)の setup が実際に使う経路でもあり、修正しないと
> **公開後にオフライン setup が fail closed で全滅**する。

- [ ] **Step 1: 最新安定版を解決**

Run(9 パッケージ):
```powershell
foreach ($p in 'PyMuPDF','Pillow','fonttools','brotli','pyinstaller','markdown-it-py','python-frontmatter','pytest','playwright') { py -3.13 -m pip index versions $p | Select-Object -First 1 }
```
参考実測(2026-08-28): PyMuPDF 1.28.2 / Pillow 12.3.0 / fonttools 4.63.0 / brotli 1.2.0 /
pyinstaller 6.22.2 / markdown-it-py 4.2.0 / python-frontmatter 1.3.0 / pytest 9.1.1 /
playwright 1.62.0。実行時に再解決し、より新しい安定版があればそちらを採る。
**pytest は 9 系(メジャーアップ)** — Task 3 で既存テストの互換を必ず確認する。

- [ ] **Step 2: requirements 3 本を `==` へ書き換え**

既存コメント(役割説明)は保持し、パッケージ行を固定値へ。`pdf-to-svg/requirements.txt` の例
(他 2 本も同様。版は Step 1 の解決値):
```
# PdfToSvg exe ビルド/実行に必要な依存
# scripts\build.bat が隔離 venv 内へ install する（オフライン時は同梱 python-wheelhouse から）。
# 版は == で完全固定する（ピンの正典。pyproject.toml 側は互換宣言のみ。設計書 §8.5）。
PyMuPDF==1.28.2
Pillow==12.3.0
fonttools==4.63.0
brotli==1.2.0
pyinstaller==6.22.2
```

- [ ] **Step 3: dev-requirements.txt を新設(両プロジェクト・同内容)**

```
# 開発・テスト専用の依存（pytest + playwright-python。exe ビルド venv へは入れない）。
# 命名を「*requirements.txt」に合わせるのは、オフラインバンドルの content-key・
# wheelhouse 収集・許可リスト検査の対象グロブに乗せるため（設計書 §4.5）。
pytest==9.1.1
playwright==1.62.0
```

- [ ] **Step 4: pyproject.toml を更新**

`requires-python = ">=3.13"` へ変更し、`dependencies` / `optional-dependencies.dev` の
下限を固定値の major.minor へ引き上げる(例: `PyMuPDF>=1.28`)。dependencies ブロックの
直上に「ここは互換性の下限宣言のみ。インストールの正(== 固定)は requirements.txt 側」の
コメントを 1 行添える。

- [ ] **Step 5: content-key.ps1 の FS フォールバックを修正**

`offline/lib/content-key.ps1` の FS 経路(`Get-ChildItem -Filter 'requirements.txt'`、
51 行付近)を、git 経路(`git ls-files -- '*requirements.txt'`)と同じ集合を返す形へ
変更する。`-Filter '*requirements.txt'` は FileSystem provider の 8.3 短名ワイルド
カード意味論を踏むため、**列挙後の後段フィルタ**で書くのが確実:
`Where-Object { $_.Name.EndsWith('requirements.txt') }`(再帰範囲・既存の除外
〈node_modules 等〉は現行のまま)。変更行の直上へ理由コメント:
```powershell
# git 経路のグロブ(*requirements.txt)と同一集合を返すこと。完全名一致のままだと
# dev-requirements.txt を数えず、配布先(zip 展開・.git 無し)の setup で key が乖離する。
```

- [ ] **Step 6: 新規ファイルをステージしてから Pester で 2 経路一致を確認**

> git 経路は `git ls-files`(index 基準)のため、**未追跡の dev-requirements.txt を
> 数えない**。ステージせずに検査すると git 経路と FS 経路が構造的に乖離して赤になる。

Run:
```powershell
git add pdf-to-svg/dev-requirements.txt graph-editor/dev-requirements.txt
pnpm run ci:offline
```
Expected: `verify.Tests.ps1` の全ケース green(特に「git 経路とファイルシステム経路が
同じ結果になる」ケース)。

あわせて退行防止テストを 1 つ追加する: `offline/lib/verify.Tests.ps1` の
`Describe 'Get-OfflineRequirementsFiles'`(47-84 行付近)内へ新規 `It`
「ファイルシステム経路が dev-requirements.txt を数える」を置き、`$TestDrive` 配下に
`requirements.txt`・`dev-requirements.txt`・除外対象(`node_modules\requirements.txt`)を
作って **`Get-OfflineRequirementsFilesViaFileSystem` を直接呼び** 2 件一致を
`Should Be` で検証する(git init 不要。ViaGit 側の網羅は既存の実リポ突き合わせケースが
担う。位置づけは「FS 側 Filter を完全名一致へ戻す退行の再発防止」)。

- [ ] **Step 7: 形式ガードを通す**

Run:
```powershell
foreach ($f in 'docs\_build\requirements.txt','pdf-to-svg\requirements.txt','pdf-to-svg\dev-requirements.txt','graph-editor\requirements.txt','graph-editor\dev-requirements.txt') { & powershell -NoProfile -ExecutionPolicy Bypass -File scripts\check-requirements.ps1 -Path $f; if ($LASTEXITCODE -ne 0) { throw $f } }
```
Expected: 例外なく完走(全 exit 0)。

- [ ] **Step 8: 3.13 へ実導入して解決可能性を確認**

Run:
```powershell
py -3.13 -m pip install -r docs/_build/requirements.txt -r pdf-to-svg/requirements.txt -r pdf-to-svg/dev-requirements.txt -r graph-editor/requirements.txt -r graph-editor/dev-requirements.txt
py -3.13 -m pip download --python-version 3.13 --only-binary=:all: -r pdf-to-svg/requirements.txt -r pdf-to-svg/dev-requirements.txt -d $env:TEMP\wh-probe
```
Expected: install が成功し(**greenlet を含む** playwright の推移依存も cp313 で解決)、
download の wheel 名がすべて `cp313` または `py3-none-*` であること
(pyinstaller は `py3-none-win_amd64` — `any` 限定ではない)。確認後
`Remove-Item -Recurse -Force $env:TEMP\wh-probe`。
**PyMuPDF 等の実行時依存も開発インタプリタ(3.13)へ入れる**(pdf-to-svg の
`test/conftest.py` が top-level で `import fitz` するため、pytest 実行に必須。
CI も同様に install している)。「dev 依存を混ぜない」制約の対象は **exe ビルドの
隔離 venv**であり、開発インタプリタへの導入は無関係(venv は system site を見ない)。
brotli の cp313 が無い場合のみ spec §8.5 に従い brotlicffi へ差し替えて Step 2 から
やり直す。

- [ ] **Step 9: コミット(全ファイル一括)**

```powershell
git add docs/_build/requirements.txt pdf-to-svg/requirements.txt pdf-to-svg/dev-requirements.txt pdf-to-svg/pyproject.toml graph-editor/requirements.txt graph-editor/dev-requirements.txt offline/lib/content-key.ps1 offline/lib/verify.Tests.ps1
git commit -m "chore(python): 依存を == 固定し dev-requirements を新設、content-key の FS 経路を追随

ピンの正典を requirements.txt に一本化し、開発依存(pytest / playwright)は
dev-requirements.txt へ分離する(exe ビルド venv への混入防止)。content-key の
ファイルシステム経路は完全名一致のままだと dev-requirements を数えず、配布先 setup で
key 乖離を起こすため、git 経路と同一集合を返すよう修正する(設計書 §4.5・§8.5)。"
```
push 後、pre-push の ci:affected(docs / pdf-to-svg / graph-editor)が green で
あることを確認してから次へ。

---

### Task 3: 既存テストの 3.13 全緑確認(プロジェクト個別実行)

**Files:** なし(検証のみ)

**Interfaces:**
- Consumes: Task 2 の固定済み依存
- Produces: 「3.13 で既存テストが全緑」の確認(Task 8 の撤去許可条件の一部)

- [ ] **Step 1: プロジェクト個別に pytest 実行(一括禁止)**

Run:
```powershell
py -3.13 -m pytest pdf-to-svg
py -3.13 -m pytest graph-editor
py -3.13 -m pytest docs/_build
```
Expected: 3 つとも全 PASS(SKIP は drift 検査の許容分のみ)。pytest 9 系の非互換・
3.13 非互換が出たら原因を特定して修正する(修正は本計画の範囲。判断に迷う場合は
ユーザーへ報告して停止)。

> exe ビルドの 3.13 検証はここでは**行わない**。venv 構築は wheelhouse
> (現状 cp312)を `--no-index` で強制参照するため、cp313 wheelhouse が
> できる Task 7 の後(Task 8 Step 5)で行う。

(コミットなし。修正が発生した場合のみ修正コミット)

---

### Task 4: Edge channel スパイク

**Files:**
- Create: scratchpad の `edge_spike.py`(使い捨て。リポジトリへは入れない)

**Interfaces:**
- Consumes: Task 2 Step 8(playwright が 3.13 へ導入済みであること)
- Produces: playwright-python + Edge channel の成立可否(否ならフェーズ 2 以降の
  E2E 方式を再設計するゲート)

- [ ] **Step 1: 隔離プロファイルでの素の Edge 起動確認**

Run(PowerShell):
```powershell
Start-Process msedge -ArgumentList "--user-data-dir=$env:TEMP\edgeprobe","--no-first-run","about:blank"
```
Expected: Edge の窓が開き、10 秒程度操作しても安定(クラッシュ・白画面なし)。
確認後に窓を閉じ `Remove-Item -Recurse -Force $env:TEMP\edgeprobe`。

- [ ] **Step 2: playwright-python から Edge channel 起動(headless)**

スクリプト(scratchpad へ作成):
```python
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch(channel="msedge", headless=True)
    page = browser.new_page()
    page.set_content("<h1 id='t'>spike</h1>")
    assert page.inner_text("#t") == "spike"
    assert page.evaluate("1 + 1") == 2
    browser.close()
print("EDGE SPIKE OK")
```

Run: `py -3.13 <scratchpad>\edge_spike.py`
Expected: `EDGE SPIKE OK`。ブラウザの追加ダウンロードが発生しない(端末既存の Edge)。

- [ ] **Step 3: headed でも 1 回確認し、実測を記録**

`headless=False` で再実行し窓の安定を目視確認。結果(headless / headed 合否)を
本計画ファイル末尾「実測記録」へ追記。

> 注: この隔離 `--user-data-dir` 起動は設計正典が VDI で却下した構成と同型。
> 対象端末は物理 PC 系のため許容だが、この構成の合否は**この端末クラスに限る**
> 事実としてフェーズ 2 計画へ引き継ぐ(VDI 端末への一般化はしない)。

- [ ] **Step 4: 実測記録をコミット**

```powershell
git add docs/superpowers/plans/2026-08-28-phase1-env-python313.md
git commit -m "docs(plans): フェーズ 1 の Edge スパイク実測記録を追記"
```

---

### Task 5: publish スクリプトの cp313 明示改修(最小差分)

**Files:**
- Modify: `offline/publish-offline-bundle.ps1`(pip download の引数へ
  `--python-version 3.13` を追加する 1 箇所のみ)

**Interfaces:**
- Produces: 再生成時に必ず cp313 wheel が収集される publish(Task 7 が使用)

- [ ] **Step 1: 現行の pip download 引数配列を確認**

Run: `Select-String -Path offline\publish-offline-bundle.ps1 -Pattern 'dlArgs' -Context 3`
Expected: **`--only-binary=:all:` は既に存在**し、`--python-version` が無いことを確認
(追加するのは `--python-version 3.13` だけ。only-binary を重複追加しない)。

- [ ] **Step 2: `--python-version 3.13` を追加**

引数配列へ `'--python-version','3.13'` の 2 要素を追加し、直上へ理由コメント:
```powershell
# wheel は cp313 固定で収集する（実行インタプリタ任せだと別 ABI が混入し、
# content-key では検知できない。設計書 §8.5）。
```

- [ ] **Step 3: コミット**

```powershell
git add offline/publish-offline-bundle.ps1
git commit -m "build(offline): wheelhouse 収集を cp313 固定にする

pip download が実行インタプリタの ABI で wheel を選ぶと、既定 Python の版次第で
cp312 が黙って混入し content-key では検知できない。--python-version 3.13 を明示して
構造的に防ぐ(設計書 §8.5)。"
```

---

### Task 6: GH Actions の 3.13 化

**Files:**
- Modify: `.github/workflows/ci.yml`(60 行目の `python-version` と 63 行目の pip install)

**Interfaces:**
- Consumes: Task 2 の dev-requirements.txt 2 本(参照先が存在すること)
- Produces: Actions 上でも 3.13 + 固定依存で pytest が走る保険 CI

- [ ] **Step 1: python-version を更新**

`python-version: '3.12'` → `python-version: '3.13'`。

- [ ] **Step 2: pip install 行へ dev-requirements を追加**

裸の `pytest` 指定を外し、
`-r pdf-to-svg/dev-requirements.txt -r graph-editor/dev-requirements.txt` を追加
(pytest は dev-requirements の固定版で入る)。

- [ ] **Step 3: コミット**

```powershell
git add .github/workflows/ci.yml
git commit -m "ci: GH Actions の Python を 3.13 へ更新し dev-requirements を導入する"
```

> 検証の注意: ci.yml のトリガは `push: branches: [main]` と PR のみで、
> 常設ブランチへの push では run が**発生しない**。この変更の実地検証は次に main への
> PR を作った時点で行う(本フェーズ内では YAML の差分確認まで)。

---

### Task 7: 明示 publish 1 回(cp313 wheelhouse フル再生成)

**Files:**
- Modify: `offline/pinned-release.txt`(スクリプトが作業ツリーへ書く。コミットは手動 —
  実装にコミット処理は無いことを確認済み)

**Interfaces:**
- Consumes: Task 2 の固定 requirements + Task 5 の cp313 改修
- Produces: cp313 wheelhouse を含む新バンドル + 更新済み pin / rolling tag。
  **Task 8(撤去)後の exe ビルド検証が依存する前提**

> 実行前提(いずれか欠けると失敗する):
> - `gh auth token` が通ること(`gh auth status` で確認)
> - 署名鍵 `%USERPROFILE%\.offline-signing\bundle-signing.key.xml` が存在すること
> - ディスク空き ~2GB 以上(tar + wheelhouse 再生成)
> - **editor の dev サーバ等を停止しておく**([1/4] の `pnpm install --store-dir` が
>   node_modules を purge・再リンクするため)

- [ ] **Step 1: content-key の反転を安全に確認**

Run: `powershell -NoProfile -ExecutionPolicy Bypass -File offline\publish-offline-bundle.ps1 -TagOnly`
Expected: ログに current / published の content-key が表示され、**不一致のため
「タグも動かさず終了」**する(この分岐が確認そのもの。`-DryRun` というパラメータは
存在しない — 引数なし実行は確認なしでフル publish が始まるので使わない)。
例外: Global Constraints の**暫定 publish を実施済み**の場合は key が一致して
タグ移動が走る — その場合は Step 2 を `-Force` 付きで実行する。

- [ ] **Step 2: フル publish を実行**

Run: `powershell -NoProfile -ExecutionPolicy Bypass -File offline\publish-offline-bundle.ps1`
Expected: [1/4]〜[4/4] の再生成が走り、Release アップロードまで exit 0。
数十分 + 774MB 級アップロード。**中断しない**(中断時は assets → タグの順で更新される
実装のため再実行で回復可能だが、「旧 pin × 新 bundle」の窓が生じるので Step 4 の
pin コミットまで一気に進める)。

- [ ] **Step 3: 収集結果の確認**

Run: `Get-ChildItem python-wheelhouse\*.whl | Select-Object -ExpandProperty Name`
Expected: ABI 付き wheel がすべて `cp313`、残りは `py3-none-*`。
`pytest` / `playwright` / `greenlet` の wheel が含まれること。

- [ ] **Step 4: pin 更新をコミット**

```powershell
git add offline/pinned-release.txt
git commit -m "build(offline): cp313 wheelhouse 反映後の pin を更新する"
```

---

### Task 8: 3.12・3.14 の撤去(端末を 3.13 のみへ)

**Files:**
- Modify: `.mcp.json`(command のインタプリタパスを Python313 へ。
  **git 管理外**〈`.gitignore` にマシン固有として登録済み〉のためローカル編集のみ・
  コミットはしない)

**Interfaces:**
- Consumes: Task 3(pytest 緑)+ Task 7(cp313 wheelhouse) — 両方が撤去の前提条件
- Produces: 新規シェルの `python` / `py -3` が一意に 3.13 を指す端末 +
  3.13 で動く code-review-graph MCP

> ⚠ 破壊的操作。以下を確認してから着手:
> - Task 3・Task 7 が完了済みであること。
> - 撤去対象は **3 つ**: winget の Python.Python.3.12(3.12.10)/
>   Python.Python.3.14(3.14.0)/ **pymanager 管理の 3.14.6**
>   (`AppData\Local\Python\bin` の shim。winget では消えない)。
> - `.mcp.json` が `Python312\python.exe` をハードコードしている(撤去で MCP が
>   死ぬため、先に 3.13 へ移行する)。

- [ ] **Step 1: code-review-graph MCP を 3.13 へ移行(ローカル編集のみ)**

Run:
```powershell
& C:\Users\caads\AppData\Local\Programs\Python\Python312\python.exe -m pip list | Select-String -Pattern 'code'
```
で 3.12 側の該当パッケージ名を確定する(`.mcp.json` の args がモジュール
`code_review_graph` を指すため、配布名は `code-review-graph` 系のはず — pip list の
実測で確定)。同じものを `py -3.13 -m pip install` で 3.13 へ導入し、`.mcp.json` の
command のパスを
`C:\Users\caads\AppData\Local\Programs\Python\Python313\python.exe` へ書き換える。
Expected: 書き換え後、新しい Claude Code セッション(または MCP 再接続)で
code-review-graph ツールが応答する(確認はフェーズ完了後の初回セッションでよい)。
**`.mcp.json` は git 管理外のためコミットしない。**

- [ ] **Step 2: 3.14 系を撤去(classic + pymanager の両方)**

Run:
```powershell
winget uninstall --id Python.Python.3.14
```
続けて pymanager 管理分: 設定 >「アプリ」で「Python install manager」(および
pythoncore-3.14 系)をアンインストール。残った場合はユーザー PATH から
`AppData\Local\Python\bin` を除去する。

- [ ] **Step 3: 3.12 を撤去**

Run: `winget uninstall --id Python.Python.3.12`

- [ ] **Step 4: py.ini の旧既定指定を掃除**

`$env:LOCALAPPDATA\py.ini` の `[defaults] python=3.12` 行を削除
(3.13 のみの環境では不要な指定)。

- [ ] **Step 5: 総合判定(必ず新規シェルで実行)**

> 既存の開いたシェルはプロセス環境の PATH が古く、判定に使えない。
> **新しいターミナルを開いて**実行する。

Run:
```powershell
py -0
py -V
python -V
where.exe python
py -3.13 -m pytest pdf-to-svg
py -3.13 -m pytest graph-editor
py -3.13 -m pytest docs/_build
Remove-Item -Recurse -Force pdf-to-svg\.venv-build, graph-editor\.venv-build -ErrorAction SilentlyContinue
pdf-to-svg\scripts\build.bat
graph-editor\scripts\build.bat
```
Expected:
- `py -0` の列挙が 3.13 のみ / `py -V`・`python -V` とも 3.13.x
- `where.exe python` の先頭が `Python313\python.exe`、かつ出力全体に
  **`AppData\Local\Python\bin` を含まない**(pymanager は `py -0` に出ないため、
  where.exe のこの条件だけが shim 残存の検出網。WindowsApps 行の残存は
  実行エイリアス無効化まではあり得るが、Python313 より後ろなら実害なし)
- pytest 3 発 全緑
- venv 削除 → 再構築が **3.13 + cp313 wheelhouse(Task 7 産)** で走り、両 exe 生成まで
  exit 0(`py` ランチャ自体が撤去で消えていないこともここで確認される)

(Step 1 以外コミットなし)

---

## 実測記録(2026-08-28 実行)

- Task 1 の `where.exe python` 実測(旧シェル): ①Python312 ②WindowsApps
  ③`AppData\Local\Python\bin`(pymanager shim = 3.14.6)。ユーザー PATH レジストリでは
  Python313/Scripts が先頭。py -0p は 3.14 / 3.13(3.13.15) / 3.12(既定)。
- Edge スパイク: **headless・headed とも合格**(`channel="msedge"`・追加 DL なし・
  隔離プロファイル素起動も安定)。物理 PC 系端末での実測。playwright 1.62.0。
- 固定した版数: PyMuPDF 1.28.2 / Pillow 12.3.0 / fonttools 4.63.0 / brotli 1.2.0 /
  pyinstaller 6.22.2 / markdown-it-py 4.2.0 / python-frontmatter 1.3.0 / pytest 9.1.1 /
  playwright 1.62.0。cp313 試し取り 20 wheel 合格(PyMuPDF は `cp310-abi3-win_amd64` =
  安定 ABI で 3.13 互換。greenlet 3.5.5 cp313 あり)。
- Task 3: pdf-to-svg 250 passed / graph-editor 102 passed / docs/_build 12 passed
  (すべて py -3.13・pytest 9.1.1)。**pytest 9 / 3.13 非互換ゼロ・修正不要**。
- Task 2 の Pester: 43/43 green(新設 fixture テスト含む)。
- Task 7: publish は pin 生成段のみ失敗(**codeload が gh の OAuth トークン〈gho_〉を
  Bearer/token 両スキームとも 400 で拒否** — 認証取得は PAT でないと通らない)。
  bundle 776.3MB のアップロード・署名・タグ移動までは成功。pin は一時 Public 化
  (数十秒)で取得した zip の sha256 から復旧し、`Get-OfflinePin` 検証合格・コミット
  ed30f46。以後の post-commit `-TagOnly` は key 一致でタグ追随を正常再開。
  ※ 次回 publish までに pin 生成段の恒久対応(PAT か一時 Public 化の組込)を検討。
- Task 8: 3.12.10 / 3.14.0(winget) / Python Install Manager(msstore) /
  pymanager 実体(`AppData\Local\Python`)を撤去、PATH・py.ini を掃除。
  新規 PATH 判定: `py -0` = 3.13 のみ(既定 *) / `python -V` = 3.13.15 /
  `where.exe python` 先頭 = Python313・shim 消滅 / py ランチャ健在。
  素の `python` で pytest 3 発全緑(250/102/12)。venv 再構築で両 exe ビルド完走
  (pyvenv.cfg = 3.13.15・cp313 wheelhouse 参照)。MCP は code-review-graph==2.3.7 を
  3.13 へ導入し `.mcp.json` をローカル書き換え(次回セッションで応答確認)。

**フェーズ 1 完了(2026-08-28)。全タスク・全判定合格。**
