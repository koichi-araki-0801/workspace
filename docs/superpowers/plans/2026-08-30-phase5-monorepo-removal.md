# フェーズ 5: monorepo 除去 + Node 依存更新 + 履歴初期化 + 後始末 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** monorepo から pdf-to-svg / graph-editor を完全除去し、Node 依存を安定版へ更新し、
monorepo の GitHub 履歴を新規スタートへ初期化して、リポ分離プロジェクトを完了する。

**Architecture:** spec §7 の除去チェックリスト 14 項目を「配線除去 → 道具一本化 →
offline/docs 追随 → 参照掃討」の 4 コミット群で実行し、Node 依存更新(§8.5)を独立
コミット群として分離する。履歴初期化(§5)は「bundle アーカイブ → orphan 初期コミット
(update-ref)→ force push + タグ移動 → 直後の明示 publish → setup 検証」の順序を
必須ゲートとして直列実行する。python-tools 側の変更は成果 HTML への刻印(§6)と
check_comments の workspace 設定追加の 2 点のみ。

**Tech Stack:** pnpm / vitest / PowerShell(offline 系は温存・最小差分) / Python 3.13
(check-comments 一本化) / git bundle / git commit-tree + update-ref(orphan 初期コミット)

**Spec:** `docs/superpowers/specs/2026-08-27-python-repo-split-design.md`(v3.6。
§5 履歴初期化・§6 docs・§7 除去チェックリスト・§8.5 依存安定化・§9 段取り step5-8)

**レビュー反映:** 本計画 v2 は敵対的レビュー 3 視点(除去完全性 / 履歴初期化安全性 /
整合・実行可能性)の所見を反映済み。主な変更: docs/_build の pytest 供給
(dev-requirements 新設)・pnpm-lock 再生成・`docs/pdf-to-svg/_build/` と
`scripts/lib/build-python-venv.ps1` の削除追加・ci.yml の check:comments 段順修正・
`git update-ref` 化・BOM なしメッセージ書き出し・タグ移動の前倒し・stash は
patch 保全 + bundle 後 drop(適用しない既定)・publish pin 段の gho 拒否復旧手順。

## Global Constraints

- 作業ブランチは常設 `chore/deps-latest-offline-bundle`(spec §7)。worktree は使わない
  (履歴初期化が branch ref そのものを付け替えるため)。
- コミットは「除去」群 →「Node 依存更新」群に分割(spec §7)。重量物の明示 publish は
  履歴初期化直後の 1 回だけ(spec §8.5 / §9 step7)。
- monorepo のコミットメッセージ・コメントは丁寧な日本語 + 既存規約。コミット末尾に
  Claude-Session: https://claude.ai/code/session_01C8TAKZaatEcrSTKzR6W9q3
- python-tools 側の変更(Task 1・Task 3)はどちらも **requirements /
  `docs/_build/vendor/manifest.txt` を触らない**(content-key 不変 = publish 不要)。
- Python は常に `py -3.13` 明示(ローカル)。CI(ubuntu)は裸の `python`。
  pytest はプロジェクト個別実行(一括禁止)。
- **monorepo の push はデタッチパターンが既定**(Task 2/3/4/5/6/8): ルート `package.json` /
  `README.md` は ci-affected の BENIGN 対象外でフル CI(11〜17 分)へ倒れ、auto-push
  フック(timeout 180 秒)は必ず kill される。よって各コミット後は
  `Start-Process` デタッチで `git push` を起動し、ログ + `git ls-remote` で成否確認する
  (確立済みパターン)。auto-push の失敗表示は既知として無視してよい。
- `--no-verify` は使わない(spec §5.4)。
- 検証の基幹コマンド: `pnpm run ci`。pnpm 実行前に PATH 再構成が必要な場合:
  `$env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')`
- 旧履歴の参照はフェーズ完了後も bundle 経由で可能にする(spec §5.2。保管先 =
  `%USERPROFILE%\repo-archives\`。署名鍵と同じくユーザープロファイル配下・リポ外)。
- **bundle 作成(Task 7)から orphan 初期コミット作成(Task 8 Step 2)までの間、
  新規コミット禁止**(作るとアーカイブから漏れる)。初期化後のコミット(pin 更新・
  Task 9)は新履歴の通常コミットであり問題ない。

---

## 事前状態(2026-08-29 実測)

- monorepo: ローカル HEAD = `76ccd16`(= origin/chore/deps-latest-offline-bundle)。
  origin refs = `main`(6e38091)/ 常設ブランチ / タグ `offline-bundle-v1`(remote は
  76ccd16、**ローカルは 47cabed で古い** — Task 7 で `git fetch --tags` 必須)の 3 本のみ
  (refs/pull 61 本は残存許容)。ローカル `main` は origin/main より 16 behind。
- 未コミット: `docs/editor/images/` スクショ 3 枚(CI 再撮影ゆらぎ。Task 5 で同乗)。
- untracked: `gist1.md` / `gist2.md`(文章規範スキル原稿 — リポ外の個人資産)、
  `docs/superpowers/plans/` の過去バグ修正記録 3 本。
- stash: 1 本(`stash@{0}`、base=4fb40e4 = **HEAD より 246 コミット前**。実測で
  editor 50 + docs 6 + vitest.config.ts 1 = 57 ファイル。**graph-editor / pdf-to-svg の
  ファイルはゼロ**。vitest.config.ts hunk は Task 2 の編集と衝突する)。
- python-tools: HEAD = `09001ac`(main・CI green)。`REPO_CONFIGS` は `python-tools`
  キーのみ。
- **docs/_build の pytest はよそから借りている**: `docs/_build/requirements.txt` は
  markdown-it-py / python-frontmatter のみで pytest 非宣言。現状は ci.yml:63 が
  pdf-to-svg / graph-editor の dev-requirements(pytest==9.1.1)を入れる副作用で
  動いている — 除去すると枯渇する(Task 2 で手当て)。
- ci.yml のジョブ順: check:comments(:46)が Setup Python(:57-60)より**前**
  (Task 3 で段移動が必要)。トリガは `push: branches:[main]` + `pull_request` のみ =
  常設ブランチへの push では走らない(改修の初実行は Task 8 の main force push)。
- 二重テスト期間の配線(除去対象の実名): package.json の `test:pdf-to-svg` /
  `test:graph-editor:py` / `test:pdf-to-svg:js` / `e2e:pdf-to-svg` / `e2e:pdf-to-svg:py` /
  `e2e:graph-editor` / `e2e:graph-editor:py` / `test:graph-editor` /
  `typecheck:graph-editor` / `ci:graph-editor` / `ci:pdf-to-svg` / `ci` チェーン内 7 段 /
  `typecheck` の `--filter graph-editor`。

---

### Task 1: python-tools — 成果 HTML への正典刻印 + HTML 再生成

**Files(python-tools):**
- Modify: `docs/_build/md2html.py`(刻印追加。**既存のフッタ要素は無い** —
  `_page()` の `</body>` 直前へ新設する)
- Modify: `docs/_build/test_md2html.py`(刻印の存在テスト)
- 生成: `docs/graph-editor/*.html` / `docs/pdf-to-svg/*.html`(4 冊:
  `graph-editor_手引き.html` / `graph-editor_設計.html` / `pdf-to-svg_手引き.html` /
  `pdf-to-svg_設計.html`)

**Interfaces:**
- Produces: 刻印入り成果 HTML 4 件。Task 4 が monorepo `docs/{graph-editor,pdf-to-svg}/`
  へ複製する。刻印文言(固定):
  `この文書の正典は python-tools リポジトリ(docs/<proj>/src/)です。生成日: YYYY-MM-DD`

- [ ] **Step 1: 刻印テストを書く(RED)** — `test_md2html.py` へ「生成 HTML の末尾に
  `この文書の正典は python-tools リポジトリ` と `生成日:` が含まれる」テストを追加し、
  `py -3.13 -m pytest docs/_build -q` で FAIL を確認。
- [ ] **Step 2: md2html.py へ刻印を実装(GREEN)** — `_page()` の `</body>` 直前へ
  1 行追加。生成日は build 実行日(`datetime.date.today()`)。スタイルは既存 MUTED
  トークン準拠の小さな 1 行(新色・新フォント禁止)。
- [ ] **Step 3: `py -3.13 docs\_build\build_all.py` で 4 冊再生成** — 各 HTML 末尾に
  刻印が入っていることを確認。
- [ ] **Step 4: `py -3.13 -m pytest docs/_build -q` 緑 + `py -3.13 scripts/check_comments.py`
  エラー 0 → コミット + push**(python-tools。requirements / vendor manifest 非変更 =
  content-key 不変を `git status` で確認。post-commit の --tag-only はタグ追随のみで無害)。

---

### Task 2: monorepo 除去(コード配線)— §7 項目 0-4・6・8

**Files(monorepo):**
- Delete: `graph-editor/` / `pdf-to-svg/` ディレクトリ本体
- Delete: `docs/pdf-to-svg/_build/`(capture_screens.py + .bat — 中身が
  `pdf-to-svg/src` を import する取り残し複製。python-tools 側に正しい位置で存在済み)
- Delete: `scripts/lib/build-python-venv.ps1`(呼び出し元は両 build.ps1 のみ =
  除去で孤児化)
- Create: `docs/_build/dev-requirements.txt`(`pytest==9.1.1` 1 行 + 理由コメント。
  現状 docs/_build の pytest は pdf-to-svg / graph-editor の dev-requirements の
  副作用で入っており、除去で枯渇するため)
- Modify: `package.json`(「事前状態」の除去対象 script 全部 + `ci` チェーン 7 段 +
  `typecheck` の `--filter graph-editor`)
- Modify: `vitest.config.ts`(projects の `graph-editor/vitest.config.ts`:16 +
  coverage include の `leader_geom.cjs`:188 / `svg-policy.js`:190)
- Modify: `scripts/ci-affected.mjs`(`graph-editor` / `pdf-to-svg` 領域 :40-65 +
  BENIGN 除外コメント :88)+ `scripts/ci-affected.test.mjs` の該当ケース
- Modify: `scripts/clean.mjs`(:58, :73-75)+ `scripts/clean.test.mjs` の対象列挙
- Modify: `pnpm-workspace.yaml`(:6-7)+ `knip.json`(:15 の graph-editor workspace)
- Modify: `pnpm-lock.yaml`(`pnpm install` による importer 2 件の除去反映 —
  忘れると Task 8 Step 4 の publish が `ERR_PNPM_OUTDATED_LOCKFILE` で死ぬ。
  ローカル `ci` チェーンに install 段が無いため他では検知されない)
- Modify: `.github/workflows/ci.yml`(:63 pip install →
  `docs/_build/requirements.txt` + `docs/_build/dev-requirements.txt` の 2 本・
  :74-78 pytest 段 → `python -m pytest docs/_build` のみ・
  **`Install Edge for browser-marked tests` 段〈:65-66・python playwright の msedge 導入〉を
  除去**。docs/_build のテストは playwright を実行時 import しない — 裏取り済み。
  ⚠ :83-84 の `Install Playwright browsers`〈pnpm 側・editor E2E 用〉は**別物で残す**)

**Interfaces:**
- Produces: 除去後も `pnpm run ci` が全緑で通る配線。Task 3 以降はこの状態を前提。
  `docs/_build/dev-requirements.txt` は offline publish のグロブ走査
  (`Get-OfflineRequirementsFiles`)へ自動追随し Task 8 の publish で wheelhouse に入る。

- [ ] **Step 1: 対象を `git rm -r` で削除**(graph-editor / pdf-to-svg /
  docs/pdf-to-svg/_build / scripts/lib/build-python-venv.ps1)。
- [ ] **Step 2: `docs/_build/dev-requirements.txt` 新設 + 配線 8 ファイルを行指定
  どおり修正**。`ci` チェーンは pdf-to-svg / graph-editor 系 7 段を抜いた形へ。
  `test:docs` は残す。
- [ ] **Step 3: `pnpm install` で pnpm-lock.yaml を再生成**し、importer から
  graph-editor / pdf-to-svg が消えたことを確認して lock をステージへ含める。
- [ ] **Step 4: `pnpm run test:scripts` 緑**(ci-affected.test.mjs / clean.test.mjs の
  追随漏れはここで赤くなる)。
- [ ] **Step 5: pytest 供給の独立確認** — 一時 venv(または
  `py -3.13 -m pip download -r docs/_build/requirements.txt -r docs/_build/dev-requirements.txt --dry-run`
  相当)で、docs/_build の 2 requirements だけで pytest が解決できることを確認。
- [ ] **Step 6: `pnpm run ci` 全緑**(check:comments はこの時点ではまだ mjs)。
- [ ] **Step 7: コミット**(除去群 1/4)→ デタッチ push + `git ls-remote` 確認。

---

### Task 3: check-comments の Python 一本化(mjs 廃止)— §7 項目 5

**Files:**
- Modify(python-tools): `scripts/check_comments.py`(`REPO_CONFIGS` へ `"workspace"`
  キー追加)
- Create(monorepo): `scripts/check-comments.py`(python-tools 版の複製。差分は
  `ACTIVE_REPO = "workspace"` の 1 行のみ)
- Delete(monorepo): `scripts/check-comments.mjs`
- Modify(monorepo): `package.json` の `check:comments` →
  `py -3.13 scripts/check-comments.py`(Windows ローカル用)
- Modify(monorepo): `.github/workflows/ci.yml` — **Comment convention check 段を
  Setup Python 段の後ろへ移動**し、`python scripts/check-comments.py` を
  直接呼ぶ(`pnpm run check:comments` 経由だと ubuntu に `py` が無く落ちる。
  現順序のままでは Python 未導入段階で走って落ちる — どちらも段移動が必須。
  ⚠ 行番号 :46 / :57-60 は Task 2 の ci.yml 編集でずれる — **ステップ名で特定する**)

**Interfaces:**
- Consumes: python-tools の `REPO_CONFIGS` 機構。
- Produces: 両リポで同一実装・設定差分 2 行の検査器。「改善を入れた側が他方へ反映する」
  運用(spec §6)の対象。

**workspace 設定の移植対応表**(mjs の現物から。フィールド名は python 版):
- `ps1_mode = "check"`(BOM + `.bat` 併存検査。monorepo は `.ps1` 現役)
- `bat_pairing_exceptions`: mjs :63 の `BAT_PAIRING_EXCEPTIONS` から移植。ただし
  **`scripts/lib/build-python-venv.ps1` のエントリは Task 2 で実体を削除済みのため
  移植しない**
- `finding_id_skip_prefixes = ("docs/_samples/",)`(PDF 抽出プレーンテキストサンプル)
- `skip_dir_names` / `skip_dir_prefixes`: mjs の `isSkipDir` から移植。
  **`CLAUDE-SECURITY-` の前方一致は `skip_dir_prefixes` へ**(名指し必須 —
  検出パリティ確認は現状違反 0 件同士の一致ですり抜けるため、設定値の突き合わせで守る)
- `shell_shim_prefixes = (".husky/",)`(mjs :273 の `isHusky` ハードコードの翻訳。
  拡張子なしファイルを sh 扱いで所見番号検査する対象)
- `ps1_skip_dir_names` / `ps1_skip_dir_prefixes`: **必ず定義する**(check_comments.py が
  無条件参照するため未定義は KeyError)。mjs の `.ps1` 走査除外(node_modules 等)から移植
- `box_header_roots`: mjs から移植。ただし削除済みの
  `graph-editor/resources/web/js`・`pdf-to-svg/resources/web` は**移植しない**
- `docs_src_pattern`: mjs の対象パス正規表現から移植

- [ ] **Step 1(python-tools): `"workspace"` 設定を追加** — 上記対応表どおり。
  `ACTIVE_REPO` は `"python-tools"` のまま。単体テストへ「workspace キーが存在し
  必須フィールドを持つ」検査を追加。`py -3.13 -m pytest scripts -q` 緑 →
  コミット + push。
- [ ] **Step 2(monorepo): 複製 + 差し替え** — `scripts/check-comments.py` を配置し
  `ACTIVE_REPO = "workspace"` へ変更。mjs を削除。package.json / ci.yml(段移動込み)を
  変更。
- [ ] **Step 3: 検出パリティ確認** — 差し替え前に mjs の出力(エラー/警告件数と対象)を
  記録し、Python 版が同一結果を返すことを確認。**加えて設定値レベルで mjs の各定数と
  workspace 設定を 1:1 突き合わせた対応表をレポートへ**(違反 0 件同士の一致は
  パリティの証明にならないため)。
- [ ] **Step 4: `pnpm run ci` 全緑 → コミット**(除去群 2/4)→ デタッチ push。

---

### Task 4: offline スクリプト追随 + docs 原稿削除 + 刻印 HTML 複製 — §7 項目 7・10

**Files(monorepo):**
- Modify: `offline/publish-offline-bundle.ps1`(workspace ループ・python-wheelhouse の
  pdf-to-svg / graph-editor 該当分の明示列挙部。requirements グロブ走査部は削除に
  自動追随)
- Modify: `offline/setup-offline.ps1` / `offline/setup-offline-local.ps1`(展開リスト)
- Modify: `offline/README-offline.txt`(対象一覧の記述)
- Delete: `docs/graph-editor/src/` + `docs/graph-editor/images/` /
  `docs/pdf-to-svg/src/` + `docs/pdf-to-svg/images/`
- Update: `docs/graph-editor/*.html` / `docs/pdf-to-svg/*.html` を Task 1 の刻印入り
  生成物で置換(成果 HTML のみ残置。base64 インライン自己完結のため images/ 不要。
  `build_all.py` は `src/` 自動検出なので原稿 dir が消えれば対象外)

**Interfaces:**
- Consumes: Task 1 の刻印入り HTML 4 件。

- [ ] **Step 1: offline 3 スクリプト + README-offline.txt の該当箇所を最小差分で除去**
  (PS のまま。`.ps1` の新規追加はしない)。
- [ ] **Step 2: `pnpm run ci:offline`(Pester)緑** — verify.Tests.ps1 の追随も確認。
- [ ] **Step 3: docs 原稿・images 削除 + 刻印 HTML 複製** — 複製後、HTML 末尾に刻印が
  あることを確認(`Select-String "正典は python-tools"`)。
- [ ] **Step 4: `py -3.13 docs\_build\build_all.py` を monorepo 側で実行** — editor /
  pie-chart の冊子だけが再生成され、graph-editor / pdf-to-svg が対象外になったことを
  出力ログで確認。
- [ ] **Step 5: `pnpm run ci` 全緑 → コミット**(除去群 3/4)→ デタッチ push。

---

### Task 5: 残存参照の掃討 + 保留スクショ同乗 — §7 項目 9・11・12

**Files(monorepo):**
- Modify: ルート `README.md`(入口スクリプト一覧・領域別 CI 説明 約 10 箇所。
  ⚠「フォント資産の対応」節〈:67-77〉は pdf-to-svg vs pie-chart の対比が前提のため
  参照置換でなく**節の書き直し**が要る)
- Modify: `tsconfig.base.json` コメント / `.vscode/settings.json`・`launch.json` /
  `editor/README.md`・`editor/OFFLINE.md` / `editor/server/src/app.ts:108`・
  `editor/server/src/config.ts:568` / `editor/web/src/assets/index.css:6` /
  `pie-chart/README.md`・`docs/pie-chart/src/設計書.md`・
  `pie-chart/test/output_escaping.test.ts` / `docs/コメント規約.md`(:16 対象・
  :133-134 テスト手順の現役扱い記述) / `docs/_build/shot.py`(docstring の
  capture_screens.py 呼び出し元記載 — Task 2 で実体削除済み)
- Modify(ローカル・コミット対象外): `CLAUDE.md` の
  `@docs/{graph-editor,pdf-to-svg}/src/設計正典.md` import 2 行を削除
- Commit: `docs/editor/images/` の保留スクショ 3 枚(再撮影として同乗)
- Commit: untracked の plans 3 本(過去バグ修正記録。docs/superpowers/plans の
  追跡慣行に従いコミット)

**Interfaces:**
- Produces: 残存参照の対象表(§7-12 + §9 step8 の集約)。全ヒットを
  「修正済み / 意図して残す(理由付き)」で分類し、Task 9 の完了判定が使う。

- [ ] **Step 1: `git grep -ln "graph-editor\|pdf-to-svg"` で全残存を列挙**し対象表を作る。
- [ ] **Step 2: 修正分を書き換え**(editor コメントは「分離先 python-tools リポジトリの
  pdf-to-svg」等、実態を指す文言へ)。
- [ ] **Step 3: biome 対象の先行整形** — `pie-chart/test/output_escaping.test.ts`・
  editor 配下の変更前に `pnpm exec biome check --write <対象>` を先行実行
  (lint-staged のステージ入れ替わり事故回避)。
- [ ] **Step 4: スクショ 3 枚 + plans 3 本を同一コミットに同乗**(メッセージで
  「CI 再撮影」「過去計画の記録追跡」を明記)。
- [ ] **Step 5: `pnpm run ci` 全緑 + 除去判定** — `git grep -l "graph-editor\|pdf-to-svg"`
  の残存が対象表の「意図済み」行のみ(spec §9 step5 判定)→ コミット(除去群 4/4)→
  デタッチ push。

---

### Task 6: Node 依存の安定版更新 — §8.5

**Files(monorepo):**
- Modify: `package.json` / `editor/*/package.json` / `pie-chart/package.json` /
  `pnpm-lock.yaml`(`pnpm up` の解決結果)

- [ ] **Step 1: `pnpm outdated -r` で更新候補を棚卸し** — メジャーアップ
  (実測候補: TypeScript 6→7・`@fastify/static` 8→10・msnodesqlv8 4→5・
  js-beautify 1→2 ほか)は breaking change を CHANGELOG で個別確認し、採否を
  レポートへ記録(見送りは理由 1 行)。⚠ Biome メジャーは CLAUDE.md「Biome 運用」の
  overrides 禁止・範囲限定の前提を必ず確認。msnodesqlv8 は native prebuild 同梱
  (offline バンドル)前提のため更新時は prebuild の再同梱可否も確認。
- [ ] **Step 2: `pnpm up`(採用分)→ `pnpm-lock.yaml` 固定**。
- [ ] **Step 3: `pnpm run ci` 全緑**(退行するメジャーは見送りへ格下げして再実行)。
- [ ] **Step 4: pie-chart byte 不変確認** — `pnpm run pie-chart:batch` →
  `pnpm run pie-chart:batch:diff` で `out/_baseline` と SHA256 全件一致。差分が出た
  更新は見送り(pie-chart の鉄則)。
- [ ] **Step 5: コミット**(Node 更新群。除去群と分離。複数コミット可)→ デタッチ push。

---

### Task 7: untracked の保全 + bundle アーカイブ + stash 処置 — §5.2 / §9 step6

**Files:**
- 保管先: `%USERPROFILE%\repo-archives\`(新設)
- 移動: `gist1.md` / `gist2.md` → 保管先(リポ外の個人資産。コミットしない)

⚠ 順序が本質: **bundle 作成(Step 3)は stash drop(Step 5)より前**。
`git bundle create --all` は `refs/stash` を含む(spec §5.2 の「stash ref を
アーカイブ」はこの順序でのみ成立する)。

- [ ] **Step 1: untracked の保全 + 作業ツリーのクリーン化** — gist 2 本を保管先へ移動。
  plans 3 本は Task 5 でコミット済みを確認(未了ならここでコミット)。
  **Task 6 までの pre-push フル CI で `docs/editor/images` のスクショが再 dirty 化して
  いる場合は、ここで「CI 再撮影」としてコミットする**(bundle 作成後はコミット禁止に
  なるため、クリーン化はこの Step で完了させる)。
- [ ] **Step 2: タグ・refs の同期** — `git fetch origin` + `git fetch --tags --force`
  (ローカルの `offline-bundle-v1` は 47cabed で古い)。棚卸しは `git ls-remote origin`
  基準で行い、結果(refs 3 本のみ)をレポートへ。
- [ ] **Step 3: bundle 作成** —
  `git bundle create %USERPROFILE%\repo-archives\workspace-history-2026-08.bundle --all`
  (全ブランチ・全タグ・stash ref)。**以後 Task 8 Step 2 の orphan 作成まで新規
  コミット禁止**。
- [ ] **Step 4: bundle 検証** — `%TEMP%` で bundle から `git clone` →
  `git log --oneline -5` 参照確認 → 一時 clone 削除。
- [ ] **Step 5: stash の処置(適用しない既定)** — stash@{0} は base が 246 コミット前の
  editor 系 WIP で、現ツリーは #61 精査画面改修を含む後続実装に追い越されている。
  さらに vitest.config.ts hunk は Task 2 の削除行を復活させうる。よって**適用せず**、
  `git stash show -p stash@{0} > %USERPROFILE%\repo-archives\stash-2026-08.patch` で
  平文保全(bundle 内の refs/stash と二重)→ `git stash drop`。stash list が空を確認。
  ※ 適用したい hunk が本当にあると判断した場合はコントローラへ escalate
  (bundle 後のコミット禁止期間と衝突するため、その場合は手順再編成が要る)。
- [ ] **Step 6: git 管理外実体の温存確認** — ローカル `CLAUDE.md`・`.claude/` フック・
  `docs/_build/vendor/`・`python-wheelhouse`・`offline/` の生成物が worktree に
  残っていることを確認列としてレポートへ。`git status --short` が空であることを確認。

---

### Task 8: monorepo 履歴初期化 + 明示 publish — §5.4 / §9 step7

**Interfaces:**
- Consumes: Task 7 の bundle(検証済み)。Task 2-6 の全コミットが push 済みで
  `pnpm run ci` 全緑。

- [ ] **Step 1: 前提確認** — `git status` クリーン / `git stash list` 空 /
  `git ls-remote origin chore/deps-latest-offline-bundle` = ローカル HEAD /
  直近の `pnpm run ci` 全緑 / bundle 存在。
  自動 publish を設定で停止: `git config offline.publish false`(post-commit の
  opt-in を切る。環境変数はツール呼び出し間で残らないため config で行う。
  Task 9 完了後に `git config offline.publish true` で復帰)。
- [ ] **Step 2: orphan 初期コミット作成** — メッセージを **BOM なし UTF-8** で書き出す
  (PowerShell の `>` / `Out-File` は BOM 付きになるため使わない):

  ```powershell
  $msg = @'
  chore: リポジトリ履歴を新規スタートとして初期化

  pdf-to-svg / graph-editor の python-tools リポジトリへの分離完了に伴い、
  GitHub 上の見える履歴を本コミットから開始する。旧履歴の全ブランチ・全タグは
  git bundle (workspace-history-2026-08.bundle) にアーカイブ済みで、設計判断の
  経緯(コミットメッセージ)はそちらから参照できる。

  Claude-Session: https://claude.ai/code/session_01C8TAKZaatEcrSTKzR6W9q3
  '@
  [IO.File]::WriteAllText("$env:TEMP\init-msg.txt", $msg, (New-Object Text.UTF8Encoding $false))
  $tree = git rev-parse "HEAD^{tree}"
  $newroot = git commit-tree $tree -F "$env:TEMP\init-msg.txt"
  ```

  ref の付け替えは **`git update-ref`**(checkout 中のブランチへの `git branch -f` は
  `fatal: cannot force update the branch ... used by worktree` で必ず失敗する):

  ```powershell
  git update-ref refs/heads/chore/deps-latest-offline-bundle $newroot
  git update-ref refs/heads/main $newroot
  ```

  tree 同一のため `git status` はクリーンなまま。`git log --oneline` が 1 コミットのみ
  であること、`git cat-file commit $newroot` の先頭に BOM(efbb bf)が無いことを確認。
- [ ] **Step 3: force push + タグ移動** —

  ```powershell
  # $newroot は Step 2 と別のツール呼び出しでは消えているため必ず再取得する
  # (空のまま push すると +:refs/tags/... = タグ削除 push になる)。
  # Step 2 の update-ref 後は HEAD = newroot なので rev-parse で一意に取れる。
  $newroot = git rev-parse HEAD
  git push --force-with-lease=refs/heads/chore/deps-latest-offline-bundle origin chore/deps-latest-offline-bundle
  git push --force-with-lease=refs/heads/main origin main
  git push origin "+${newroot}:refs/tags/offline-bundle-v1"
  ```

  タグ移動を publish に委ねず**ここで行う**(publish が後段で失敗しても「見える履歴の
  初期化」自体は完了させる。タグのみ push は pre-push が CI をスキップする)。
  ブランチ 2 本の push はそれぞれ pre-push のフル CI が走る(orphan は merge-base 無しで
  ci-affected が必ず runFullCi へ倒れる — 実測裏取り済み)。**両方デタッチパターン**で
  実行し、ログ + `git ls-remote origin` で 3 ref すべてが新履歴(newroot)を指すことを
  確認。
- [ ] **Step 4: 明示 publish(必須ゲート)** — `offline\publish-offline-bundle.ps1` を
  明示実行(除去で requirements 集合が変化 → content-key 変化 → フル再生成 +
  pin 更新 + rolling tag 再移動)。実測(サイズ・所要)を記録。
  ⚠ **pin 生成段は認証付き codeload 取得で、gho トークン拒否(既知・フェーズ 1 実測)が
  再現する可能性が高い**。失敗した場合の復旧手順(フェーズ 1 実績の再現):
  1. コントローラへ 1 行報告後、`gh repo edit koichi-araki-0801/workspace --visibility public --accept-visibility-change-consequences`
  2. 無認証で `https://codeload.github.com/koichi-araki-0801/workspace/zip/<SHA>` を
     取得し sha256 を算出(`<SHA>` = `git rev-parse HEAD` でその場で再取得。
     pin 更新前なので HEAD は publish 対象のコミット)
  3. `offline/pinned-release.txt` を手動更新(source-commit / source-zip-sha256 /
     bundle-sha256 の書式は現行ファイル踏襲)
  4. **直ちに** `gh repo edit ... --visibility private --accept-visibility-change-consequences` で復帰し、
     `gh repo view koichi-araki-0801/workspace --json visibility` で PRIVATE を確認
  ⚠ 連続 visibility 切替は GitHub が 422 拒否する(フェーズ 4 実測)— Step 5 の
  検証で再度 Public 窓が要る場合は数分空ける。
- [ ] **Step 5: 検証 + pin コミット** — クリーンな一時ディレクトリで `setup-offline` を
  実行し新 pin で完走することを確認(`setup-offline.ps1` の取得は無認証 — リポは
  private のため**一時 Public 窓が必要**。Step 4 の復旧で窓を開けた場合は 422 回避の
  ため数分空ける)。窓の開閉は**検証の成否に関わらず**次の 2 コマンドで必ず閉じる:

  ```powershell
  gh repo edit koichi-araki-0801/workspace --visibility private --accept-visibility-change-consequences
  gh repo view koichi-araki-0801/workspace --json visibility   # PRIVATE を確認
  ```
  pin 更新を **`git add offline/pinned-release.txt` に限定**してコミット(pre-push の
  フル CI が `capture_docs.spec.ts` でスクショを再 dirty 化しうる — 巻き込まない。
  残った差分は Task 9 のコミットへ同乗)→ デタッチ push。
  spec §9 step7 判定: `git ls-remote origin` が新履歴の ref を指す / setup 完走。
- [ ] **Step 6: 配布済み環境の確認** — 既に `offline/` フォルダ一式を手渡し済みの
  配布先端末が存在するかを確認し、あれば新しい `offline/`(新 pin)を再配布する
  (旧 pin の source-commit は到達不能化で GC 後 404 になるため)。配布先が無ければ
  「無し」をレポートへ記録して完了。

---

### Task 9: 後始末 — §9 step8

**Files:**
- Modify(monorepo): `docs/pie-chart/src/設計正典.md`(leader 幾何の並行実装相手が
  python-tools リポへ移った旨の相互参照追記)+ 必要に応じ `docs/editor/src/設計正典.md`
- Modify(python-tools): `docs/graph-editor/src/設計正典.md` /
  `docs/pdf-to-svg/src/設計正典.md`(pie-chart 側参照を「monorepo(workspace リポ)」
  表記へ)+ ローカル CLAUDE.md の相互反映ルールへ成果 HTML 複製手順を確認・補記
  (設計正典.md は成果 HTML の生成対象外〈md2html.py:691 で明示除外〉のため
  HTML 再生成・複製は不要 — 裏取り済み)
- Modify(monorepo): マスター計画のフェーズ 5 行を「完了」へ + 本計画末尾の実測記録
- Update: メモリ(`repo-split-progress.md` — プロジェクト完了・bundle 保管場所 +
  参照コマンド。SHA 参照約 30 箇所は注記方式で足りる旨)+ MEMORY.md 索引
- 実行: code-review-graph の graph DB 再構築(除去後ツリー)

- [ ] **Step 1: 両リポ設計正典へ相互参照追記** — leader 幾何規約(`leader_geom.cjs` ⇄
  pie-chart `leader_geometry.ts`)の「片方を変えたら両方」運用がリポをまたいでも
  辿れる形にする。monorepo 側コミット(スクショ再 dirty 分があれば「CI 再撮影」として
  同乗)+ python-tools 側コミット。
- [ ] **Step 2: Task 5 の対象表を最終確認** — 全行が「修正済み」or「意図して残す
  (理由付き)」(spec §9 step8 判定)。
- [ ] **Step 3: マスター計画のフェーズ 5 行を完了へ + 実測記録記入 → コミット**。
- [ ] **Step 4: 自動 publish の復帰** — `git config offline.publish true` を確認・実行。
- [ ] **Step 5: メモリ更新 + graph DB 再構築**(コミット無しの作業)。

---

## 実測記録(実行時に追記)

- Task 2-5 除去後の `pnpm run ci` 所要: (T2-T5)
- Node 依存更新の採用/見送り一覧: (T6)
- stash 処置(patch 保全 + drop)と bundle サイズ・検証結果: (T7)
- force push 後の明示 publish: バンドルサイズ・所要・pin 復旧手順の要否・Public 窓: (T8)
- setup-offline 新 pin 完走の確認: (T8)
- 配布済み環境の有無: (T8)
- 想定外の差異: (発生時)
