# フェーズ 2: pdf-to-svg テスト移植(単体 34 + E2E 4・ハーネス基盤確立) 実装計画 v2

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** pdf-to-svg の vitest 単体 34 件(state 27 + geometry 7)と Playwright TS E2E 4 件を
pytest + playwright-python へ 1:1 移植し、graph-editor(フェーズ 3)へ流用する
page.evaluate ハーネスと fixture サーバの基盤を確立する(spec §4・§9 step1 の一部)。

**Architecture:** 単体は「静的サーバから ES module を実ブラウザ(Edge channel)へ読み込み、
`page.evaluate` で 1 vitest ケース = 1 pytest ケースとして断言」する(spec §4.2)。
モジュールは **blank ページ(存在しないパスの 404 応答)上で dynamic import** する —
index.html を開くと `app.js` が静的 import した**同一モジュールインスタンス**(シングルトン
`S`)を共有し、稼働中 app の `/rpc` 失敗処理・`/ping` ハートビートがテスト状態を汚すため。
E2E は既存の `test/e2e_server.py`(実 Python バックエンド)を pytest fixture から起動し、
旧 TS E2E の :5180 と衝突しない別ポートで並走させる。**旧テスト(vitest / TS E2E)は
削除しない**(削除はフェーズ 5 のディレクトリ削除で一括)。

**Tech Stack:** pytest 9.1.1 / playwright-python 1.62.0(Edge channel・フェーズ 1 で
スパイク合格) / 標準ライブラリ http.server(静的配信)

**Spec:** `docs/superpowers/specs/2026-08-27-python-repo-split-design.md`(v3.6。特に §4.2 /
§4.4 / §4.5)。フェーズ 1 実測: `2026-08-28-phase1-env-python313.md` 末尾。

## Global Constraints

- 端末は Python 3.13.15 のみ(フェーズ 1 完了状態)。pytest・playwright は導入済み。
- **1 vitest ケース = 1 pytest ケース**として個別報告される形にする(まとめ assert 禁止)。
  旧テストの期待値は逐語で写す。**`toBe`(参照同一性)の断言は JS 内で `===` を評価して
  bool を返す形で移植**する(Python 側の `==` 値比較へ弱体化させない —
  コピー返しの退行を検出できなくなる)。
  1:1 対応表 = `docs/superpowers/plans/2026-08-28-phase2-mapping-pdf-to-svg.md`(新設)。
- **マーカー 2 種**: 実ブラウザを要する全テスト(単体 JS 移植含む)に
  `@pytest.mark.browser`、実バックエンド E2E にはさらに `@pytest.mark.e2e`。
  既定収集から除外するのは **e2e のみ**(`addopts = -m "not e2e"`)。browser は
  既定で走る(ローカルは Edge あり。GH Actions は Task 5 で `playwright install msedge`
  を追加して走らせる — 導入が不安定なら `-m "not browser"` へ切り替える退避経路として
  マーカーを使う)。
- **対象 JS は静的サーバの URL 経由で読み込む**(インライン埋込は CDP カバレッジ
  〈フェーズ 3〉の scriptCoverage.url が空になるため禁止。spec §4.2)。
- テストファイル名・harness モジュール名にはプロジェクト固有語(`pdftosvg`)を含める
  (フェーズ 3 でのコピー時の同名衝突と pytest の import file mismatch を避ける)。
- **ハーネスの流用方式 = コピー**(spec §6 の「道具複製」枠): フェーズ 3 は conftest の
  fixtures と harness モジュールを graph-editor/test へコピーし、WEB_ROOT・モジュール名
  だけ差し替える。conftest.py の同名は問題ない(両プロジェクトの pytest は常に別プロセス
  実行 — ci.yml 明文の個別実行前提。graph-editor/test に conftest は現存しない)。
  UMD(classic script + global)経路はフェーズ 3 で追加する。
- 旧テスト・旧設定(vitest.config.js / playwright.config.ts / **pdf-to-svg 配下**の
  package 系)は変更しない(二重テスト期間の両輪維持。ルート package.json / ci.yml /
  ci-affected は Task 5 で変更する)。例外 = `test/e2e_server.py` へのポート env 対応 1 行。
- タイムアウトの射程: playwright の既定(action 30s / expect 5s)が UI 操作・断言を覆う。
  **`page.evaluate` には上限が無い**(旧 TS の `test.setTimeout(120_000)` 相当は持たない —
  既知の残余。E2E サーバは fixture が起動確認してから使うためハング実績は想定薄。
  フレーク化したら pytest-timeout の導入を検討する)。
- コミットメッセージ・コード内コメントは通常の丁寧な日本語(`docs/コメント規約.md` 準拠)。
- 各コミット後 auto-push。pre-push の ci:affected(pdf-to-svg 領域)が走る。

---

### Task 1: pytest ハーネス基盤(harness モジュール + conftest fixtures + marker + ポート分離)

**Files:**
- Create: `pdf-to-svg/test/pdftosvg_js_harness.py`(`js` ヘルパ。conftest からの import は
  stdlib `test` パッケージ shadow に依存する antipattern のため専用モジュールに置く)
- Modify: `pdf-to-svg/test/conftest.py`(fixtures 追加。既存内容は保持)
- Modify: `pdf-to-svg/pyproject.toml`(markers / addopts 追記)
- Modify: `pdf-to-svg/test/e2e_server.py`(PORT の env 上書き 1 行)
- Create: `pdf-to-svg/test/test_pdftosvg_js_smoke.py`(ハーネス自体の煙テスト)

**Interfaces:**
- Produces(フェーズ 3 がコピーして流用する契約):
  - fixture `edge_page`(session): Edge channel headless の Page(blank ページ上)。
  - fixture `web_root_url`(session): `resources/web` を配信する静的サーバのベース URL。
  - `pdftosvg_js_harness.js(page, expr, *args)`: `page.evaluate` の薄いラッパ。
  - マーカー `browser` / `e2e`。

- [ ] **Step 1: pyproject.toml へ pytest 設定を追記**

既存 `[tool.pytest.ini_options]`(testpaths / pythonpath)へ追記:
```toml
addopts = "-m \"not e2e\""
markers = [
    "browser: 実ブラウザ(Edge channel)を要するテスト。CI で Edge を導入できない環境は -m \"not browser\" で除外する",
    "e2e: 実ブラウザ + 実バックエンドの E2E（既定収集から除外。-m e2e で明示実行）",
]
```

- [ ] **Step 2: e2e_server.py の PORT を env で上書き可能にする**

`PORT = 5180`(22 行目) を次へ(TS 側の既定 5180 は不変):
```python
# Python E2E(pytest)は旧 TS E2E(:5180)と並走できるよう PDFTOSVG_E2E_PORT で別ポートを指定する。
PORT = int(os.environ.get("PDFTOSVG_E2E_PORT", "5180"))
```

- [ ] **Step 3: harness モジュールと conftest fixtures を書く**

`pdf-to-svg/test/pdftosvg_js_harness.py`:
```python
# =============================================================================
# pdftosvg_js_harness.py — JS 移植テストの共通ヘルパ（設計書 §4.2）
# =============================================================================
# conftest.py に置かないのは、テストコードから `from test.conftest import ...` する形が
# stdlib `test` パッケージの shadow と pytest の import mode に依存する壊れやすい経路のため。
# フェーズ 3(graph-editor)はこのファイルと conftest の fixtures をコピーして流用する。


def js(page, expr, *args):
    """`page.evaluate` の薄いラッパ。式 1 個 = 断言 1 個の形で使う。"""
    return page.evaluate(expr, *args)
```

`pdf-to-svg/test/conftest.py` の末尾へ追記:
```python
# ── JS 単体・E2E 移植用ハーネス（設計書 §4.2。graph-editor 側フェーズ 3 がコピーして流用）──
import http.server
import socket
import threading

import pytest

WEB_ROOT = os.path.join(os.path.dirname(__file__), "..", "resources", "web")


@pytest.fixture(scope="session")
def web_root_url():
    """`resources/web` を配信する静的サーバ。ES module は URL 経由で読み込む
    （インライン埋込だと CDP カバレッジの scriptCoverage.url が空になるため）。"""
    handler = lambda *a, **kw: http.server.SimpleHTTPRequestHandler(
        *a, directory=os.path.abspath(WEB_ROOT), **kw)
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    server = http.server.ThreadingHTTPServer(("127.0.0.1", port), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{port}"
    server.shutdown()


@pytest.fixture(scope="session")
def edge_page(web_root_url):
    """Edge channel（端末既存の Edge・追加ダウンロード無し）の共有ページ。

    blank ページ（存在しないパス = 404 応答）を開く: index.html を開くと app.js が
    静的 import した同一モジュールインスタンス（シングルトン `S`）を共有してしまい、
    稼働中 app の /rpc 失敗処理・/ping ハートビートがテスト状態を汚すため。
    404 の文書でも origin は静的サーバなので dynamic import は同じ URL 空間で解決する。"""
    from playwright.sync_api import sync_playwright

    with sync_playwright() as p:
        browser = p.chromium.launch(channel="msedge", headless=True)
        page = browser.new_page()
        page.goto(web_root_url + "/__pytest_blank__")
        yield page
        browser.close()
```

- [ ] **Step 4: 煙テストを書く(RED → GREEN)**

`pdf-to-svg/test/test_pdftosvg_js_smoke.py`:
```python
# =============================================================================
# test_pdftosvg_js_smoke.py — JS 移植ハーネス自体の煙テスト
# =============================================================================
# 静的サーバから ES module を実ブラウザへ読み込んで evaluate できることを固定する。
# ここが緑でなければ後続の state/geometry 移植は全部成立しない。
import pytest

from .pdftosvg_js_harness import js

pytestmark = pytest.mark.browser


def test_module_import_and_evaluate(edge_page):
    mod = "import('/geometry.js').then(m => { window.__smoke = m; return typeof m.parseSpec; })"
    assert edge_page.evaluate(mod) == "function"
    assert js(edge_page, "window.__smoke.parseSpec('1-3', 10)") == [1, 2, 3]
```
(geometry.js / state.js は `resources/web` 直下に実在・他モジュール import 無しを確認済み。
`import('/geometry.js')` は配信ルート直下解決で正しい)

Run: `python -m pytest pdf-to-svg/test/test_pdftosvg_js_smoke.py -v`
Expected: fixtures 実装前は FAIL、実装後 PASS。

- [ ] **Step 5: 既定収集の不変を確認**

Run: `python -m pytest pdf-to-svg -q`
Expected: 251 passed(既存 250 + 煙 1。addopts の e2e 除外で既存が減らないこと)。

- [ ] **Step 6: コミット**

```powershell
git add pdf-to-svg/pyproject.toml pdf-to-svg/test/conftest.py pdf-to-svg/test/e2e_server.py pdf-to-svg/test/pdftosvg_js_harness.py pdf-to-svg/test/test_pdftosvg_js_smoke.py
git commit -m "test(pdf-to-svg): JS 移植ハーネス(静的サーバ + Edge page fixtures)を追加"
```
> 注: この時点で GH Actions の verify(main への PR 時)は Edge 未導入だと browser テストで
> 赤になる。Actions 側の手当ては Task 5 で行う — **Task 1〜5 は main への PR を挟まず
> 一気に進める**(常設ブランチ運用では通常どおり)。

---

### Task 2: geometry.test.js の移植(7 ケース)

**Files:**
- Create: `pdf-to-svg/test/test_pdftosvg_geometry_js.py`
- Create: `docs/superpowers/plans/2026-08-28-phase2-mapping-pdf-to-svg.md`(対応表・書き始め)

**Interfaces:**
- Consumes: Task 1 の `edge_page` / `js`
- Produces: fixture `geo`(module を `window.__geo` へ読み込んだ Page)

- [ ] **Step 1: fixture と最初のケース(RED → GREEN)**

```python
# =============================================================================
# test_pdftosvg_geometry_js.py — resources/web/geometry.js の単体移植
# =============================================================================
# 旧 geometry.test.js (vitest) の it 7 件と 1:1。期待値は旧テストから逐語で写す。
import pytest

from .pdftosvg_js_harness import js

pytestmark = pytest.mark.browser


@pytest.fixture(scope="module")
def geo(edge_page):
    edge_page.evaluate("import('/geometry.js').then(m => { window.__geo = m; })")
    return edge_page


def test_parsespec_expands_ranges_and_singles(geo):
    assert js(geo, "window.__geo.parseSpec('1-5, 8', 100)") == [1, 2, 3, 4, 5, 8]
```

- [ ] **Step 2: 残り 6 ケースを移植**

旧 it: 逆順範囲 / 重複の一意化 / 1..maxPages クランプ / 空・不正トークン無視 /
clientToPage 系 2 件。clientToPage はスタブ svgEl(メソッド持ち)を使うため
**引数渡しでなく JS 式内で構築**して評価する(メソッド持ちオブジェクトは
evaluate の引数として serialize できない)。

- [ ] **Step 3: 対応表を書き始める(7 行)**

`2026-08-28-phase2-mapping-pdf-to-svg.md`(通常の日本語):
```markdown
| 旧(vitest/TS) | 新(pytest) | 状態 |
|---|---|---|
| geometry.test.js: parseSpec 範囲と単発を昇順ユニークに展開する | test_pdftosvg_geometry_js.py::test_parsespec_expands_ranges_and_singles | 移植済み |
```
冒頭に注記を 1 行: 「実行エンジン差: 旧 = playwright 同梱 chromium / 新 = Edge channel
(同系エンジン・版は端末 Edge 追随)」。

- [ ] **Step 4: 確認とコミット**

Run: `python -m pytest pdf-to-svg -q` → 258 passed
```powershell
git add pdf-to-svg/test/test_pdftosvg_geometry_js.py docs/superpowers/plans/2026-08-28-phase2-mapping-pdf-to-svg.md
git commit -m "test(pdf-to-svg): geometry.js 単体 7 件を pytest へ移植(旧 vitest と 1:1)"
```

---

### Task 3: state.test.js の移植(27 ケース)

**Files:**
- Create: `pdf-to-svg/test/test_pdftosvg_state_js.py`
- Modify: 対応表(27 行追記)

**Interfaces:**
- Consumes: Task 1 の `edge_page` / `js`
- Produces: fixture `st`(module `window.__st` + `window.__reset`)

- [ ] **Step 1: fixture と reset の移植**

旧 `reset()`(state.test.js:15-29)を window 関数として一度だけ定義し、autouse で毎テスト
前に呼ぶ(旧 `beforeEach(reset)` の 1:1。ページ再読込はしない):
```python
import pytest

from .pdftosvg_js_harness import js

pytestmark = pytest.mark.browser

RESET = """
window.__reset = () => {
  const m = window.__st;
  m.applyState({
    files: [{ name: "a.pdf", pages: 2 }, { name: "b.pdf", pages: 3 }],
    pages: [
      { fileIndex: 0, pageInFile: 0 }, { fileIndex: 0, pageInFile: 1 },
      { fileIndex: 1, pageInFile: 0 }, { fileIndex: 1, pageInFile: 1 }, { fileIndex: 1, pageInFile: 2 },
    ],
    total: 5,
    changed2: [true, false, true, true, false],
    changed3: [false, false, false, false, false],
  });
  m.S.phase = 2; m.S.page = 0; m.S.guarding = false;
  m.S.selFor = { 2: {}, 3: {} };
  m.S.expMode = "all"; m.S.expFile = 0;
};
"""


@pytest.fixture(scope="module")
def st(edge_page):
    edge_page.evaluate("import('/state.js').then(m => { window.__st = m; })")
    edge_page.evaluate(RESET)
    return edge_page


@pytest.fixture(autouse=True)
def _reset_state(st):
    js(st, "window.__reset()")
```

- [ ] **Step 2: describe 7 ブロック・27 it を 1:1 で移植**

対象ブロック: 純粋ヘルパ / applyState / invalidateAll / 導出 / 遷移 / 書き出し範囲 /
ZIP 送信の分割。関数名は `test_<describe 要約>_<it 要約>`。
**`toBe`(参照同一性)の断言(例: `expect(statusArr()).toBe(S.status2)`)は JS 内で
`===` を評価する**:
```python
def test_derived_statusarr_is_identity_of_status2(st):
    assert js(st, "window.__st.statusArr() === window.__st.S.status2") is True
```
値比較の `toEqual` は Python 側 `==`(dict/list 自動変換)。ファイル単位 RED→GREEN、
27 行を対応表へ。

- [ ] **Step 3: 確認とコミット**

Run: `python -m pytest pdf-to-svg -q` → 285 passed /
`python -m pytest pdf-to-svg/test/test_pdftosvg_state_js.py -v` → 27 件個別 PASS
```powershell
git add pdf-to-svg/test/test_pdftosvg_state_js.py docs/superpowers/plans/2026-08-28-phase2-mapping-pdf-to-svg.md
git commit -m "test(pdf-to-svg): state.js 単体 27 件を pytest へ移植(旧 vitest と 1:1)"
```

---

### Task 4: app_flow E2E の移植(4 ケース・playwright-python)

**Files:**
- Create: `pdf-to-svg/test/test_pdftosvg_app_flow_e2e.py`
- Modify: 対応表(4 行追記)

**Interfaces:**
- Consumes: Task 1 の e2e_server.py ポート env 対応
- Produces: `e2e_server` / `e2e_page` fixtures(フェーズ 3 の参考実装)

- [ ] **Step 1: E2E サーバと page の fixtures**

```python
# =============================================================================
# test_pdftosvg_app_flow_e2e.py — 4 ステップ UI の通し E2E(旧 app_flow.e2e.ts の 1:1)
# =============================================================================
# 実 Python バックエンド(test/e2e_server.py)を子プロセスで起動し、Edge channel の
# 実ブラウザから叩く。旧 TS E2E(:5180)と並走できるよう別ポート(:5181)を使う。
# page は module スコープ共有(旧 TS はテスト毎に新規 page)だが、全テストが冒頭で
# goto するため JS realm は毎回作り直され、サーバ状態は resetSession が戻す — 等価。
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request

import pytest

pytestmark = [pytest.mark.browser, pytest.mark.e2e]

PORT = 5181
TOKEN = "e2e-fixed-session-token"
BASE = f"http://127.0.0.1:{PORT}"
FIXTURE = os.path.join(os.path.dirname(__file__), "fixtures", "sample.pdf")


@pytest.fixture(scope="module")
def e2e_server():
    env = dict(os.environ, PDFTOSVG_E2E_PORT=str(PORT))
    proc = subprocess.Popen(
        [sys.executable, os.path.join(os.path.dirname(__file__), "e2e_server.py")],
        env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    try:
        for _ in range(100):
            try:
                urllib.request.urlopen(BASE + "/", timeout=1)
                break
            except urllib.error.HTTPError:
                break  # 4xx/5xx でも「サーバが応答した」= 起動完了
            except OSError:
                if proc.poll() is not None:
                    raise RuntimeError(proc.stderr.read().decode("utf-8", "replace"))
                time.sleep(0.2)
        else:
            raise RuntimeError("e2e server が起動しない")
        yield BASE
    finally:
        proc.kill()
        proc.wait()


@pytest.fixture(scope="module")
def e2e_page(e2e_server):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as p:
        browser = p.chromium.launch(channel="msedge", headless=True)
        page = browser.new_page(base_url=e2e_server)
        yield page
        browser.close()
```

- [ ] **Step 2: 旧 4 テストを 1:1 移植**

旧テストが使う機能は evaluate による `window.rpc` 差し替え・`expect_file_chooser`・
FilePayload での `set_files`・`expect_download` + `download.path()`・`keyboard.press`・
`to_have_class` のみ(**page.route は不使用** — 実読で確認済み)。すべて sync API に
等価あり。**resetSession 相当の evaluate は 4 テスト全てで goto 直後に呼ぶ**(旧 TS と
同じ)。旧 test 名 → 新関数:
1. 「4 ステップ通し: 取込 → 置換 → 削除/Undo → 書き出し」→ `test_four_step_flow`
2. 「ページ切替: 遅れて届いた旧ページの取得結果が現ページの操作を壊さない」→
   `test_stale_page_fetch_does_not_break_current_page`
3. 「読み込みが途中で失敗しても、成功した分は取り込んで理由を知らせる」→
   `test_partial_load_failure_keeps_succeeded_files`
4. 「一覧の取得に失敗したら旧ページの行を残さず、再試行の導線を出す」→
   `test_list_fetch_failure_clears_rows_and_offers_retry`
各ステップ(evaluate 文字列・セレクタ・タイムアウト値)は旧 TS から逐語で写す。

Run: `python -m pytest pdf-to-svg -m e2e -v` → 4 件 PASS(pytest 既定の直列実行)。

- [ ] **Step 3: 旧 TS E2E との並走確認(連続実行)**

```powershell
pnpm run e2e:pdf-to-svg
python -m pytest pdf-to-svg -m e2e -q
```
Expected: 両方 green(旧=5180 / 新=5181 でポート衝突なし)。

- [ ] **Step 4: コミット**

```powershell
git add pdf-to-svg/test/test_pdftosvg_app_flow_e2e.py docs/superpowers/plans/2026-08-28-phase2-mapping-pdf-to-svg.md
git commit -m "test(pdf-to-svg): app_flow E2E 4 件を playwright-python へ移植(旧 TS と 1:1・別ポート並走)"
```

---

### Task 5: CI 組込とフェーズ 2 完了ゲート

**Files:**
- Modify: ルート `package.json`(`e2e:pdf-to-svg:py` 追加 + `ci` へ組込)
- Modify: `scripts/ci-affected.mjs`(pdf-to-svg 領域 stages へ追加)
- Modify: `scripts/ci-affected.test.mjs`(**必須**: stages 期待値は deepEqual 完全一致の
  ため、stages 追加と同一コミットで期待値を更新しないと `test:scripts` が赤)
- Modify: `.github/workflows/ci.yml`(**Edge 導入**: browser マーカーの単体を ubuntu で
  走らせるため)
- Modify: マスター計画(フェーズ 2 完了記録)

**Interfaces:**
- Consumes: Task 1-4 の全テスト
- Produces: 機械ゲート化された両輪検証

- [ ] **Step 1: package.json へスクリプト追加**

`"e2e:pdf-to-svg:py": "python -m pytest pdf-to-svg -m e2e"` を追加し、`ci` チェーンへ
` && pnpm run e2e:pdf-to-svg:py` を組み込む(単体は既存 `test:pdf-to-svg` の収集に
自動で乗る。addopts の既定除外で E2E だけ漏れるため明示段が要る)。

- [ ] **Step 2: ci-affected の stages と test の期待値を同一コミットで更新**

`ci-affected.mjs` の pdf-to-svg 領域 stages へ `'e2e:pdf-to-svg:py'` を追加し、
`ci-affected.test.mjs` の該当 deepEqual 期待値(とテスト名の段数表記があれば)を追随。

- [ ] **Step 3: ci.yml へ Edge 導入を追加**

`Install Python test dependencies` の後へ:
```yaml
      - name: Install Edge for browser-marked tests
        run: python -m playwright install msedge
```
(pytest 段は既定収集のまま = browser 単体は Actions でも走る・e2e は addopts で除外。
msedge の導入が Actions で不安定と判明した場合の退避 = pytest 段へ `-m "not browser"`
を付ける — この判断は実測後。退避した場合は本計画の実測記録へ記載)

- [ ] **Step 4: 検証(フェーズ 2 完了ゲート)**

```powershell
pnpm run test:scripts
python -m pytest pdf-to-svg -q
python -m pytest pdf-to-svg -m e2e -q
pnpm run test:pdf-to-svg:js
pnpm run e2e:pdf-to-svg
```
Expected: すべて green =
- 新 pytest 単体 285 passed(既存 250 + 煙 1 + 移植 34)
- 新 E2E 4 passed
- 旧 vitest 34 passed / 旧 TS E2E 4 passed(**pdf-to-svg 分の両輪**)

- [ ] **Step 5: 対応表完成・マスター更新・コミット**

対応表 38 行 + エンジン差注記を確認し、マスターのフェーズ 2 行を「完了」へ。
```powershell
git add package.json scripts/ci-affected.mjs scripts/ci-affected.test.mjs .github/workflows/ci.yml docs/superpowers/plans/2026-08-28-phase2-mapping-pdf-to-svg.md docs/superpowers/plans/2026-08-28-python-repo-split-master.md
git commit -m "ci: pdf-to-svg の Python E2E と Actions の Edge 導入を組み込む(フェーズ 2 完了)"
```

---

## 実測記録(実行時に追記)

- blank ページ(404)上での dynamic import の成立: 成立した。Task 1〜3 で追加した単体テストは
  全 35 件(煙テスト 1 + geometry 7 + state 27)が green で、静的サーバの 404 応答文書上でも
  `import('/xxx.js')` の dynamic import が同一 origin の URL 空間から正しく解決されることを
  確認した。
- 起動待ち GET の応答種別(200/403): 実測は 200 OK(`index.html`)。`e2e_server` fixture の
  起動待ちループが叩く `GET /` は安全メソッドでありトークン検査を要求しないため、通常は
  `urlopen` が例外なく成功して `try` ブロックの正常終了経路でループを抜ける
  (`HTTPError` 分岐は今回未通過。詳細は Task 4 レポート `task-4-report.md` の
  「実測記録: 起動待ち GET の応答種別」節)。
- GH Actions の msedge 導入可否: 未実測(次回 main PR で確認。本フィックス波で
  `python -m playwright install --with-deps msedge` へ変更し、ubuntu ランナーの
  システム依存導入を同時に行う形へ更新済み)。
- 移植中に見つかった旧テストとの挙動差: 無し。対応表 38 行(geometry 7 + state 27 + E2E 4)を
  旧テストと逐語で突き合わせたタスクレビューにおいて、期待値・アサーション・呼び出し順の
  すべてが 38/38 で一致することを確認した。
