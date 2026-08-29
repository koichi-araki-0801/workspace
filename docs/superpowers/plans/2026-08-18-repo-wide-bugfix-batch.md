# リポジトリ横断 既存バグ修正バッチ — 実装プラン

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 2026-08-18 のリポジトリ全体調査で確定した既存バグ 7 件（pdf-to-svg 2 / graph-editor 1 / CI 1 / offline 1 / claude-hooks 1 / pie-chart 1 / docs ビルド 1）を、それぞれ独立に検証可能な単位で修正する。

**Architecture:** 各 Task は独立したプロジェクト・ファイル群を触り、Task 間に依存はない（順序は優先度順）。修正はいずれも既存の設計原則（pdf-to-svg = コマンドパターン + model is truth / graph-editor = `STATE_FIELDS` 一元管理 / pie-chart = 決定的 SVG + baseline byte-diff / offline = 配列戻り値の `, @()` 規約）に沿った最小変更で、新しい仕組みは足さない。

**Tech Stack:** Python 3 + pytest（pdf-to-svg / docs）、素の JS + vitest（graph-editor）、TypeScript + vitest（pie-chart）、PowerShell + Pester（offline）、Node ESM（scripts / hooks）。

**Spec:** 本プラン冒頭の「調査結果（確定分）」節が仕様の代わり。各 Task の Step 1 で再現テストを先に書く。

## 調査結果（確定分）

| # | 場所 | 症状 |
|---|---|---|
| 1 | `pdf-to-svg/resources/web/app.js:394-398` | 手順3「削除した要素」の行ごと「戻す」が `rpc("undo")`（直近 1 件のグローバル取消）を呼ぶ。複数削除・別ページの削除があると無関係な操作を取り消す。加えて `removedList` は辞書折返し畳み込みで論理削除された後続行も一覧に出す |
| 2 | `pdf-to-svg/resources/web/app.js:773-785, 530` | `dictAdd` / `dictDelete` 後に `reloadState()` を呼ばず、`changed2`（要確認）が再計算されない |
| 3 | `graph-editor/resources/web/js/utils.js:185`, `editor.js:359-363` | `_auto`（自動/手動 leader 区別）が `STATE_FIELDS` 外で Undo/Redo/リセットに復元されない。`startLeaderDrag` はハンドル pointerdown だけで無履歴に `_auto=false` を確定 |
| 4 | `scripts/ci-affected.mjs:119-127` | `runFullCi()` が `ci:offline`（Pester）を含まない。`offline/` 変更 + 共有ファイル変更の同一 push で Pester が走らない。コメントの「`ci` は `check:claude-hooks` を含まない」は事実誤認 |
| 5 | `offline/lib/content-key.ps1:70` | git 失敗時の fallback 経路が bare statement で `, @()` を透過し、pipe 消費側で「要素 1 個 = 全パス配列」に潰れる（6eff8bc と同型） |
| 6 | `.claude/hooks/auto-push.cjs:16,29` | push 拒否（amend 後の分岐）時に理由不明の 1 行で終わり後続手順が分からない。commit 判定正規表現が `git commit-graph` に誤マッチ |
| 7 | `pie-chart/src/svg_export/mode_passes.ts:785-803` | `applyTopBandClusterReorder` の積み上げが「p.y = 上端」前提で前ラベル高を引くが、実描画規約（`geometry.ts:725`）は baseline='top' → p.y = 下端。高さの異なるラベル混在で間隔 = `prevH + minGap − nextH` になり重なり得る |
| 8 | `docs/_build/md2html.py:91,97` | front-matter の YAML 不正・`audience: yes` 等の非文字列で例外がファイル名なしに伝播し、どの原稿が悪いか分からない |

## Global Constraints

- コメント規約は `docs/コメント規約.md`（なぜを書く・日本語散文 + 英語ドメイン用語・経緯や所見番号は書かない・100 桁）。**チャット向けの圧縮文体をコード・コメント・コミットメッセージ・ドキュメントに持ち込まない。**
- pie-chart は SVG 出力の byte 不変が鉄則。座標が動く変更は `npm run batch` → `npm run batch:diff` の差分を目視確認したうえで `out/_baseline` と `final_score` / `render_hash` スナップショットを**同じコミットで**更新する。
- pdf-to-svg の pytest は `pdf-to-svg/` 直下で `python -m pytest`。graph-editor の vitest はルートで `pnpm run test:graph-editor`。pie-chart は `pnpm run test:pie-chart`。offline は `pnpm run ci:offline`。docs は `python -m pytest docs/_build`。
- 日本語を含む `.ps1` は UTF-8 BOM 必須。`.ps1` を新規追加する場合は同名 `.bat` も必須（本プランでは新規追加なし）。
- `.claude/` は git 追跡外（ローカル専用）。Task 6 の変更はコミットに乗らない。
- コミットメッセージは既存の流儀（`fix(<scope>): 日本語の要約` + 本文で理由）。コミット後は auto-push フックが動く。`editor/**` は触らないので biome 先行実行は不要。
- pdf-to-svg / pie-chart のドキュメント（`docs/<proj>/src/*.md`）を変えたら `python docs/_build/build_all.py --project <proj>` で HTML を再生成し同じコミットに含める。

---

### Task 1: pdf-to-svg 削除一覧の「戻す」を要素単位に直す

**Files:**
- Modify: `pdf-to-svg/src/web/commands.py:16-26`（`DeleteCommand` の直後に `RestoreCommand` を追加）
- Modify: `pdf-to-svg/src/web/rpc_methods.py:196-207`（`rpc_removedList` の折返し後続行の除外）、`:343-349` の直後（`rpc_restoreElements` 追加）、`:496-504`（`HANDLERS` 登録）
- Modify: `pdf-to-svg/resources/web/app.js:394-398`
- Test: `pdf-to-svg/test/test_web_rpc.py`（`test_apply_delete_and_removed_list` の直後に追加）
- Test: `pdf-to-svg/test/test_undo_stack.py` 末尾（`RestoreCommand` の undo/redo）
- Modify（docs）: `docs/pdf-to-svg/src/設計正典.md:43`（23 → 24 メソッド）、`docs/pdf-to-svg/src/設計書.md:567-576, 588`、`docs/pdf-to-svg/src/PdfToSvg_仕様一覧.md:67`（RPC 17 行に `restoreElements` を追記）

**Interfaces:**
- Produces:
  - `web.commands.RestoreCommand(elements: List[Element])` — `redo()` で `deleted=False`、`undo()` で `deleted=True`（`DeleteCommand` の鏡像）
  - RPC `restoreElements` args `{fileIndex, pageInFile, elIds: [int]}` → `{}`。`deleted=True` の要素だけを対象にし、対象なしなら push しない
  - RPC `removedList` は「live な TextElement の `dict_revert.extra_ids` に含まれる要素」を返さない（辞書折返し畳み込みで隠した行は「削除した要素」ではない）

- [ ] **Step 1: 失敗するテストを書く（RPC）**

`pdf-to-svg/test/test_web_rpc.py` の `test_apply_delete_and_removed_list` の直後に追加:

```python
def test_restore_elements_restores_only_the_requested_element(session):
    page = session.page(0, 0)
    hdr, body = page.elements[0], page.elements[1]
    # 2 回に分けて削除する (直近 1 件の undo では body しか戻らない状況を作る)
    rpc_methods.dispatch(session, "applyDelete",
                         {"fileIndex": 0, "pageInFile": 0, "elIds": [hdr.id]})
    rpc_methods.dispatch(session, "applyDelete",
                         {"fileIndex": 0, "pageInFile": 0, "elIds": [body.id]})
    assert hdr.deleted and body.deleted
    # 古い方 (hdr) だけを戻す
    rpc_methods.dispatch(session, "restoreElements",
                         {"fileIndex": 0, "pageInFile": 0, "elIds": [hdr.id]})
    assert hdr.deleted is False
    assert body.deleted is True  # 直近の削除は取り消されていない
    removed = rpc_methods.dispatch(session, "removedList", {"fileIndex": 0, "pageInFile": 0})
    assert [r["elId"] for r in removed["removed"]] == [body.id]
    # 戻しは Undo に乗る
    rpc_methods.dispatch(session, "undo", {})
    assert hdr.deleted is True


def test_restore_elements_ignores_live_or_unknown_ids(session):
    page = session.page(0, 0)
    body = page.elements[1]
    before = len(session.undo._stack)
    rpc_methods.dispatch(session, "restoreElements",
                         {"fileIndex": 0, "pageInFile": 0, "elIds": [body.id, 99999]})
    assert body.deleted is False
    assert len(session.undo._stack) == before  # 対象なしなら履歴を積まない


def test_removed_list_hides_lines_folded_by_dict_wrap(session):
    """辞書の折返し畳み込みで論理削除した後続行は「削除した要素」ではないので一覧に出さない。"""
    from model.elements import DictRevertInfo
    page = session.page(0, 0)
    hdr, body = page.elements[0], page.elements[1]
    body.deleted = True
    hdr.dict_revert = DictRevertInfo(text="Item", bbox=hdr.bbox, wrap_align=None,
                                     origin_y=hdr.origin_y, extra_ids=[body.id])
    removed = rpc_methods.dispatch(session, "removedList", {"fileIndex": 0, "pageInFile": 0})
    assert removed["removed"] == []
```

`pdf-to-svg/test/test_undo_stack.py` 末尾に追加:

```python
def test_restore_command_is_mirror_of_delete_command():
    from model.elements import Rect, TextElement
    from web.commands import RestoreCommand
    el = TextElement(bbox=Rect(0, 0, 10, 10), text="x", origin_x=0, origin_y=10)
    el.deleted = True
    stack = UndoStack()
    stack.push(RestoreCommand([el]))
    assert el.deleted is False
    stack.undo()
    assert el.deleted is True
    stack.redo()
    assert el.deleted is False
```

（`test_undo_stack.py` に `UndoStack` の import が無ければ先頭の既存 import に倣って追加する。）

- [ ] **Step 2: テストが失敗することを確認**

Run: `cd pdf-to-svg && python -m pytest test/test_web_rpc.py -k "restore_elements or folded_by_dict_wrap" test/test_undo_stack.py -k restore_command -v`
Expected: FAIL（`KeyError: 'restoreElements'` / `ImportError: RestoreCommand` / 一覧に body が残る）

- [ ] **Step 3: `RestoreCommand` を追加**

`pdf-to-svg/src/web/commands.py` の `DeleteCommand` 直後:

```python
class RestoreCommand:
    """論理削除した要素を再表示する (`DeleteCommand` の鏡像)。

    削除一覧の行ごとの「戻す」が使う。全体の Undo と違い、指定した要素だけを対象に
    するので、後から別の要素を削除していても巻き込まない。
    """

    def __init__(self, elements: List[Element]):
        self.elements = list(elements)

    def redo(self) -> None:
        for el in self.elements:
            el.deleted = False

    def undo(self) -> None:
        for el in self.elements:
            el.deleted = True
```

- [ ] **Step 4: RPC を追加し `removedList` から畳み込み行を除く**

`pdf-to-svg/src/web/rpc_methods.py`:

先頭の `from web.commands import ...` に `RestoreCommand` を足す。

`rpc_removedList` を次に置き換える:

```python
def rpc_removedList(s: WebSession, args: dict) -> dict:
    pg = s.page(args["fileIndex"], args["pageInFile"])
    # 辞書の折返し畳み込みで隠した後続行は利用者が削除したものではない。ここで戻せると
    # 連結済みテキストの下に旧 2 行目が再表示され、箇所単位の戻し (dict_revert) と食い違う。
    folded = set()
    for el in pg.elements:
        if isinstance(el, TextElement) and not el.deleted and el.dict_revert is not None:
            folded.update(el.dict_revert.extra_ids)
    removed = []
    for el in pg.elements:
        if not el.deleted or el.id in folded:
            continue
        label = _KIND_LABEL.get(el.kind, "要素")
        if isinstance(el, TextElement):
            snippet = el.text.strip()[:16]
            label = f"文字「{snippet}」" if snippet else "文字"
        removed.append({"elId": el.id, "kind": el.kind, "label": label})
    return {"removed": removed}
```

`rpc_applyDelete` の直後に追加:

```python
def rpc_restoreElements(s: WebSession, args: dict) -> dict:
    """削除一覧の行ごとの「戻す」。指定要素だけを再表示する (Undo 可)。

    グローバルな `undo` は直近 1 件しか戻せず、複数回に分けて削除した後や別ページで
    削除した後に押すと無関係な操作を取り消す。要素 id で対象を固定する。"""
    pg = s.page(args["fileIndex"], args["pageInFile"])
    ids = set(int(i) for i in args.get("elIds", []))
    els = [e for e in pg.elements if e.id in ids and e.deleted]
    if els:
        s.undo.push(RestoreCommand(els))
    return {}
```

`HANDLERS` の `"applyDelete": rpc_applyDelete,` の直後に `"restoreElements": rpc_restoreElements,` を追加。

- [ ] **Step 5: テストが通ることを確認**

Run: `cd pdf-to-svg && python -m pytest -q`
Expected: 全件 PASS

- [ ] **Step 6: UI を差し替える**

`pdf-to-svg/resources/web/app.js:394-398` を次に置き換える:

```javascript
    el.querySelectorAll("[data-restore]").forEach(function (b) {
      b.addEventListener("click", async function () {
        // 行の要素だけを戻す。全体の undo は直近 1 件しか戻せず、複数回に分けて削除した
        // 後や別ページで削除した後に押すと無関係な操作を取り消してしまう。
        await rpc("restoreElements", { fileIndex: pg.fileIndex, pageInFile: pg.pageInFile, elIds: [+b.dataset.restore] });
        await afterEdit();
      });
    });
```

（`pg` は同関数冒頭 `var pg = S.PAGES[S.page]` で束縛済みであることを確認する。無ければ `var pg = S.PAGES[S.page];` を `token` の直前に置く。）

- [ ] **Step 7: e2e で確認**

`pdf-to-svg/test/app_flow.e2e.ts` の「── 3.」節、2 度目の削除で「削除した要素（1）」を確認した直後に追加:

```typescript
  // 行ごとの「戻す」は直近の undo ではなく、その要素だけを戻す
  await page.locator("#trim-dyn [data-restore]").first().click();
  await expect(page.locator("#trim-dyn")).toContainText("削除した要素（0）");
  await page.locator('#trim-stage svg [data-el]', { hasText: "DeleteMe" }).click();
  await page.click("#btn-deletesel");
  await expect(page.locator("#trim-dyn")).toContainText("削除した要素（1）");
```

Run: `pnpm --filter pdf-to-svg exec playwright test`（プロジェクトの e2e 起動コマンドは `pdf-to-svg/package.json` の scripts を確認して使う）
Expected: PASS

- [ ] **Step 8: ドキュメント更新と HTML 再生成**

- `docs/pdf-to-svg/src/設計正典.md:43` の「`/rpc` 23 メソッド」→「24 メソッド」
- `docs/pdf-to-svg/src/設計書.md:567` 「全 23 メソッド」→「全 24 メソッド」、表の「編集」行を `applyDelete`, `deleteRegion`, `restoreElements`（削除一覧の行ごとの戻し）, `addBorder`, `undo`, `redo` に、`:588` の「実コマンドは 4 種」→「5 種」に `RestoreCommand`（`DeleteCommand` の鏡像。削除一覧の行ごとの戻し）を追記
- `docs/pdf-to-svg/src/PdfToSvg_仕様一覧.md:67` の 17 行目に `restoreElements` を追加（「削除 / 範囲削除 / 削除一覧の行ごとの戻し / 枠線」）
- Run: `python docs/_build/build_all.py --project pdf-to-svg`

- [ ] **Step 9: コミット**

```bash
git add pdf-to-svg/src/web/commands.py pdf-to-svg/src/web/rpc_methods.py pdf-to-svg/resources/web/app.js pdf-to-svg/test/test_web_rpc.py pdf-to-svg/test/test_undo_stack.py pdf-to-svg/test/app_flow.e2e.ts docs/pdf-to-svg/
git commit -m "fix(pdf-to-svg): 削除一覧の「戻す」を要素単位の restoreElements にし、直近の undo で無関係な操作を取り消さない"
```

---

### Task 2: pdf-to-svg 辞書登録・削除後に state を取り直す

**Files:**
- Modify: `pdf-to-svg/resources/web/app.js:530-533`（`dictDelete`）、`:773-785`（`dictAdd`）
- Test: `pdf-to-svg/test/app_flow.e2e.ts`

**Interfaces:**
- Consumes: 既存 `reloadState()`（`app.js:112`）。`applyState` が `changed2` を再計算し、`state.js` の状態機械が none→pending を立てる

- [ ] **Step 1: 失敗する e2e を書く**

`pdf-to-svg/test/app_flow.e2e.ts` 「── 2.」節で `#dict-add` をクリックした直後（`#btn-reapply` を押す前）に追加:

```typescript
  // 辞書に語を足しただけで、その語に当たるページは「要確認」に上がる (再適用の前でも)
  await expect(page.locator("#nav-hint")).toContainText("要確認 1");
```

- [ ] **Step 2: 失敗することを確認**

Run: e2e（Task 1 Step 7 と同じコマンド）
Expected: FAIL（`reloadState` が呼ばれず「要確認 0」のまま）

- [ ] **Step 3: `dictAdd` / `dictDelete` の後に `reloadState()` を呼ぶ**

`app.js:773-785` の `dict-add` ハンドラ末尾 `src.value = ""; tgt.value = ""; renderDict();` を次に:

```javascript
      pendingJoined = false;
      src.value = ""; tgt.value = ""; renderDict();
      // 登録した語に当たるページは「要確認」へ上がる。他の辞書操作 (再適用・戻す) と同じく
      // state を取り直さないと、確認済みのページに新語が当たっても案内バーが気付かない。
      await reloadState(); render();
```

`app.js:530-533` の `data-del` ハンドラを次に:

```javascript
      b.addEventListener("click", async function () {
        dictState = await rpc("dictDelete", { id: +b.dataset.del }); renderDict();
        await reloadState(); render();
      });
```

（`render` は `app.js` 内で他ハンドラが呼んでいる描画関数。同名で定義されていることを `grep -n "function render()"` で確認する。）

- [ ] **Step 4: e2e が通ることを確認**

Run: e2e
Expected: PASS（既存の「再適用後 要確認 1」の期待もそのまま通る）

- [ ] **Step 5: コミット**

```bash
git add pdf-to-svg/resources/web/app.js pdf-to-svg/test/app_flow.e2e.ts
git commit -m "fix(pdf-to-svg): 辞書の登録・削除の直後に state を取り直し、新語が当たるページを要確認へ上げる"
```

---

### Task 3: graph-editor `_auto` を `STATE_FIELDS` に含めて Undo/Redo/リセットに乗せる

**Files:**
- Modify: `graph-editor/resources/web/js/utils.js:185-195`
- Modify: `graph-editor/resources/web/js/label-state.js:61-64`（`_auto` 初期化が `initial = this.snapshot()` より前にあることを確認。現状はその順）
- Modify: `graph-editor/resources/web/js/editor.js:359-370`（`startLeaderDrag`）
- Test: `graph-editor/test/editor_state_fields.test.ts`

**Interfaces:**
- Produces: `STATE_FIELDS._auto = { copy: (v) => v, equals: (a, b) => a === b }`。`snapshot()` / `apply()` / `stateEquals` が自動追随

- [ ] **Step 1: 失敗するテストを書く**

`graph-editor/test/editor_state_fields.test.ts` の `baseState()` に `_auto: false,` を追加し、`VARIANTS` 末尾に:

```typescript
  ["_auto (自動 leader か)", mutate({ _auto: true })],
```

さらに `describe("stateEquals", ...)` 内に追加:

```typescript
  it("_auto は STATE_FIELDS に含まれ、snapshot/apply で往復する", () => {
    expect(Object.keys(STATE_FIELDS)).toContain("_auto");
    const snap = snapshot(mutate({ _auto: true }));
    expect(snap._auto).toBe(true);
    expect(stateEquals(mutate({ _auto: true }), snapshot(baseState()))).toBe(false);
  });
```

- [ ] **Step 2: 失敗することを確認**

Run: `pnpm run test:graph-editor -- editor_state_fields`
Expected: FAIL（`Object.keys(STATE_FIELDS)` に `_auto` が無い）

- [ ] **Step 3: `STATE_FIELDS` に `_auto` を追加**

`graph-editor/resources/web/js/utils.js:194` の `nameScaleX` 行の直後:

```javascript
  // 自動 leader (位置駆動で生成・円内で除去) か手動 leader かの区別。leaderPts と対で
  // 復元しないと、Undo 後に自動分が消せなくなる / 手動分が位置ルールに上書きされる。
  _auto: { copy: (v) => v, equals: (a, b) => a === b },
```

- [ ] **Step 4: `startLeaderDrag` の `_auto=false` を実移動の中へ移す**

`graph-editor/resources/web/js/editor.js:359-370` を次に:

```javascript
  startLeaderDrag(evt, s, index) {
    evt.preventDefault();
    evt.stopPropagation();
    this.selectLabel(s);
    const ptStart = { ...s.leaderPts[index] };

    this.onDrag(evt, (dx, dy) => {
      // 実際に動かしてから手動扱いにする (onDrag は最初の移動で pushHistory するので、
      // ここで変えれば履歴に乗る)。pointerdown だけで確定すると、触れただけの自動 leader が
      // 無履歴で手動へ落ちて位置ルールから外れる。
      s._auto = false;
      s.leaderPts[index] = { x: ptStart.x + dx, y: ptStart.y + dy };
      this.markDirty({ dom: true, overlay: true });
    });
  }
```

- [ ] **Step 5: テストが通ることを確認**

Run: `pnpm run test:graph-editor && pnpm run typecheck:graph-editor`
Expected: PASS

- [ ] **Step 6: E2E で退行が無いことを確認**

Run: `pnpm --filter graph-editor run test:e2e`
Expected: PASS（`docs/graph-editor/images/` の再撮影差分が出たら「再撮影」として同コミットに含める）

- [ ] **Step 7: コミット**

```bash
git add graph-editor/resources/web/js/utils.js graph-editor/resources/web/js/editor.js graph-editor/test/editor_state_fields.test.ts docs/graph-editor/images/
git commit -m "fix(graph-editor): 自動 leader の印 _auto を STATE_FIELDS に含め、Undo/Redo/リセットとドラッグ履歴に乗せる"
```

---

### Task 4: `ci-affected` のフル CI フォールバックに `ci:offline` を含める

**Files:**
- Modify: `scripts/ci-affected.mjs:118-126`（`runFullCi`）
- Modify: `package.json:37`（`test:scripts`）
- Create: `scripts/ci-affected.test.mjs`

**Interfaces:**
- Produces: `runFullCi()` は `ci` の後に `ci:offline` を実行する。`--all --dry-run` の出力にその計画が出る

- [ ] **Step 1: 失敗するテストを書く**

`scripts/ci-affected.test.mjs`（`scripts/clean.test.mjs` と同じ `node --test` 流儀）:

```javascript
// =============================================================================
// ci-affected.test.mjs — フル CI フォールバックの実行計画を固定する
// =============================================================================
// `ci`(package.json)は GitHub Actions(ubuntu)でも走るため Windows 限定の `ci:offline`
// (Pester)を含められない。ローカルの pre-push が唯一の Pester ゲートなので、フル CI へ
// 倒れる経路でも `ci:offline` が計画に入っていることを dry-run の出力で確認する。
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('--all --dry-run のフル CI 計画に ci と ci:offline が並ぶ', () => {
  const out = execFileSync(process.execPath, [join(ROOT, 'scripts', 'ci-affected.mjs'), '--all', '--dry-run'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  const lines = out.split('\n').filter((l) => l.includes('(dry-run) pnpm run '));
  assert.ok(lines.some((l) => l.endsWith('pnpm run ci')), out);
  assert.ok(lines.some((l) => l.endsWith('pnpm run ci:offline')), out);
});
```

`package.json:37` を `"test:scripts": "node --test scripts/clean.test.mjs scripts/ci-affected.test.mjs",` に。

- [ ] **Step 2: 失敗することを確認**

Run: `pnpm run test:scripts`
Expected: FAIL（`ci:offline` が出力に無い）

- [ ] **Step 3: `runFullCi` を直す**

`scripts/ci-affected.mjs:118-126` を次に:

```javascript
function runFullCi(reason) {
  console.log(`\n[ci:affected] ${reason} → フル \`ci\` を実行します。`);
  runPnpm('ci');
  // `ci` は GitHub Actions(ubuntu)と共用のため Windows 限定の Pester(`ci:offline`)を
  // 含められない。ローカルの pre-push はその唯一のゲートなので、フル CI へ倒れる経路でも
  // 取りこぼさないようここで続けて走らせる(offline/ 変更 + 共有ファイル変更が同じ push に
  // 混ざると、領域別の発火だけでは Pester が一度も走らない)。
  runPnpm('ci:offline');
  if (!DRY) console.log('\n[ci:affected] フル ci 完了。');
  process.exit(0);
}
```

（従来あった `runPnpm('check:claude-hooks')` は `ci` 自身が既に含むため削除する。）

- [ ] **Step 4: 通ることを確認**

Run: `pnpm run test:scripts && node scripts/ci-affected.mjs --all --dry-run`
Expected: PASS。dry-run 出力に `pnpm run ci` と `pnpm run ci:offline` が並ぶ

- [ ] **Step 5: コミット**

```bash
git add scripts/ci-affected.mjs scripts/ci-affected.test.mjs package.json
git commit -m "fix(ci): フル CI フォールバックでも ci:offline (Pester) を実行し、offline/ の検査が抜ける経路を塞ぐ"
```

---

### Task 5: `content-key.ps1` の fallback 経路でも配列を 1 要素ずつ流す

**Files:**
- Modify: `offline/lib/content-key.ps1:63-71`（`Get-OfflineRequirementsFiles`）
- Test: `offline/lib/verify.Tests.ps1:47-67`（`Describe 'Get-OfflineRequirementsFiles'` に追加）

**Interfaces:**
- Consumes: `Get-OfflineRequirementsFilesViaGit` / `Get-OfflineRequirementsFilesViaFileSystem`（いずれも `, @(...)` で返す）

- [ ] **Step 1: 失敗する Pester テストを書く**

`offline/lib/verify.Tests.ps1` の `Describe 'Get-OfflineRequirementsFiles'` ブロック末尾に追加:

```powershell
  It 'pipe 経由でも 1 パス = 1 要素で流れる（git 経路）' {
    $count = @(Get-OfflineRequirementsFilesViaGit -RepoRoot $repoRoot).Count
    $piped = @(Get-OfflineRequirementsFiles -RepoRoot $repoRoot | Where-Object { $_ -is [string] })
    $piped.Count | Should Be $count
  }

  It 'pipe 経由でも 1 パス = 1 要素で流れる（git 失敗時のファイルシステム経路）' {
    Mock Get-OfflineRequirementsFilesViaGit { $null }
    $count = @(Get-OfflineRequirementsFilesViaFileSystem -RepoRoot $repoRoot).Count
    $piped = @(Get-OfflineRequirementsFiles -RepoRoot $repoRoot | Where-Object { $_ -is [string] })
    $piped.Count | Should Be $count
  }
```

- [ ] **Step 2: 失敗することを確認**

Run: `pnpm run ci:offline`
Expected: 2 つ目の It が FAIL（`$piped.Count` が 0。内側の配列がそのまま 1 要素として流れ `-is [string]` で落ちる）

- [ ] **Step 3: fallback を変数経由の `return` にする**

`offline/lib/content-key.ps1:63-71` を次に:

```powershell
function Get-OfflineRequirementsFiles {
  param([Parameter(Mandatory = $true)][string]$RepoRoot)
  # 呼び出し先は単数要素のスカラー化を防ぐため `, @(...)` で返す。それを変数で受けてから
  # `return` すると外側の 1 段だけ剥がれて 1 パス = 1 要素で流れる。関数呼び出しを
  # bare statement で素通しすると内側の配列がそのまま 1 要素として出力へ透過し、pipe 経由の
  # 消費側で「要素 1 個 = 全パスの配列」に潰れる (git 経路・ファイルシステム経路とも同じ)。
  $viaGit = Get-OfflineRequirementsFilesViaGit -RepoRoot $RepoRoot
  if ($null -ne $viaGit) { return $viaGit }
  $viaFileSystem = Get-OfflineRequirementsFilesViaFileSystem -RepoRoot $RepoRoot
  return $viaFileSystem
}
```

（ファイル先頭の UTF-8 BOM を落とさないこと。エディタで保存後 `Format-Hex offline/lib/content-key.ps1 | Select-Object -First 1` で `EF BB BF` を確認する。）

- [ ] **Step 4: 通ることを確認**

Run: `pnpm run ci:offline`
Expected: 全件 PASS

- [ ] **Step 5: コミット**

```bash
git add offline/lib/content-key.ps1 offline/lib/verify.Tests.ps1
git commit -m "fix(offline): Get-OfflineRequirementsFiles のファイルシステム経路でも配列を 1 要素ずつ返す"
```

---

### Task 6: `auto-push.cjs` の push 拒否時の案内と commit 判定の誤マッチ

**Files:**
- Modify: `.claude/hooks/auto-push.cjs`（git 追跡外・ローカル専用）
- Modify: `C:\Users\caads\workspace\CLAUDE.md`「コミット / push フック」の auto-push 行（git 追跡外）

**Interfaces:**
- 変更なし（フックの入出力契約は同じ。exit 0 のまま）

方針: フックが自動で `--force-with-lease` を打つ形にはしない（amend 判定を誤ると他人の push を潰す。post-commit フックの中で強制 push は不可逆性が高い）。拒否されたときに**理由と次の一手を stderr に出す**にとどめ、CLAUDE.md の記述を「手動で行う」と明記する。

- [ ] **Step 1: 手で再現する**

```bash
git log --oneline -1   # 現在の HEAD を控える
echo '{"tool_input":{"command":"git commit-graph write"}}' | node .claude/hooks/auto-push.cjs
```
Expected（現状）: `[auto-push] ...` が出て push を試みる（誤マッチ）。修正後は何も出ない。

- [ ] **Step 2: 正規表現と拒否時メッセージを直す**

`.claude/hooks/auto-push.cjs` を次に置き換える:

```javascript
// PostToolUse hook: git commit を実行したら、その直後に現在ブランチを upstream へ push する。
// stdin で PostToolUse イベント JSON を受け取り、tool_input.command に git commit が
// 含まれる場合のみ push する。失敗は致命にせず stderr に報告して exit 0。
//
// 履歴を amend した後はリモートが古い同内容コミットのまま分岐するため通常の push は拒否
// される。ここで自動的に force push はしない (amend の判定を誤ると他人の push を潰し、
// commit フックの中では取り消せない)。拒否の理由と手動の一手を出すにとどめる。
const { execSync } = require("node:child_process");

let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  let cmd = "";
  try {
    cmd = JSON.parse(input || "{}")?.tool_input?.command ?? "";
  } catch {
    process.exit(0);
  }
  // git commit を含むコマンド以外はスキップ。`commit-graph` 等のサブコマンドは末尾の
  // 否定先読みで除く (`\b` だけだと `-` が語境界になり誤マッチする)。
  if (!/\bgit\b[^\n|&;]*\bcommit(?![-\w])/.test(cmd)) process.exit(0);

  const run = (c) => execSync(c, { stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
  try {
    let hasUpstream = false;
    try {
      run("git rev-parse --abbrev-ref --symbolic-full-name @{u}");
      hasUpstream = true;
    } catch {
      // upstream 未設定（新規ブランチ）→ 下で -u origin HEAD を付けて初回 push する
    }
    const out = hasUpstream ? run("git push") : run("git push -u origin HEAD");
    console.error(`[auto-push] ${out || "done"}`);
  } catch (e) {
    const msg = String(e.stderr || e.message).trim();
    console.error(`[auto-push] skipped: ${msg}`);
    if (/non-fast-forward|rejected|fetch first/i.test(msg)) {
      console.error(
        "[auto-push] リモートと分岐しています。直前に amend した場合はツリーの一致を確認のうえ" +
          " `git push --force-with-lease` を手動で実行してください。",
      );
    }
  }
  process.exit(0);
});
```

- [ ] **Step 3: 構文検査と再現**

Run: `pnpm run check:claude-hooks && echo '{"tool_input":{"command":"git commit-graph write"}}' | node .claude/hooks/auto-push.cjs`
Expected: `OK: auto-push.cjs`。2 つ目は何も出力しない

- [ ] **Step 4: CLAUDE.md の記述を実装に合わせる**

`CLAUDE.md`「コミット / push フック」の auto-push 行を次に:

```markdown
- **auto-push**（`.claude/hooks/auto-push.cjs`）: commit 後に現ブランチを origin へ push。
  履歴を amend した場合はリモートが古い同内容コミットのまま分岐して push が拒否される
  （フックは自動で force push しない）。その場合はツリー一致を確認のうえ**手動で**
  `git push --force-with-lease` を実行する。
```

- [ ] **Step 5: 完了確認**

`.claude/` と `CLAUDE.md` は git 追跡外のためコミットなし。`git status --short` で両ファイルが表示されないことを確認する。

---

### Task 7: pie-chart `applyTopBandClusterReorder` の積み上げを baseline 規約に合わせる

**Files:**
- Modify: `pie-chart/src/svg_export/mode_passes.ts:695-712`（docstring）、`:785-803`（積み上げループ）
- Test: 既存 `pie-chart/test/final_score.test.ts` / `render_hash.test.ts` のスナップショットと `out/_baseline`

**Interfaces:**
- 変更なし（関数シグネチャ不変）

背景: `geometry.ts:725` と同ファイル `pushUpToClearPie` の規約は「baseline='top' → `p.y` は text の**下端**（pie 座標で最小 y）」。積み上げループは「`p.y` = 上端」前提で前ラベルの高さを引くため、高さが違うラベルが並ぶと間隔が `prevH + minGap − curH` になる。

- [ ] **Step 1: 現状の出力を固定する**

Run: `cd pie-chart && npm run batch && npm run batch:diff`
Expected: `out/_baseline` と全件一致（差分 0）。ここで差分があれば作業前の状態が汚れているので止める。

- [ ] **Step 2: 積み上げ式と docstring を直す**

`mode_passes.ts:785-803` を次に:

```typescript
  // baseline=top 規約 (pushUpToClearPie / geometry.ts と同じ): p.y は text の下端 (pie 座標で
  // 最小 y)。ラベル i の占有は [p.y, p.y + h_i]。次ラベルの上端 = 現ラベル下端 − minGap なので、
  // 次ラベルの p.y (下端) = 現下端 − minGap − 次ラベルの高さ。前ラベルの高さを引くと高さが違う
  // 隣り合わせで間隔が prevH + minGap − curH になり、背の高いラベルが直前に食い込む。
  // baseline=bottom (内側等) の場合は y を中央扱いとし、height で上下に伸びる近似で同様処理。
  const heightOf = (p: Placement): number =>
    p.measured?.height ?? cfg.fontSizeUnits * cfg.lineHeightFactor;
  let currentBottom = topY;
  for (let i = 0; i < sorted.length; i += 1) {
    const p = sorted[i];
    if (i === 0) {
      p.y = currentBottom;
    } else {
      currentBottom = currentBottom - minGap - heightOf(p);
      p.y = currentBottom;
    }
    pushUpToClearPie(p);
    clampPlacement(p);
    // p.y が pie 侵入回避で上方向に動いた場合、次ラベルの起点も追随させる
    currentBottom = p.y;
  }
```

docstring（`:704-707`）の 3 行を次に:

```typescript
 * Y 計算は pie 座標 (Y 大 = 視覚的上)。baseline=top は SVG `text-after-edge` で、p.y は text の
 * **下端** (占有は [p.y, p.y + h])。次ラベルの下端 = 現ラベル下端 − gap − 次ラベルの高さ。
 *  - baseline=bottom: text の上端が p.y。これは内側等で稀なので、cascade の y を維持
```

その後 `bottom` メンバー（同関数の後続、`clusterTopBandBottom` を積む箇所）も同じ前提で書かれていないか読み、前ラベル高を引いている箇所があれば同じ形（`minGap + heightOf(cur)`）へ揃える。

- [ ] **Step 3: 差分を測る**

Run: `cd pie-chart && pnpm run test:pie-chart` （ルートなら `pnpm run test:pie-chart`）と `npm run batch && npm run batch:diff`
Expected: 次のいずれか
  - (a) 差分 0・スナップショット一致 → 発火サンプル `pdf_510037_01_fund_country` の cluster が同高のみ（またはリフト再配分で吸収）で、修正は理論整合のみ。Step 5 へ。
  - (b) `pdf_510037_01_fund_country` だけが変わる → Step 4 へ。
  - (c) それ以外のサンプルも変わる → 退行。修正を見直す（`applyTopBandClusterReorder` は topBandClusterMode 1 件でしか走らないはず。`mark_flags` スナップショットで発火サンプルを再確認）。

- [ ] **Step 4: (b) の場合のみ: 目視確認と baseline 更新**

`pie-chart/README.md`「検証」節の手順で変更前後の SVG を並べて見る（Playwright スクリーンショット）。積み上げ間隔が均等になり重なりが消えていることを確認したうえで:

Run: `cd pie-chart && npm run batch:accept`（無ければ `out/_baseline` へ当該サンプルの SVG をコピー）と `pnpm run test:pie-chart -- -u`
Expected: baseline / `final_score.test.ts.snap` / `render_hash.test.ts.snap` が当該サンプル分だけ更新される。`git diff --stat` で他サンプルが動いていないことを確認する。

- [ ] **Step 5: コミット**

```bash
git add pie-chart/src/svg_export/mode_passes.ts pie-chart/out/_baseline pie-chart/test/__snapshots__
git commit -m "fix(pie-chart): topBand クラスタの積み上げで次ラベルの高さを引き、baseline=top の下端規約に揃える"
```

（(a) の場合は `mode_passes.ts` のみ add する。）

---

### Task 8: `md2html.py` の front-matter エラーにファイル名を付け、`audience` の非文字列を受ける

**Files:**
- Modify: `docs/_build/md2html.py:85-100`
- Test: `docs/_build/test_md2html.py`

**Interfaces:**
- Produces: `parse_frontmatter(text, src_name="")` — YAML 不正時に `ValueError(f"{src_name}: front-matter の YAML が不正です: {e}")` を投げる。`audience_of` は `audience: yes` のような bool を `str()` して名前推定へ倒す

方針: 壊れた front-matter は**失敗のまま**にする（黙って冊子を出さない）。直すのは「どの原稿が悪いか分からない」ことだけ。

- [ ] **Step 1: 失敗するテストを書く**

`docs/_build/test_md2html.py` 末尾に追加:

```python
def test_parse_frontmatter_names_the_source_on_invalid_yaml():
    import pytest
    bad = "---\ntitle: [unclosed\n---\nbody\n"
    with pytest.raises(ValueError, match=r"^設計書\.md: front-matter"):
        md2html.parse_frontmatter(bad, src_name="設計書.md")


def test_audience_of_tolerates_yaml_bool_value(tmp_path):
    src = tmp_path / "設計書.md"
    # YAML は `yes` を bool にする。文字列として扱えず落ちるのではなく名前推定へ倒す
    assert md2html.audience_of(src, {"audience": True}) == "spec"
    assert md2html.audience_of(tmp_path / "操作手順書.md", {"audience": True}) == "guide"
```

- [ ] **Step 2: 失敗することを確認**

Run: `python -m pytest docs/_build/test_md2html.py -k "invalid_yaml or yaml_bool" -v`
Expected: FAIL（`TypeError: unexpected keyword src_name` / `AttributeError: 'bool' object has no attribute 'strip'`）

- [ ] **Step 3: 実装**

`docs/_build/md2html.py:85-100` を次に:

```python
def parse_frontmatter(text: str, src_name: str = ""):
    """先頭 `---` ブロックを front-matter として解釈し、`(meta, body)` を返す。

    PyYAML ベースの `python-frontmatter` で読む。改訂履歴 `rev` は原稿側で YAML の
    ブロックシーケンス（`rev:` + `- 版 | 日付 | 内容`）として書き、複数版を list で受ける。
    YAML が壊れていれば失敗のまま止める（黙って冊子を出さない）が、複数原稿を束ねる
    ビルドではどの原稿かが分からないと直せないので、ファイル名を付けて投げ直す。
    """
    try:
        post = frontmatter.loads(text)
    except yaml.YAMLError as e:
        raise ValueError(f"{src_name}: front-matter の YAML が不正です: {e}") from e
    return dict(post.metadata), post.content


def audience_of(src: pathlib.Path, meta: dict | None) -> str:
    """原稿の読者区分を返す（'guide' | 'spec'）。front-matter `audience` 優先、無指定は名前推定。"""
    # YAML は `yes` / `on` を bool にする。文字列以外は指定なしと同じ扱いで名前推定へ倒す。
    raw = (meta or {}).get("audience")
    aud = raw.strip().lower() if isinstance(raw, str) else ""
    if aud in ("guide", "spec"):
        return aud
    return "guide" if ("操作手順書" in src.name or "利用手引き" in src.name) else "spec"
```

ファイル先頭の import に `import yaml` を追加（既に PyYAML は依存にある。`requirements.txt` は変更不要）。

`build_project`（`:719`）の呼び出しを `meta, body = parse_frontmatter(text, src.name)` に。

- [ ] **Step 4: 通ることを確認**

Run: `python -m pytest docs/_build -q && python docs/_build/build_all.py`
Expected: PASS。全プロジェクトの HTML が従来どおり生成される（`git status` で HTML に差分が出ないこと。出たら中身を見て、front-matter 解釈が変わっていないか確認する）

- [ ] **Step 5: コミット**

```bash
git add docs/_build/md2html.py docs/_build/test_md2html.py
git commit -m "fix(docs): front-matter の YAML 不正にファイル名を付けて失敗させ、audience の bool 値で落ちないようにする"
```

---

## 見送り（本プランに含めない）

- pdf-to-svg 辞書チェーン（A→B→C）後の「戻す」で畳み込み行が復元不能になる件: 辞書に「置換後の語」がさらに別の語へ登録されている場合のみ。UX 判断（戻すを 1 段ずつにするか元まで戻すか）が要るため別途相談。
- pdf-to-svg `_apply_plans` の `try/finally`: 現行コマンドは属性代入のみで例外経路が無い。
- pie-chart DB 入力の行数事前上限（xlsx との非対称）: 仕様判断が要る。
- editor `draftFiles.ts` / `templateFiles.ts` のカバレッジ include 追加: 個別テストは存在。閾値ゲートへの追加は `pnpm run test:coverage` の閾値到達を確認してから。
- `comment-convention-reminder.cjs` の `.bat` / `.md` 対象化: リマインドのみで CI 検査（`check:comments`）は既に両拡張子を見ている。
