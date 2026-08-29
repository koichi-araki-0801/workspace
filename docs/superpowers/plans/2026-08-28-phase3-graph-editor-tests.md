# フェーズ 3: graph-editor テスト移植(単体 75 + E2E 34 + CDP カバレッジゲート) 実装計画 v2

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** graph-editor の vitest 単体 75 件と Playwright TS E2E 34 件(capture 5 件含む)を
pytest + playwright-python へ 1:1 移植し、**CDP による JS カバレッジゲート**(svg-policy /
leader_geom の退行防止)を pytest へ再実装する(spec §4.2-§4.4・§9 step1-2 の残り)。

**Architecture(v2 で確定した設計):**
- ハーネスはフェーズ 2 のコピー流用(道具複製枠)+ graph-editor 固有 2 点:
  ①`leader_geom.cjs` は UMD → **classic `<script>` + global `LeaderGeom`**(ui.html:130 と
  同経路) ②単体セッションの Edge page で **CDP precise coverage を「goto 後・モジュール
  読込前」に開始**し、収集順最後のゲートテストが行・関数カバレッジを閾値判定。
- **playwright は単一の session `edge_browser` fixture に括り出す**(フェーズ 2 教訓①。
  単体用 `edge_page` = session・CDP 付き / E2E 用 `e2e_page` = **function スコープで
  context ごと毎テスト生成** — 旧 TS の per-test page と同型にし、`page.route` パッチ・
  dialog リスナ・viewport 変更の残存を構造的に排除する)。
- E2E サーバは `editor_server.mjs` の Python 置換(`app.py` の SECURITY_HEADERS を直接
  import して逐語複製 drift 面を解消。**`.cjs` の MIME を明示登録** — nosniff 下で
  classic script が実行拒否されるため)。**ephemeral ポート + stdout 実ポート読取**。
- 新 capture(Python)は docs へ**書かず一時ディレクトリへ出力**する(二重テスト期間中に
  新旧 capture が同一 png を交互上書きして ci のたび byte 差分が出るのを防ぐ。docs の
  正は引き続き旧 TS capture。フェーズ 5 の旧削除時に py 側の出力先を docs へ切替える)。
- 旧テストは削除しない(フェーズ 5 で一括)。

**Tech Stack:** pytest 9.1.1 / playwright-python 1.62.0(Edge channel) / CDP
`Profiler.startPreciseCoverage` / 標準ライブラリ http.server

**Spec:** `docs/superpowers/specs/2026-08-27-python-repo-split-design.md`(v3.6。§4.2/4.3/
4.4/4.5)。前提: フェーズ 2 の実測記録・最終レビュー引き継ぎ 5 点(全て本計画へ反映済み)。

## Global Constraints

- 端末は Python 3.13.15 のみ。pytest・playwright は導入済み。
- **1 vitest it = 1 pytest 関数**・期待値は逐語・`toBe`(参照同一性)は JS 内 `===` 評価。
  1:1 対応表 = `docs/superpowers/plans/2026-08-28-phase3-mapping-graph-editor.md`(単体 75 +
  E2E 34 = 109 行)。
- **import は絶対形**: `from grapheditor_js_harness import js` のように書く。
  **graph-editor/test には `__init__.py` が無い**(pdf-to-svg と違いパッケージでない —
  ci.yml の明文)ため、相対 import(`from .xxx import`)は ImportError になる。
  `__init__.py` は追加**しない**(追加すると pdf-to-svg 側と同名モジュール衝突の前提が
  変わる)。
- **マーカー**: 実ブラウザ要求テストに `browser`、E2E にはさらに `e2e`。
  `graph-editor/pyproject.toml` に `addopts = "--strict-markers -m \"not e2e\""` と
  markers を新設。既定運用では単体(`-m "not e2e"` 既定)と E2E(`-m e2e`)が排他のため
  Edge が 2 面立つことは無い(素の `-m browser` 実行では両方選択され edge_page と
  e2e_page が併存するが、browser は単一 `edge_browser` を共有するため sync_playwright の
  二重起動は起きない)。
- **対象 JS は静的サーバ URL 経由**(ES modules = module script / leader_geom.cjs =
  classic script)。インライン埋込禁止(CDP の scriptCoverage.url が空になる)。
- **カバレッジ閾値は実測 → 再校正して固定**(spec §4.3。旧 85% と数値互換なし。行 + 関数)。
  部分実行(`-k` 等)ではゲートが偽赤になり得る(全単体実行後の値を前提とするため) —
  ゲートの docstring に明記する。
- テストファイル名・harness 名に固有語(`grapheditor`)を含める。
- フィクスチャ(SVG/CSS)は Python 側で読み evaluate へ引数注入。
- 旧テスト・旧設定(vitest.config.ts / playwright.config.ts / tsconfig.json /
  editor_server.mjs)は変更しない。
- **pytest-timeout は導入しない**(spec §4.4「retries/並列は必要時のみ」と整合する既知の
  残余。E2E 移植中にハング/フレーク〈テストが 60 秒超で返らない・同一テストが再実行で
  結果を変える〉を 1 度でも実測したら、その場で中断しコントローラへ報告 — 導入は
  dev-requirements 変更 = content-key 反転 = 明示 publish を伴うため計画外タスク化する)。
- テスト実行は `py -3.13 -m pytest ...`。pnpm 実行前は PowerShell で PATH をレジストリ
  再構成。**push はコントローラ代行**(auto-push の失敗ログ無視)。
- コミットメッセージ・コメントは通常の丁寧な日本語 + 末尾に Claude-Session 行。
- E2E は pytest 直列で移植(旧 fullyParallel: true からの意図的変更。並列化は必要が
  実測されたら別途判断)。

---

### Task 1: ハーネス移設 + CDP カバレッジ収集 fixture + 煙テスト

**Files:**
- Create: `graph-editor/test/grapheditor_js_harness.py`
- Create: `graph-editor/test/conftest.py`(新設 — 既存無し)
- Modify: `graph-editor/pyproject.toml`(pytest 設定へ addopts / markers 追記)
- Create: `graph-editor/test/test_grapheditor_js_smoke.py`

**Interfaces:**
- Produces:
  - fixture `edge_browser`(session): Edge channel の共有 Browser(単体・E2E 両用の
    唯一の sync_playwright 起点)。
  - fixture `web_root_url`(session): `graph-editor/resources/web` の静的サーバ
    (port-0 直接束縛・quiet handler・server_close — pdf-to-svg の堅牢化済み版のコピー)。
  - fixture `edge_page`(session): blank ページの Page。**goto 完了後に** CDP を張り
    precise coverage を開始(モジュール読込はまだ起きていない)。
  - fixture `coverage_collector`(session): `take()` が
    `Profiler.takePreciseCoverage` の `result` を返す。
  - `grapheditor_js_harness.js(page, expr, *args)` / `load_classic(page, url)`。

- [ ] **Step 1: pyproject.toml へ pytest 設定を追記**

既存 `[tool.pytest.ini_options]`(testpaths / pythonpath)へ:
```toml
addopts = "--strict-markers -m \"not e2e\""
markers = [
    "browser: 実ブラウザ(Edge channel)を要するテスト。CI で Edge を導入できない環境は -m \"not browser\" で除外する",
    "e2e: 実ブラウザ + 実バックエンドの E2E（既定収集から除外。-m e2e で明示実行）",
]
```

- [ ] **Step 2: harness と conftest を書く**

`grapheditor_js_harness.py`:
```python
# =============================================================================
# grapheditor_js_harness.py — JS 移植テストの共通ヘルパ（設計書 §4.2）
# =============================================================================
# pdf-to-svg/test/pdftosvg_js_harness.py からのコピー流用（設計書 §6 の道具複製枠。
# 改善はコピー元と相互反映する）に、graph-editor 固有の classic script 読込
# （UMD の leader_geom.cjs）を加えたもの。


def js(page, expr, *args):
    """`page.evaluate` の薄いラッパ。式 1 個 = 断言 1 個の形で使う。"""
    return page.evaluate(expr, *args)


def load_classic(page, url):
    """classic `<script src>` を挿入する（UMD が global を生やす読込経路。ui.html と同じ）。"""
    page.add_script_tag(url=url)
```

`conftest.py`:
```python
# =============================================================================
# conftest.py — graph-editor pytest の共有 fixtures
# =============================================================================
# 静的サーバは pdf-to-svg/test/conftest.py のコピー流用（設計書 §6 の道具複製枠。改善は
# コピー元と相互反映する）。graph-editor 固有:
# - playwright は単一の session Browser（edge_browser）へ括り出す。単体（edge_page）と
#   E2E（e2e_page）が同じ Browser を共有し、sync_playwright の二重起動を作らない。
# - CDP precise coverage は「goto 完了後・モジュール読込前」に開始する（設計書 §4.3。
#   goto より前に張ると renderer の process swap で Profiler 状態を失うことがあり、
#   読込後に張ると読込済みスクリプトを取りこぼす）。
import functools
import http.server
import os
import threading

import pytest

WEB_ROOT = os.path.join(os.path.dirname(__file__), "..", "resources", "web")


class _QuietStaticHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


@pytest.fixture(scope="session")
def web_root_url():
    handler = functools.partial(_QuietStaticHandler, directory=os.path.abspath(WEB_ROOT))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{port}"
    server.shutdown()
    server.server_close()


@pytest.fixture(scope="session")
def edge_browser():
    """Edge channel（端末既存の Edge・追加ダウンロード無し）の共有 Browser。"""
    from playwright.sync_api import sync_playwright

    with sync_playwright() as p:
        browser = p.chromium.launch(channel="msedge", headless=True)
        yield browser
        browser.close()


@pytest.fixture(scope="session")
def edge_page(edge_browser, web_root_url):
    """単体移植用の共有ページ（blank = 404 上。理由は pdf-to-svg 側 conftest と同じ）。"""
    page = edge_browser.new_page()
    page.goto(web_root_url + "/__pytest_blank__")
    cdp = page.context.new_cdp_session(page)
    cdp.send("Profiler.enable")
    cdp.send("Profiler.startPreciseCoverage", {"callCount": True, "detailed": True})
    page._grapheditor_cdp = cdp
    yield page
    page.close()


class _CoverageCollector:
    """CDP precise coverage の取り出し口。ゲートテスト（カバレッジ判定）が消費する。"""

    def __init__(self, cdp):
        self._cdp = cdp

    def take(self):
        return self._cdp.send("Profiler.takePreciseCoverage")["result"]


@pytest.fixture(scope="session")
def coverage_collector(edge_page):
    return _CoverageCollector(edge_page._grapheditor_cdp)
```

- [ ] **Step 3: 煙テスト(RED → GREEN)**

`test_grapheditor_js_smoke.py`(**絶対 import** — test/ は非パッケージ):
```python
# =============================================================================
# test_grapheditor_js_smoke.py — JS 移植ハーネス自体の煙テスト
# =============================================================================
# ES module（svg-policy.js）と UMD classic script（leader_geom.cjs → global LeaderGeom）の
# 両読込経路が成立することを固定する。後続の 75 件はこの 2 経路の上に建つ。
import pytest

from grapheditor_js_harness import js, load_classic

pytestmark = pytest.mark.browser


def test_module_and_classic_script_loading(edge_page, web_root_url):
    assert edge_page.evaluate(
        "import('/js/svg-policy.js').then(m => { window.__smoke = m; return typeof m.isAllowedElement; })"
    ) == "function"
    load_classic(edge_page, web_root_url + "/lib/leader_geom.cjs")
    assert js(edge_page, "typeof window.LeaderGeom.clampPointToBox") == "function"
    assert js(edge_page, "window.LeaderGeom.clampPointToBox({x:-5,y:2},{left:0,top:0,right:10,bottom:4})") == {"x": 0, "y": 2}
```

Run: `py -3.13 -m pytest graph-editor/test/test_grapheditor_js_smoke.py -v`
Expected: fixtures 前 FAIL → 実装後 PASS。

- [ ] **Step 4: 既定収集の不変確認**

Run: `py -3.13 -m pytest graph-editor -q` → 103 passed(既存 102 + 煙 1)。

- [ ] **Step 5: コミット**

```powershell
git add graph-editor/pyproject.toml graph-editor/test/conftest.py graph-editor/test/grapheditor_js_harness.py graph-editor/test/test_grapheditor_js_smoke.py
git commit -m "test(graph-editor): JS 移植ハーネス(CDP カバレッジ計測込み)を追加"
```

---

### Task 2: 単体移植 A — leader_geom 21 件 + pie_rules 14 件

**Files:**
- Create: `graph-editor/test/test_grapheditor_leader_geom_js.py`
- Create: `graph-editor/test/test_grapheditor_pie_rules_js.py`
- Create: 対応表 `docs/superpowers/plans/2026-08-28-phase3-mapping-graph-editor.md`(35 行 +
  エンジン差注記。丁寧な日本語)

**Interfaces:**
- Consumes: Task 1 の `edge_page` / `js` / `load_classic`
- Produces: fixture `geom`(classic script 読込済み Page)/ `rules`(`window.__rules`)

- [ ] **Step 1: leader_geom 21 件を移植**

正典 = 旧 `graph-editor/test/editor_leader_geom.test.ts`(describe **4** ブロック:
clampPointToBox / parsePath・buildPath / parseTranslate / normColor)。module fixture:
```python
import pytest

from grapheditor_js_harness import js, load_classic

pytestmark = pytest.mark.browser


@pytest.fixture(scope="module")
def geom(edge_page, web_root_url):
    if not edge_page.evaluate("typeof window.LeaderGeom !== 'undefined'"):
        load_classic(edge_page, web_root_url + "/lib/leader_geom.cjs")
    return edge_page
```
(読込済み判定は煙テストとの二重読込を防ぐ — カバレッジの functions 母数を単一読込に
保つ不変条件。ゲート側にも同一 URL 複数 scriptCoverage の検出 assert を置く〈Task 4〉)
断言は `js(geom, "window.LeaderGeom.clampPointToBox(...)") == {...}`(期待値は逐語)。

- [ ] **Step 2: pie_rules 14 件を移植**

正典 = 旧 `editor_pie_rules.test.ts`。`window.__rules` へ module 読込し同形で移植。

- [ ] **Step 3: 検証・対応表・コミット**

Run: `py -3.13 -m pytest graph-editor -q` → 138 passed(103 + 35)
```powershell
git add graph-editor/test/test_grapheditor_leader_geom_js.py graph-editor/test/test_grapheditor_pie_rules_js.py docs/superpowers/plans/2026-08-28-phase3-mapping-graph-editor.md
git commit -m "test(graph-editor): leader_geom 21 件 + pie_rules 14 件を pytest へ移植(旧 vitest と 1:1)"
```

---

### Task 3: 単体移植 B — svg_policy 25 件 + utils 系 15 件

**Files:**
- Create: `graph-editor/test/test_grapheditor_svg_policy_js.py`
- Create: `graph-editor/test/test_grapheditor_utils_js.py`(state_fields 6 + shortcuts 4 +
  label_text 5。旧 3 ファイルとの対応は対応表で保つ)
- Modify: 対応表(40 行追記)

**Interfaces:**
- Consumes: Task 1 の `edge_page` / `js`
- Produces: fixture `policy`(`window.__pol`)/ `utils`(`window.__u`)

- [ ] **Step 1: svg_policy 25 件を移植**

正典 = 旧 `editor_svg_policy.test.ts`。注意:
- fixture `test/fixtures/pie_font_face.css` は Python 側 `open().read()` →
  `page.evaluate("css => window.__pol.sanitizeFontFaceCss(css) === css", css_text)` の形で
  **冪等断言を JS 内 `===` で**写す(旧: `sanitizeFontFaceCss(css)` toBe `css`)。
- `ALLOWED_ELEMENTS` 等の Set は serialize 不能 — membership は JS 内 `.has(...)` 評価で
  bool を返す。
- 実行時間を測る timing 系ケース(ReDoS 耐性等)があれば `performance.now()` を JS 内で
  使いブラウザ内計測で逐語移植(Python 側の壁時計で代用しない)。

- [ ] **Step 2: utils 系 15 件を移植**

正典 = 旧 `editor_state_fields.test.ts` / `editor_shortcuts.test.ts` /
`editor_label_text.test.ts`。
- **state_fields 6 件は工数注意**: `STATE_FIELDS` の値は `copy`/`equals` **関数**を持ち
  serialize 不能。旧テストのテスト側ヘルパ(`snapshot` / `legacyEquals` / `VARIANTS`)を
  **JS 式内で丸ごと再構築**して評価する(1 回の evaluate で「ヘルパ定義 + 断言」を返す
  IIFE 形。旧コードの逐語をテンプレート文字列として埋める)。
- shortcuts / label_text の記述子(`el("INPUT")` / Tspan 配列)は plain 値なので引数渡しか
  JS 式内構築のどちらでもよい(旧の形に近い方)。

- [ ] **Step 3: 検証・対応表・コミット**

Run: `py -3.13 -m pytest graph-editor -q` → 178 passed(138 + 40)
```powershell
git add graph-editor/test/test_grapheditor_svg_policy_js.py graph-editor/test/test_grapheditor_utils_js.py docs/superpowers/plans/2026-08-28-phase3-mapping-graph-editor.md
git commit -m "test(graph-editor): svg_policy 25 件 + utils 系 15 件を pytest へ移植(旧 vitest と 1:1)"
```

---

### Task 4: CDP カバレッジゲート(実測 → 校正 → 固定)

**Files:**
- Create: `graph-editor/test/grapheditor_v8_coverage.py`(offset→行/関数変換の純 Python)
- Create: `graph-editor/test/test_grapheditor_v8_coverage_unit.py`(変換器単体。browser
  マーカー無し)
- Create: `graph-editor/test/test_zzz_grapheditor_coverage_gate.py`(ゲート本体)
- Modify: 本計画末尾「実測記録」

**Interfaces:**
- Consumes: `coverage_collector`、Task 2/3 の全単体(収集順で先行 — pytest の同一
  ディレクトリ収集はファイル名ソートで安定し `test_zzz_*` が最後)
- Produces: `line_and_function_coverage(script_source, functions) -> tuple[float, float]`

- [ ] **Step 1: 変換器の単体テストを先に書く(RED)**

V8 precise coverage は関数ごとの byte-offset range(`startOffset`/`endOffset`/`count`)。
変換仕様:
- 行分割は `\n`。各行の [開始, 終了) offset を求める。
- **母数** = いずれかの関数 range と交差し、かつ空白のみ・コメント行でない行。
  コメント判定は素朴なスキャナ(`//` 行・`/* */` ブロック。**文字列リテラル内の
  `//` は誤検知しうるが判定式は「行の非空白先頭がコメント内か」なので、行頭以外の
  `//`〈例: svg-policy.js の `SVG_NS = "http://..."` 〉は無害**。危険なのは文字列内の
  `/*` — 対象 2 ファイルに無いことを Step 4 で機械確認し実測記録へ残す)。
- 行カバー済み = 交差する**最内(最小)range** の count > 0。
- 関数カバレッジ = `functionName != ""` の関数のうちトップ range count > 0 の割合
  (スクリプト全体を表す無名 range は母数から除外)。

単体は合成 JS(カバー済み関数 / 未カバー関数 / コメント行 / 空行 / 文字列内 `//`)へ
手組み functions を与え、期待値(例: 行 3/4 = 75.0・関数 1/2 = 50.0)を断言する 4〜6 ケース。
RED 確認 → Step 2 で GREEN。

- [ ] **Step 2: 変換器を実装(GREEN)**

`grapheditor_v8_coverage.py` に純関数で実装(~150-250 行)。docstring へ上記仕様。

- [ ] **Step 3: ゲートテスト(閾値は仮 0.0)**

```python
# =============================================================================
# test_zzz_grapheditor_coverage_gate.py — svg-policy / leader_geom のカバレッジゲート
# =============================================================================
# ファイル名の zzz は意図的: pytest の同一ディレクトリ収集はファイル名順のため、
# 単体移植テスト群の実行後にカバレッジを判定する（設計書 §4.3。旧 vitest 85% ゲートの
# 後継。閾値は新実装の実測値の直下へ校正して固定する）。
# ⚠ 部分実行（-k で単体を除外した場合等）では母数に対して実行が欠け偽赤になる。
# このゲートは全単体実行（既定収集）でのみ意味を持つ。
import os

import pytest

from grapheditor_v8_coverage import line_and_function_coverage

pytestmark = pytest.mark.browser

TARGETS = {
    "/js/svg-policy.js": ("svg-policy.js", 0.0, 0.0),
    "/lib/leader_geom.cjs": ("leader_geom.cjs", 0.0, 0.0),
}


def test_editor_js_coverage_gate(coverage_collector):
    result = coverage_collector.take()
    for suffix, (name, line_min, func_min) in TARGETS.items():
        matches = [sc for sc in result if sc["url"].endswith(suffix)]
        assert matches, f"{name} のカバレッジが無い(URL 経由で読込まれていない?)"
        assert len(matches) == 1, f"{name} が複数回読込まれている(母数が壊れる — 読込ガードの退行)"
        src_path = os.path.join(
            os.path.dirname(__file__), "..", "resources", "web",
            suffix.lstrip("/").replace("/", os.sep))
        source = open(src_path, encoding="utf-8").read()
        line_pct, func_pct = line_and_function_coverage(source, matches[0]["functions"])
        assert line_pct >= line_min, f"{name} 行カバレッジ {line_pct:.1f}% < {line_min}%"
        assert func_pct >= func_min, f"{name} 関数カバレッジ {func_pct:.1f}% < {func_min}%"
```

- [ ] **Step 4: 実測 → 校正 → 固定 + 前提の機械確認**

- 文字列内 `/*` の不存在確認(機械): 使い捨てスクリプトを scratchpad へ書いて実行する
  (`-c` ワンライナーは PowerShell の引用符入れ子で構文破綻するため不可)。内容:
  対象 2 ファイル(`js/svg-policy.js` / `lib/leader_geom.cjs`)を読み、正規表現で
  文字列リテラル(`"..."` / `'...'`・エスケープ考慮)を列挙し、その中に `/*` を含む
  ものが **0 件**であることを print する。両方 0 件を確認し実測記録へ。
- 実測: `py -3.13 -m pytest graph-editor -q` を仮閾値 0 で実行し、ゲートへ一時 print を
  足して行/関数 % を取得(取得後 print は除去)。
- **閾値 = 実測値 − 5 ポイント(小数切り捨て)**へ TARGETS を書き換えて固定。マージンの
  射程: Edge 版差等のゆらぎ吸収。**~10 行未満の小さな未実行追加は検出できない**(旧 85%
  固定も同等)— ゲートの主眼は denylist 化・大ブロック退行の検出で、細粒度の網は単体
  75 件そのもの。この割り切りをゲートの docstring へ 1 行追記。

- [ ] **Step 5: 退行検出力の確認(RED 実験)**

`py -3.13 -m pytest graph-editor -q -k "not svg_policy"` → ゲートが**赤**になることを確認
(svg-policy は煙テストの import で読込済み = URL は存在し、関数カバレッジが下がる形で
検出される)。確認後、通常実行で green へ戻ることも確認。

- [ ] **Step 6: コミット**

```powershell
git add graph-editor/test/grapheditor_v8_coverage.py graph-editor/test/test_grapheditor_v8_coverage_unit.py graph-editor/test/test_zzz_grapheditor_coverage_gate.py docs/superpowers/plans/2026-08-28-phase3-graph-editor-tests.md
git commit -m "test(graph-editor): CDP カバレッジゲートを実装し実測値で閾値を固定"
```

---

### Task 5: editor_server.py + E2E fixtures + E2E 移植 A(drag 3 + load_guards 6 + ops 6)

**Files:**
- Create: `graph-editor/test/editor_server.py`
- Modify: `graph-editor/test/conftest.py`(E2E fixtures 追加)
- Create: `graph-editor/test/test_grapheditor_e2e_drag.py`
- Create: `graph-editor/test/test_grapheditor_e2e_load_guards.py`
- Create: `graph-editor/test/test_grapheditor_e2e_ops.py`
- Modify: 対応表(15 行追記)

**Interfaces:**
- Consumes: Task 1 の `edge_browser`
- Produces: fixture `e2e_server`(session)/ `e2e_page`(**function** — context ごと毎テスト
  生成。旧 TS の per-test page と同型で route/listener/viewport の残存を排除)

- [ ] **Step 1: editor_server.py を書く**

```python
# =============================================================================
# editor_server.py — E2E 用の依存ゼロ静的サーバ(pytest fixture から起動)
# =============================================================================
# graph-editor/resources/web を配信する。防御ヘッダは app.py の SECURITY_HEADERS
# (タプル列)を直接 import して載せる(editor_server.mjs の逐語複製と違い drift しない)。
# `.cjs` の MIME は明示登録する: 既定の guess_type は .cjs を知らず octet-stream になり、
# nosniff 下で ui.html の classic script(lib/leader_geom.cjs)が実行拒否される。
# ポートは 0(ephemeral)で束縛し、実ポートを stdout の 1 行目で報告する(固定ポートは
# 居残りプロセスへの誤当たりを生む)。
import functools
import http.server
import importlib.util
import os

_APP_PATH = os.path.join(os.path.dirname(__file__), "..", "app.py")
_spec = importlib.util.spec_from_file_location("grapheditor_app", _APP_PATH)
_app = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_app)  # import 時に副作用が無いことは drift テストが保証している

WEB_ROOT = os.path.join(os.path.dirname(__file__), "..", "resources", "web")


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".cjs": "text/javascript",
        ".js": "text/javascript",
        ".mjs": "text/javascript",
    }

    def end_headers(self):
        for k, v in _app.SECURITY_HEADERS:
            self.send_header(k, v)
        super().end_headers()

    def log_message(self, *args):
        pass


def main():
    handler = functools.partial(Handler, directory=os.path.abspath(WEB_ROOT))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    print(f"listening on http://127.0.0.1:{server.server_address[1]}/", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: conftest へ E2E fixtures を追加**

```python
@pytest.fixture(scope="session")
def e2e_server():
    """editor_server.py を子プロセスで起動し、stdout の 1 行目から実ポートを得る。
    readline は起動失敗時に無限待ちになるため、番犬タイマーでプロセスを落として抜ける。"""
    import re
    import subprocess
    import sys
    import urllib.request

    proc = subprocess.Popen(
        [sys.executable, os.path.join(os.path.dirname(__file__), "editor_server.py")],
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    watchdog = threading.Timer(15, proc.kill)
    watchdog.start()
    try:
        line = proc.stdout.readline()
    finally:
        watchdog.cancel()
    m = re.search(r"http://127\.0\.0\.1:(\d+)/", line or "")
    assert m, f"サーバの起動行が読めない: {line!r}"
    base = f"http://127.0.0.1:{m.group(1)}"
    with urllib.request.urlopen(base + "/ui.html", timeout=5) as res:
        assert res.headers.get("Content-Security-Policy"), "防御ヘッダが載っていない"
        assert res.headers.get("X-Content-Type-Options") == "nosniff"
    try:
        yield base
    finally:
        proc.kill()
        proc.wait()


@pytest.fixture
def e2e_page(edge_browser, e2e_server):
    """E2E 用のページ。**テストごとに context から作り直す**（旧 TS の per-test page と
    同型。page.route のパッチ・dialog リスナ・viewport 変更をテスト間に持ち越さない）。"""
    context = edge_browser.new_context(base_url=e2e_server)
    page = context.new_page()
    yield page
    context.close()
```

- [ ] **Step 3: drag 3 / load_guards 6 / ops 6 を 1:1 移植**

正典 = 旧 `editor_drag.e2e.ts` / `editor_load_guards.e2e.ts` / `editor_ops.e2e.ts`。
- fixture SVG は Python 側で読み、旧 beforeEach の evaluate(`window.__editor` 経由の
  読込)を逐語で写す。EPS・参照実装関数(`clamp` 等)も逐語。
- `page.on("dialog", ...)` 等は e2e_page が毎テスト新規のため後始末不要(旧と同型)。
- 各ファイル `pytestmark = [pytest.mark.browser, pytest.mark.e2e]`。

Run: `py -3.13 -m pytest graph-editor -m e2e -v` → 15 passed。

- [ ] **Step 4: 対応表(15 行)・コミット**

```powershell
git add graph-editor/test/editor_server.py graph-editor/test/conftest.py graph-editor/test/test_grapheditor_e2e_drag.py graph-editor/test/test_grapheditor_e2e_load_guards.py graph-editor/test/test_grapheditor_e2e_ops.py docs/superpowers/plans/2026-08-28-phase3-mapping-graph-editor.md
git commit -m "test(graph-editor): E2E 15 件(drag/load_guards/ops)を playwright-python へ移植"
```

---

### Task 6: E2E 移植 B(sanitize 14 + capture_docs 5)

**Files:**
- Create: `graph-editor/test/test_grapheditor_e2e_sanitize.py`
- Create: `graph-editor/test/test_grapheditor_e2e_capture_docs.py`
- Create: `graph-editor/test/fixtures/capture_asset_balanced_8.svg`(下記)
- Modify: 対応表(19 行追記 → 計 109 行)

**Interfaces:**
- Consumes: Task 5 の `e2e_server` / `e2e_page`
- Produces: capture の Python 経路(出力は**一時ディレクトリ** — docs へは書かない)

- [ ] **Step 1: sanitize 14 件を 1:1 移植**

正典 = 旧 `editor_sanitize.e2e.ts`(**セキュリティガードの中核** — 断言の弱体化・ケース
省略は絶対にしない。悪性 SVG ペイロード・evaluate 文字列は逐語)。
- 旧 TS は `page.route("**/js/utils.js", ...)` で utils.js を差し替える箇所がある —
  sync API の `page.route`/`route.fulfill` で写す。**e2e_page が毎テスト新規のため
  unroute は不要**(旧と同じ暗黙リセット)。
- `page.on("request")` 等のリスナも同様に後始末不要。

- [ ] **Step 2: capture_docs 5 件を移植**

正典 = 旧 `capture_docs.e2e.ts`(png 6 枚 / 5 tests — 1 テストが 2 枚撮る)。
- **入力 SVG**: 旧は `pie-chart/out/svg_js/asset_balanced_8.svg`(git 非追跡の生成物 —
  クリーン環境・フェーズ 4 の新リポでは存在しない)。現物を
  `graph-editor/test/fixtures/capture_asset_balanced_8.svg` へ**複製してコミット**し、
  新 py テストはこちらを読む(旧 TS は変更しない。byte 同一の複製であることを
  `fc.exe` か Python で確認)。
- **viewport**: 旧の `test.use({viewport: {width: 1280, height: 820}})` は、この
  ファイル専用 fixture で写す:
  ```python
  @pytest.fixture
  def capture_page(edge_browser, e2e_server):
      context = edge_browser.new_context(base_url=e2e_server, viewport={"width": 1280, "height": 820})
      page = context.new_page()
      yield page
      context.close()
  ```
- **出力先**: `tmp_path` 配下(pytest 標準)へ撮る。断言 = 6 ファイルが生成され各
  サイズ > 0(+ 旧テストが個別に持つ断言があれば逐語)。**docs/graph-editor/images へは
  書かない**(理由は Architecture 節 — 新旧 capture の交互上書き防止。フェーズ 5 で
  出力先を docs へ切替える。この方針をテストの docstring と対応表の注記に明記)。

- [ ] **Step 3: 検証**

```powershell
py -3.13 -m pytest graph-editor -m e2e -q     # 34 passed
py -3.13 -m pytest graph-editor -q            # 単体側の全量(実測値。目安 = 178 + 変換器単体 4〜6 + ゲート 1 = 183〜185)
```

- [ ] **Step 4: 対応表・コミット**

```powershell
git add graph-editor/test/test_grapheditor_e2e_sanitize.py graph-editor/test/test_grapheditor_e2e_capture_docs.py graph-editor/test/fixtures/capture_asset_balanced_8.svg docs/superpowers/plans/2026-08-28-phase3-mapping-graph-editor.md
git commit -m "test(graph-editor): E2E 19 件(sanitize/capture)を playwright-python へ移植"
```

---

### Task 7: CI 組込とフェーズ 3 完了ゲート

**Files:**
- Modify: ルート `package.json`(`e2e:graph-editor:py` 追加 + `ci` へ組込)
- Modify: `scripts/ci-affected.mjs`(graph-editor 領域 stages へ追加 — 旧 `e2e:graph-editor`
  は stages に**既在**のため新 py 段のみ)+ `scripts/ci-affected.test.mjs`(期待値を
  **同一コミットで**追随)
- Modify: マスター計画(フェーズ 3 完了記録 + 「旧 TS E2E は ci に含まれない」の陳腐化
  記述の更新)

**Interfaces:**
- Consumes: Task 1-6 の全テスト
- Produces: 機械ゲート化された両輪検証

- [ ] **Step 1: package.json**

`"e2e:graph-editor:py": "python -m pytest graph-editor -m e2e"` を追加し、`ci` チェーンの
`test:graph-editor:py` の後へ ` && pnpm run e2e:graph-editor:py && pnpm run e2e:graph-editor`
を挿入(新 E2E + 旧 TS E2E。旧 vitest 単体は `test:coverage` の projects + 85% 閾値で
既に集約 CI に乗っている — 追加不要)。

- [ ] **Step 2: ci-affected + test 期待値(同一コミット)**

graph-editor 領域 stages へ `'e2e:graph-editor:py'` を追加。`ci-affected.test.mjs` の
deepEqual 期待値・段数表記を追随。

- [ ] **Step 3: 検証(フェーズ 3 完了ゲート = マスターの合成コマンド)**

PATH 再構成の上で、まず個別:
```powershell
pnpm run test:scripts
py -3.13 -m pytest graph-editor -q
py -3.13 -m pytest graph-editor -m e2e -q
pnpm run test:graph-editor          # 旧 vitest 75
pnpm run e2e:graph-editor           # 旧 TS E2E 34
```
次に**合成コマンドの通し**(マスターゲートの正: `pnpm run ci` は旧 85% カバレッジゲート
〈test:coverage〉・build・editor e2e・pdf-to-svg 両輪も含む):
```powershell
pnpm run ci
pnpm run e2e:graph-editor
pnpm run e2e:pdf-to-svg
```
> `pnpm run ci` は 15 分級でツールの背景実行 10 分上限を超える — **コントローラが
> デタッチプロセスで実行しログ監視する**(フェーズ 2 で確立した手順。実装サブエージェント
> はこのステップをコントローラへ返してよい)。
Expected: すべて green。

- [ ] **Step 4: 対応表 109 行完成・マスター更新・コミット**

マスターのフェーズ 3 行を「完了」へ + フェーズ 3 ゲート説明の「旧 TS E2E は ci に
含まれない」を現状(フェーズ 2/3 で ci 入り済み)へ更新。capture 再撮影の png 差分は
**発生しない**設計(一時 dir 出力)だが、旧 TS E2E の実行で出た場合は「再撮影」として
コントローラがコミット。
```powershell
git add package.json scripts/ci-affected.mjs scripts/ci-affected.test.mjs docs/superpowers/plans/2026-08-28-phase3-mapping-graph-editor.md docs/superpowers/plans/2026-08-28-python-repo-split-master.md
git commit -m "ci: graph-editor の Python E2E を ci / ci-affected へ組み込む(フェーズ 3 完了)"
```

---

## 実測記録(実行時に追記)

- カバレッジ実測値と固定閾値(svg-policy / leader_geom の行・関数)(Task 4): 単体 178 件
  +変換器単体 5 件を実行した状態で `test_zzz_grapheditor_coverage_gate.py` に一時 print
  を仕込んで計測した実測値は、`svg-policy.js` が行 97.4%(97.39583333333334%)・
  関数 100.0%、`leader_geom.cjs` が行 92.9%(92.85714285714286%)・関数 100.0%。
  「閾値 = 実測値 − 5 ポイント(小数切り捨て)」に従い、`svg-policy.js` は行 92.0% /
  関数 95.0%、`leader_geom.cjs` は行 87.0% / 関数 95.0% へ `TARGETS` を固定した
  (計測後は一時 print を除去済み)。
- 文字列内 `/*` 不存在の機械確認結果(Task 4): scratchpad の使い捨てスクリプト
  (`check_no_slash_star_in_strings.py`)で確認。素朴な正規表現版(`"..."`/`'...'` を
  そのまま拾うだけの実装)は、`svg-policy.js` の正規表現リテラル
  `/[;<>"'\\{}]/`(内部に `"` `'` を含む)を文字列の開始と誤認し、バックスラッシュ
  エスケープの解釈を巻き込んで本来の閉じ引用符をはるか先まで読み飛ばす誤検出が
  133 件中 4 件発生した(実測)。コメント・テンプレートリテラル・正規表現リテラルを
  読み飛ばす簡易スキャナへ書き直して再実行した結果、`svg-policy.js` は文字列リテラル
  140 件・`leader_geom.cjs` は 10 件で、いずれも `/*` を含むものは **0 件**
  (両ファイルとも確認済み)。
- ゲートの退行検出実験(Step 5)(Task 4): `py -3.13 -m pytest graph-editor -q -k
  "not svg_policy"` を実行すると、svg-policy 系の単体テストが 25 件 deselected される
  一方で `svg-policy.js` 自体は煙テスト(`test_grapheditor_js_smoke.py`)の import で
  読込済みのため URL は存在し、行カバレッジが 40.1%(40.10416666666667%)まで低下して
  `assert line_pct >= line_min` に失敗し、ゲートが**赤**になることを確認した
  (`svg-policy.js 行カバレッジ 40.1% < 92.0%` で 1 failed, 158 passed, 25 deselected)。
  続けて通常実行(`py -3.13 -m pytest graph-editor -q`)を行い、184 passed で green に
  戻ることを確認した。
- SECURITY_HEADERS の応答確認(CSP / nosniff): (Task 5 の fixture assert で機械化済み —
  初回green の事実を記録)
- E2E 移植中のハング/フレーク有無(pytest-timeout 条件の判定材料): (記入)
- capture 入力 SVG の複製が byte 同一であることの確認: (Task 6)
- 旧テストとの挙動差: (発生時のみ記入)
