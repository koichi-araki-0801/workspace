# フェーズ 4: 新リポ python-tools の作成と基盤整備 実装計画 v2

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** monorepo の pdf-to-svg + graph-editor + docs(原稿・ビルダ)を新リポ
**`koichi-araki-0801/python-tools`(private)** へスナップショットで移し、Node 非依存の
開発基盤(setup 入口・git hooks 3 本・check-comments.py・offline publish/setup の
Python 版・Ed25519 署名)を整備して「clone + setup-offline + setup-dev だけで開発・
テスト・exe ビルド・配布が完結する」状態にする(spec §3・§8・§9 step3-4)。

**Architecture(v2 で確定した設計):**
- **スナップショットは `git ls-files` 基準**でコピーする(working tree 直コピーだと
  coverage/ test-results/ bundle.key 等の生成物が混入する)。追加で必要な git 管理外の
  実体は 2 つだけ: `docs/_build/vendor/` の JS 2 件(mermaid/elk — 配布 bundle の同梱物)と
  `python-wheelhouse/`(cp313 済みの一時コピー・コミットしない)。
  **snapshot 元の monorepo HEAD SHA を記録し初期コミットメッセージへ刻む**(凍結確認の
  起点)。
- **`.gitignore` は vendor を丸ごと無視しない**: monorepo と同じく vendor 内 JS 2 件のみ
  ignore し、**`docs/_build/vendor/manifest.txt` はコミット**する(content-key の材料。
  丸ごと ignore すると clean clone で content-key が算出不能)。
- **配布先ブートストラップの順序**(Ed25519 検証の鶏卵回避): setup_offline は
  ①pin 読込(無ければ即死) → ②bundle 取得 → ③**pin の bundle-sha256 を stdlib hashlib で
  検証**(これが主アンカー・fail-closed) → ④展開 → ⑤wheelhouse から cryptography を
  `--no-index` 導入 → ⑥**Ed25519 署名検証**(多層防御・失敗なら展開物を削除して中止)。
  現行 RSA-XML が .NET 内蔵で依存ゼロだったのに対し、cryptography は bundle 内にしか
  無いため検証を sha256(内蔵)→署名(導入後)の 2 段に分ける。
- **check_requirements は pip へ渡す全入口に配線**する(monorepo の中核教訓「守りを
  足すときは通らない経路を列挙する」): 入口 = setup_dev / build_venv / publish の
  pip download / CI。入口列挙はガードテストで機械固定。
- **一時 Public 化の自動化**(pin の source zip 取得。codeload は gh の OAuth トークンを
  400 拒否 — フェーズ 1 実測): publish が `gh repo edit --visibility public|private
  --accept-visibility-change-consequences` で窓を開閉。事前に現 visibility を確認し
  (既に public なら中止)、finally で復帰・復帰失敗時は手動コマンドを表示して非 0 終了。
  **プロセス kill・電源断では finally が走らない残余リスク**を README-offline に明記
  (「中断時は visibility を必ず確認」)。
- **旧 TS/mjs テストは持ち込まない**(新リポのテストは Python 版のみ)。移植の照合知見
  (対応表 109 + 38 行)は**新リポ docs へコピー**して到達可能にする。
- 作業ディレクトリは **`C:\Users\caads\python-tools`**。monorepo 側の分離対象は
  **T1 Step 2(snapshot SHA 記録)時点で凍結**。

**Tech Stack:** Python 3.13 / pytest + playwright-python(導入済み) / cryptography
(Ed25519・実装時に最新安定を解決して `==` 固定) / gh CLI / tar(Windows 標準 bsdtar)

**Spec:** `docs/superpowers/specs/2026-08-27-python-repo-split-design.md`(v3.6)

## Global Constraints

- 新リポは **Python 第一・`.ps1` 禁止・`.bat` は python を呼ぶランチャのみ**
  （monorepo の `.bat` 規約に従い `chcp 65001` + CRLF なら日本語コメント可。
  当初の「ASCII のみ」は最終レビューで実態に合わせて緩和）。
- コメント・コミットメッセージは丁寧な日本語(`docs/コメント規約.md` を持ち込む)+
  末尾に Claude-Session 行:
  Claude-Session: https://claude.ai/code/session_01C8TAKZaatEcrSTKzR6W9q3
- 新リポの hooks は T2(pre-commit)/T6(pre-push・post-commit)で段階導入。T1-T5 の
  push は実装者が明示実行。**外向き操作**(gh repo create・Release・一時 Public 化)は
  承認済み範囲。**一時 Public 化を伴う初回 publish(T5)はコントローラが直前に 1 行
  報告してから**。
- 秘密鍵は `%USERPROFILE%\.python-tools-signing\` — リポへ入れない(.gitignore にも
  `*.key.pem` を多層防御で入れる)。
- **content-key** = `git ls-files -- '*requirements.txt'` の各内容 +
  `docs/_build/vendor/manifest.txt` の内容の SHA256。FS フォールバックは
  `Name.endswith('requirements.txt')` で**最初から同一集合**。**Release には
  `bundle.key`(content-key 値)もアセットとして置く**(`--tag-only` の比較材料 —
  monorepo と同型)。
- 検証は `py -3.13 -m pytest <dir>` を個別実行(一括禁止)。**`pytest scripts` も
  ゲートに含める**(pre-push・CI・T7)。
- **`.gitattributes` を新設し `scripts/hooks/*` を `text eol=lf` に固定**(sh シムが
  CRLF でチェックアウトされると `#!/bin/sh\r` で壊れる)。`*.js` / `*.cjs` の
  `eol=lf` も monorepo から踏襲(カバレッジゲートの offset 整合)。
- monorepo 側は本フェーズでは変更しない(計画・マスターの更新コミットのみ)。

---

### Task 1: 新リポ作成 + スナップショット初期コミット

**Files(新リポ):** 対象ツリー全体 + `.gitignore` + `.gitattributes` + 最小 `README.md` +
`docs/plans/`(対応表 2 枚のコピー)
**Files(monorepo scratchpad):** snapshot スクリプト(使い捨て)

**Interfaces:**
- Produces: `C:\Users\caads\python-tools` = git リポ(main・origin 設定・初期コミット
  push 済み)。snapshot 元 SHA が初期コミットメッセージに記録済み。**以後 monorepo の
  分離対象は凍結。**

- [ ] **Step 1: リポ作成**

```powershell
gh repo create koichi-araki-0801/python-tools --private --description "帳票図版の加工ツール群(pdf-to-svg / graph-editor)。Python 専用・オフライン配布対応"
git init C:\Users\caads\python-tools -b main
Set-Location C:\Users\caads\python-tools
git remote add origin https://github.com/koichi-araki-0801/python-tools.git
```

- [ ] **Step 2: スナップショット(git ls-files 基準・使い捨て Python スクリプト)**

monorepo で `SNAP_SHA=$(git rev-parse HEAD)` を記録。コピーは
`git -C <monorepo> ls-files -- graph-editor pdf-to-svg docs/_build docs/graph-editor docs/pdf-to-svg docs/コメント規約.md` の列挙から、次の**除外パターン**に掛かるものを除いて行う:
```
package.json  tsconfig.json  vitest.config.js  vitest.config.ts  playwright.config.ts
*.test.ts  *.e2e.ts  *.test.js  editor_server.mjs
graph-editor/scripts/build.ps1  graph-editor/scripts/build.bat
pdf-to-svg/scripts/build.ps1    pdf-to-svg/scripts/build.bat
```
(`*.test.js` の該当は pdf-to-svg の旧 vitest 2 件のみ — `resources/web` の製品 JS は
`.test.js` で終わらないことを実査済み。Python テスト・conftest・harness・
`test/fixtures/`・`packaging/pdftosvg.spec` は ls-files 経由で全部入る)
追加コピー(git 管理外の実体):
- `docs/_build/vendor/` の JS 2 件(mermaid.min.js / mermaid-layout-elk.min.js —
  ignore されるがワーキングコピーとして必要。T5 の publish が bundle へ同梱する源)
- `python-wheelhouse/`(cp313 済み・一時。コミットされない)
さらに monorepo の対応表 2 枚を
`docs/plans/2026-08-28-phase2-mapping-pdf-to-svg.md` / `...phase3-mapping-graph-editor.md`
へコピー(移植照合の一次知見を新リポから到達可能に)。

- [ ] **Step 3: .gitignore / .gitattributes を新設して初期コミット**

`.gitignore`:
```
__pycache__/
.venv*/
dist/
build/
out/
test-results/
coverage/
docs/_build/vendor/mermaid.min.js
docs/_build/vendor/mermaid-layout-elk.min.js
python-wheelhouse/
offline-deps-bundle.tar.gz*
bundle.key
*.key.pem
CLAUDE.md
.claude/
.mcp.json
```
(**vendor は丸ごと無視しない** — manifest.txt はコミットする)
`.gitattributes`:
```
scripts/hooks/* text eol=lf
*.js  text eol=lf
*.cjs text eol=lf
```
```powershell
git add -A
git commit -m "chore: monorepo からのスナップショット初期コミット(pdf-to-svg + graph-editor + docs)

snapshot 元: koichi-araki-0801/workspace@<SNAP_SHA>"
git push -u origin main
```
コミット後 `git ls-files | Select-String "coverage|test-results|\.ps1$|\.test\.|e2e\.ts|\.mjs$"` が
**vendor manifest 以外 0 件**であることを確認。

- [ ] **Step 4: 移送の健全性確認**

```powershell
py -3.13 -m pytest pdf-to-svg -q       # 285 passed
py -3.13 -m pytest graph-editor -q     # 190 passed(フェーズ 3 fixwave 後の実測値)
py -3.13 -m pytest docs/_build -q      # 12 passed
py -3.13 -m pytest pdf-to-svg -m e2e -q     # 4 passed
py -3.13 -m pytest graph-editor -m e2e -q   # 34 passed
py -3.13 -m pytest graph-editor -rs -q | Select-String -Pattern "SKIP"
```
Expected: 全緑(依存は端末グローバルに導入済み — フェーズ 1-3 実証)。最後の SKIP 列挙に
**parallel_impl_drift 由来の行が無い** = drift 検査が実行されている(spec §3)。

- [ ] **Step 5: 最小 README(概要・必要環境・セットアップは T2 で拡充)をコミット + push**

---

### Task 2: setup_dev.py + pre-commit hook + check-comments.py

**Files(新リポ):**
- Create: `setup-dev.bat`(ASCII ランチャ)+ `scripts/setup_dev.py`
- Create: `scripts/check_comments.py`
- Create: `scripts/hooks/pre-commit`(sh シム)+ `scripts/hooks/pre_commit.py`
- Modify: `README.md`

**Interfaces:**
- Produces:
  - `setup_dev.py`: ①`py -3.13`・Edge の存在確認 ②**`python-wheelhouse/` が無ければ
    「先に offline\setup-offline.bat を実行してください」と表示して失敗**(既定は
    fail-closed — 配布ストーリーの証明性を守る。オンライン導入は `--online` 明示
    オプションのみ) ③導入前に **check_requirements で全 requirements を検査**(T3 で
    実装 — T2 時点は TODO フックのみ置き、T3 が配線する) ④requirements **6 本**
    (docs/_build + 両 requirements + 両 dev-requirements + `offline/dev-requirements.txt`
    〈T4 で新設 — T2 時点は「存在すれば含める」動的列挙で先回り〉)を
    `pip install --no-index --find-links python-wheelhouse` ⑤`git config
    core.hooksPath scripts/hooks` ⑥サマリ表示。
    requirements の列挙は `git ls-files -- '*requirements.txt'`(content-key と同一集合 —
    ハードコードしない)。
  - `check_comments.py`: monorepo `scripts/check-comments.mjs` の移植。**「同一実装 +
    リポ別設定」の形**(spec §8 — フェーズ 5 で monorepo 側もこれへ差し替える前提):
    検査ロジック(§3 ps1 comment-based help / §4 装飾ボックス / §5 所見番号 /
    .bat 併設)は全ルール族を実装し、**冒頭の設定辞書**でリポ別に有効化・対象 dir・
    例外表を指定する。python-tools 用設定 = 対象 dir(全体)・§3/.bat 併設族は
    「.ps1 が存在したらエラー」モード・例外表は空。

- [ ] **Step 1: check_comments.py を移植(RED→GREEN)** — 移送ツリー全体で 0 error /
  意図的違反(scratchpad)で非 0。設定辞書の形をコメントで説明。
- [ ] **Step 2: setup_dev.py + pre-commit(staged ファイルへ check_comments)**
- [ ] **Step 3: 検証** — wheelhouse あり(T1 で一時コピー済み)で `.\setup-dev.bat` 完走 /
  hooksPath 設定確認 / pre-commit の拒否→修正→成功を確認
- [ ] **Step 4: コミット + push**

---

### Task 3: check_requirements + build_venv + build.py 2 本 + shot.py の Edge 化

**Files(新リポ):**
- Create: `scripts/check_requirements.py` + `scripts/check-requirements.bat`(**旧名維持** —
  `docs/_build/build_all.bat:7` が `-Path <file>` 形式で呼ぶため、argparse で
  **`-Path` を明示定義**して互換を保つ)
- Create: `scripts/lib/build_venv.py`
- Create: `graph-editor/scripts/build.py` + `build.bat` / `pdf-to-svg/scripts/build.py` +
  `build.bat`
- Modify: `scripts/setup_dev.py`(check_requirements の配線)
- Modify: `docs/_build/shot.py`(`p.chromium.launch()` → `launch(channel="msedge")` —
  spec §3/§6 の svg2png Edge 化。新リポはブラウザ DL 無し方針のため chromium 実体が
  無い)
- Create: `scripts/test_python_tools_scripts.py`(check_requirements ほか部品の単体)

**Interfaces:**
- Produces:
  - `check_requirements.py`: 「名前 + バージョン指定子」行のみ許可(monorepo
    `offline/lib/verify.ps1` の移植。テストベクタは Pester 版の受理/拒否ケースを逐語)。
    CLI は `-Path <file>`(build_all.bat 互換)と位置引数の両対応。
  - `build_venv.py(project_dir, wheelhouse)`: 隔離 venv 作成 → **check_requirements で
    検査してから** requirements.txt を `--no-index --find-links` で install。
    **wheelhouse 必須(無ければ失敗)** — monorepo 版のオンライン fallback からの
    **意図的変更**(オフライン成立性を隠さない。理由コメント)。
  - build.py: 旧 build.ps1 の手順を移植。**cwd をプロジェクトルートへ固定**
    (--add-data 相対の前提)。pdf-to-svg は `packaging/pdftosvg.spec` を呼ぶ形
    (引数の実体は spec ファイル側 — コピー済み)、graph-editor は ps1 直書きの
    PyInstaller 引数を逐語移植。

- [ ] **Step 1: check_requirements(RED→GREEN・Pester ベクタ移植)**
- [ ] **Step 2: build_venv + build.py 2 本 + setup_dev への配線**
- [ ] **Step 3: shot.py の Edge channel 化** — `py -3.13 -m pytest docs/_build -q` 緑 +
  `svg2png.py` の実行確認(対象 SVG 1 件で PNG が生成される)
- [ ] **Step 4: 検証** — `py -3.13 -m pytest scripts -q` / 両 `build.bat` が exe 生成まで
  完走(wheelhouse は T1 の一時コピー) / `docs\_build\build_all.bat` が check-requirements
  互換で完走(docs HTML 生成)
- [ ] **Step 5: コミット + push**

---

### Task 4: offline publish の Python 版 + Ed25519 署名

**Files(新リポ):**
- Create: `offline/publish_bundle.py` + `offline/publish-bundle.bat`
- Create: `offline/new_signing_key.py`
- Create: `offline/lib/bundle_common.py`(content-key 2 経路 / pin 読み書き / 署名生成・
  検証 / bundle.key)
- Create: `offline/dev-requirements.txt`(`cryptography==<実装時に pip index versions で
  解決した最新安定>` 1 行)
- Modify: `scripts/test_python_tools_scripts.py`(部品単体 + **pip 入口列挙ガード**)

**Interfaces(publish の契約):**
- content-key = Global Constraints の定義(git 経路 / FS 経路の同一集合を単体テストで固定)。
- 重量物 = `python-wheelhouse/`(全 `*requirements.txt` を
  `pip download --python-version 3.13 --only-binary=:all:` — **実行前に
  check_requirements で全ファイル検査**)+ `docs/_build/vendor/`(JS 2 件 + manifest)。
  tar = `tar -czf offline-deps-bundle.tar.gz python-wheelhouse docs/_build/vendor`。
- 署名 = Ed25519(cryptography)。秘密鍵
  `%USERPROFILE%\.python-tools-signing\bundle-signing.key.pem`(new_signing_key.py が
  生成・既存あれば拒否)。公開鍵 `offline/bundle-signing.pub.pem`(コミット)。
  `.sig` = 64 byte 署名の base64。**publish は公開鍵ファイルが無ければ失敗**(spec §8)。
- Release(rolling tag `offline-bundle-v1`)のアセット = **tar.gz / .sig / .sha256 /
  bundle.key** の 4 点。**初回は「タグ作成 → `gh release create` → upload」、以後は
  「アセット `--clobber` 差し替え → タグ移動」の順**(中断しても旧が生きる —
  monorepo と同型)。**publish は HEAD が push 済みであることを事前確認**(codeload は
  GitHub 上のコミットしか返さない)。
- pin 生成 = 一時 Public 化の自動化(Architecture 節の仕様: visibility 事前確認 /
  `--accept-visibility-change-consequences` / finally 復帰 + 失敗時の手動導線表示)。
  書式は monorepo 踏襲(source-commit / source-zip-sha256 / bundle-sha256)。
- `--tag-only`: Release の bundle.key を取得して現 content-key と比較 — 一致時のみ
  タグ移動・不一致は何もせず exit 0。`--force` = 一致でも再生成。
- **pip 入口列挙ガード**(単体テスト): リポ内で `pip install` / `pip download` を呼ぶ
  ファイルを走査し、既知の入口集合 {setup_dev.py, build_venv.py, publish_bundle.py,
  ci.yml} と一致すること + 各入口に check_requirements 呼び出しが存在することを検査。

- [ ] **Step 1: bundle_common を TDD で実装**(content-key 2 経路一致 / pin round-trip /
  署名 生成→検証→改竄検出)
- [ ] **Step 2: new_signing_key.py + publish_bundle.py 実装 + 入口ガードテスト**
- [ ] **Step 3: 鍵ペア生成 → 公開鍵 + dev-requirements をコミット**(publish 実行は T5)
- [ ] **Step 4: コミット + push**

---

### Task 5: offline setup の Python 版 + 初回 publish + 配布検証

**Files(新リポ):**
- Create: `offline/setup_offline.py` + `offline/setup-offline.bat`
- Create: `offline/README-offline.md`(一時 Public 化運用・**中断時の visibility 確認**・
  pin/公開鍵の手渡し・検証連鎖・残余リスク。丁寧な日本語)

**Interfaces(setup の契約 — ブートストラップ順序が核心):**
1. pin 読込(無ければ即死)・公開鍵存在確認(無ければ即死)
2. Release から tar.gz / .sig を取得(gh CLI 認証。無認証環境は一時 Public 窓 —
   README に手順)
3. **pin の bundle-sha256 と実ファイルの hashlib 検証**(不一致は即死 — 主アンカー)
4. 展開(python-wheelhouse / docs/_build/vendor)
5. **wheelhouse から cryptography を `--no-index` で導入**(check_requirements 検査後)
6. **Ed25519 署名検証**(失敗なら展開物を削除して非 0 終了 — 多層防御)
7. source zip の sha256 検証(pin の source-zip-sha256)→ 完了サマリ

- [ ] **Step 1: setup_offline.py 実装**(検証部品は bundle_common 共用)
- [ ] **Step 2: 初回 publish(コントローラへ 1 行報告後)**:
  `py -3.13 offline\publish_bundle.py --force` → pin をコミット + push。
  実測記録へ: bundle サイズ・所要・Public 窓の実時間。
- [ ] **Step 3: 配布検証** — `%TEMP%` の新規 clone で
  `.\offline\setup-offline.bat` → `.\setup-dev.bat` → `py -3.13 -m pytest pdf-to-svg -q`。
  改竄検出(tar 1 byte 変更で中止)と、**手順 3(sha256)が cryptography 導入前に走る**ことを
  ログで確認。
- [ ] **Step 4: README-offline.md → コミット + push**

---

### Task 6: hooks 残り 2 本 + GH Actions + CLAUDE.md

**Files(新リポ):**
- Create: `scripts/hooks/pre-push` + `pre_push.py`
- Create: `scripts/hooks/post-commit` + `post_commit.py`
- Create: `.github/workflows/ci.yml`
- Create(ローカル・コミットしない): `CLAUDE.md`

**Interfaces:**
- `pre_push.py`: **タグのみの push は CI をスキップ**(stdin の ref 列を読む —
  monorepo `scripts/pre-push.mjs` と同型。無いとタグ push が毎回フルテストを発火し
  フレークでタグ移動が中断する既知の実害)。ブランチ push では
  `pytest scripts` → `pytest docs/_build` → `pytest pdf-to-svg` → `pytest graph-editor` →
  `-m e2e` 2 種、を順に実行。**所要を実測して記録**(想定 2-4 分。post-commit の
  auto-push 経由で毎コミット同期的に走る連鎖を README に明記。重すぎる実測なら
  E2E を pre-push から外し明示実行化する判断分岐 — 実測記録へ)。
- `post_commit.py`: auto-push(force しない・失敗は警告のみ)+
  `publish_bundle.py --tag-only` のベストエフォート。
- `ci.yml`: ubuntu / Python 3.13 / `git ls-files -- '*requirements.txt'` 相当の全 6 本を
  pip install(check_requirements 検査後)/ `python -m playwright install --with-deps
  msedge` / `pytest scripts` + 個別 3 発(既定収集 = browser 込み・e2e は addopts 除外)。
- `CLAUDE.md`(ローカル): 設計正典 import 2 本(docs/graph-editor・docs/pdf-to-svg の
  src/設計正典.md)/ Git 運用(main 直・auto-push)/ docs・規約・道具複製の monorepo との
  相互反映ルール / Python 第一・.bat ランチャ規約 / **pytest へ xdist・randomly を
  入れない**(カバレッジゲートの zzz 順序依存)/ code-review-graph 不使用。

- [ ] **Step 1: hooks 実装 + 発火確認**(pre-push が赤テストで push を止める・タグのみ
  push はスキップされる — `git push origin <tag>` で確認)
- [ ] **Step 2: ci.yml 追加 → コミット + push → `gh run list`/`gh run view` で結果確認**
  (msedge 導入の初実測 — 赤なら `-m "not browser"` 退避を適用し実測記録へ)
- [ ] **Step 3: CLAUDE.md ローカル作成**

---

### Task 7: フェーズ 4 完了ゲート(クリーン検証)+ 凍結確認 + マスター更新

**Files(monorepo):** マスター計画 + 本計画末尾の実測記録

- [x] **Step 1: クリーン検証の通し(spec §9 step3 判定・順序が重要)**

`%TEMP%` の新規 clone(wheelhouse も vendor JS も無い状態)で:
```powershell
.\offline\setup-offline.bat        # pin(hashlib)→展開→cryptography 導入→署名検証 の連鎖
.\setup-dev.bat                    # wheelhouse --no-index で 6 requirements 導入 + hooksPath
py -3.13 -m pytest scripts -q
py -3.13 -m pytest docs/_build -q
py -3.13 -m pytest pdf-to-svg -q ; py -3.13 -m pytest pdf-to-svg -m e2e -q
py -3.13 -m pytest graph-editor -q ; py -3.13 -m pytest graph-editor -m e2e -q
py -3.13 -m pytest graph-editor -rs -q | Select-String "SKIP"   # drift の skip 行が無いこと
.\pdf-to-svg\scripts\build.bat ; .\graph-editor\scripts\build.bat
py -3.13 docs\_build\build_all.py
```
Expected: すべて green / 両 exe 生成 / docs HTML 生成(vendor は setup-offline が展開済み)。
**これがフェーズ 4 完了ゲート**(spec の「setup-offline 新リポ版が pin 検証込みで完走」を
含む)。

- [x] **Step 2: 凍結確認(SHA 起点)**

monorepo で: `git log <SNAP_SHA>..HEAD -- graph-editor pdf-to-svg docs/graph-editor
docs/pdf-to-svg docs/_build "docs/コメント規約.md"` が空 + `git status` で分離対象に
未コミット変更が無い(CI 再撮影スクショの docs/editor 分は対象外)。

- [x] **Step 3: マスター計画のフェーズ 4 行を「完了」へ + 実測記録記入 + monorepo コミット**

---

## 実測記録(実行時に追記)

- snapshot 元 SHA・コピー/除外件数: snapshot 元 `koichi-araki-0801/workspace@2be0346`
  (SNAP_SHA = `2be0346bd97d2a0a51f34318f1c809eb6a7348c9`)。`git ls-files` 基準 192 件中
  166 件コピー・26 件を除外パターン一致で除外(`package.json` ×2 / `tsconfig.json` ×1 /
  `vitest.config.{js,ts}` ×2 / `playwright.config.ts` ×2 / `*.test.ts` ×3 /
  `*.e2e.ts` ×4 / `*.test.js` ×2 / `editor_server.mjs` ×1 / `build.{ps1,bat}` ×4)。
  追加で git 管理外の working copy 実体(vendor JS 2 件・wheelhouse 一式・移植対応表 2 件)
  をコピー。(T1)
- check_comments.py の移送ツリー検査結果: `py -3.13 scripts/check_comments.py` で
  走査 178 files・0 error・1 warning(`graph-editor/resources/web/lib/leader_geom.cjs`
  の装飾ボックスヘッダ欠落。exit 0 に影響しない警告のみ、監査対象外として残置)。
  pre-commit の拒否→修正→成功も実機確認済み。(T2)
- cryptography の固定版: `cryptography==50.0.1`(T4)
- 初回 publish: bundle サイズ 約74MB(`offline-deps-bundle.tar.gz` 77,622,542 bytes)・
  所要 約26秒(`publish_bundle.py --force`)・Public 窓の実時間 数秒程度
  (visibility変更 約1秒 + source zip約22MB取得 約1.5秒 + private復帰 約1秒。
  復帰確認済み)。(T5)
- pre-push の所要実測(E2E 込み)と判断: 実 push 4 回計測で **99.6〜101.5 秒**
  (scripts→docs/_build→pdf-to-svg→graph-editor→両 `-m e2e` の順)。E2E を pre-push
  から外す退避は不要と判断し README に判断分岐込みで記載。タグのみ push は pytest を
  スキップして約2秒で通ることも実機確認済み。(T6)
- GH Actions の msedge 導入可否(初実測): 導入可(ubuntu-latest・
  `playwright install --with-deps msedge`)。msedge 導入自体は初回から一貫して成功。
  初回2回(`33232187246`/`33232298457`)は msedge と無関係な既存バグ2件で failure、
  修正後の3回目(`33232448530`)で `verify` ジョブ **2m7s** green。fix round 1
  (`261eb69`)反映後の最終 green は run `33233104804`(同 2m7s)。
  `-m "not browser"` 退避は不要と判断し未適用。(T6)
- クリーン検証の結果一覧(2026-08-29・`%TEMP%\python-tools-clean-verify` への新規
  clone、wheelhouse/vendor 無し状態から実行。検証後は clone を削除済み):
  - `offline\setup-offline.bat`: green(exit 0。pin 読込→bundle 取得→sha256(hashlib)
    照合 OK→展開→cryptography 導入→Ed25519 署名検証 OK の 7/7 段すべて成功。
    wheelhouse 27 ファイル・vendor JS 2 件を展開確認)
  - `setup-dev.bat`: green(exit 0。requirements 6 件を `--no-index` 導入・
    `git config core.hooksPath scripts/hooks` 設定)
  - `pytest scripts -q`: green(137 passed)
  - `pytest docs/_build -q`: green(12 passed)
  - `pytest pdf-to-svg -q`: green(285 passed, 4 deselected)
  - `pytest pdf-to-svg -m e2e -q`: green(4 passed, 285 deselected)
  - `pytest graph-editor -q`: green(190 passed, 34 deselected)
  - `pytest graph-editor -m e2e -q`: green(34 passed, 190 deselected)
  - `pytest graph-editor -rs -q | Select-String "SKIP"`: green(SKIP 行 0 件 = drift
    検査が非 SKIP で完走)
  - `pdf-to-svg\scripts\build.bat`: green(exit 0。`dist\PdfToSvg\PdfToSvg.exe` 生成確認)
  - `graph-editor\scripts\build.bat`: green(exit 0。`dist\LabelEditor.exe` 生成確認、
    単一ファイル ~10MB)
  - `py -3.13 docs\_build\build_all.py`: green(exit 0。HTML 4 件生成:
    graph-editor 手引き/設計・pdf-to-svg 手引き/設計)
  - 総括: 全項目 green。フェーズ 4 完了ゲート(spec §9 step3)達成。(T7)
- 凍結確認(Step 2・monorepo): `git log 2be0346bd97d2a0a51f34318f1c809eb6a7348c9..HEAD
  -- graph-editor pdf-to-svg docs/graph-editor docs/pdf-to-svg docs/_build
  "docs/コメント規約.md"` は空(分離対象への新規コミット無し)。`git status --short` の
  未コミット変更は `docs/editor/images/*.png`(CI 再撮影分・対象外)と
  `docs/superpowers/plans/*` 等の無関係な untracked ファイルのみで、分離対象パスへの
  未コミット変更は無し。凍結条件を満たすことを確認。
- 想定外の差異: 無し(clean clone 検証・凍結確認とも brief の期待どおりの結果)。
- 想定外の差異: (発生時)
