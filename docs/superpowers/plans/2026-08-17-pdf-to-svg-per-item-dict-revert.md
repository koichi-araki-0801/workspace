# PdfToSvg 辞書置換の箇所単位 戻し / 単件適用 — 実装プラン

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 確認一覧（手順 2）から辞書置換を 1 箇所ずつ戻す・1 箇所だけ置換する。同じ語が複数あっても番号マーカーで場所が分かる。

**Architecture:** 置換前状態を要素自身（`TextElement.dict_revert`）に持たせ、Undo 可能な `RevertDictMatchCommand` で戻す。戻しはその場限り（再適用でまた当たる）。RPC 2 本（`revertDictMatch` / `applyDictMatch`）と `planPage` の拡張（`state`）で UI に繋ぎ、UI は行番号と SVG 内の番号マーカー・ホバー強調で場所を示す。

**Tech Stack:** Python 3（標準ライブラリ・dataclass）、pytest、素の JS（ES module）、Playwright（e2e）。

**Spec:** `docs/superpowers/specs/2026-08-17-pdf-to-svg-per-item-dict-revert-design.md`

## Global Constraints

- 作業ディレクトリは `pdf-to-svg/`。pytest は `pdf-to-svg/` 直下で `python -m pytest`（`test/` の `test_*.py`）。
- コメント規約は `docs/コメント規約.md`（なぜを書く・日本語散文 + 英語ドメイン用語・経緯や所見番号は書かない）。
- 番号マーカーは表示用 DOM にだけ挿入し、書き出し SVG（`exportSvg`）には入れない。
- Undo スタック（`web/undo_stack.py`）の構造は変更しない。
- `/rpc` の JSON はそのまま `innerHTML` に入れない（`esc()` を通す）。既存 `renderConfirm` の書き方に従う。
- コミットメッセージは既存の流儀（`feat(pdf-to-svg): …` の日本語）。コミット後は auto-push フックが動く。

---

### Task 1: モデル `DictRevertInfo` / `dict_revert` と `ReplaceTextCommand` の復元情報書き込み

**Files:**
- Modify: `pdf-to-svg/src/model/elements.py:105-140`
- Modify: `pdf-to-svg/src/web/commands.py:46-88`
- Create: `pdf-to-svg/test/test_dict_revert.py`

**Interfaces:**
- Produces:
  - `model.elements.DictRevertInfo(text: str, bbox: Rect, wrap_align: Optional[str], origin_y: float, extra_ids: List[int])`
  - `TextElement.dict_revert: Optional[DictRevertInfo] = None`
  - `ReplaceTextCommand.__init__(..., extras: Optional[List[TextElement]] = None)`（末尾に追加。既存呼び出しは無改変で動く）

- [ ] **Step 1: 失敗するテストを書く**

```python
# pdf-to-svg/test/test_dict_revert.py
"""辞書置換の箇所単位の戻し: 復元情報 (`dict_revert`) と `RevertDictMatchCommand`。"""
from model.elements import DictMatch, DictRevertInfo, Rect, TextElement
from web.commands import ReplaceTextCommand
from web.undo_stack import UndoStack


def _text(s, x, oy, size=12.0, w=20.0):
    return TextElement(bbox=Rect(x, oy - size, w, size), text=s, font_size=size,
                       origin_x=x, origin_y=oy)


def test_replace_command_records_revert_info_and_undo_clears_it():
    el = _text("Item No.", 10, 20, w=40)
    cmd = ReplaceTextCommand(el, "品番", DictMatch(source="Item No.", target="品番"))
    stack = UndoStack()
    stack.push(cmd)
    assert el.text == "品番"
    assert el.dict_revert == DictRevertInfo(
        text="Item No.", bbox=Rect(10, 8, 40, 12), wrap_align=None, origin_y=20, extra_ids=[]
    )
    stack.undo()
    assert el.text == "Item No." and el.dict_revert is None
    stack.redo()
    assert el.dict_revert is not None and el.dict_revert.text == "Item No."


def test_replace_command_records_extras_for_wrapped_group():
    top = _text("商品", 50, 40)
    bottom = _text("名称", 50, 52)
    cmd = ReplaceTextCommand(
        top, "Product", DictMatch(source="商品名称", target="Product"),
        new_bbox=Rect(50, 28, 20, 24), wrap_align="left", baseline_y=52.0, extras=[bottom],
    )
    cmd.redo()
    assert top.dict_revert.extra_ids == [bottom.id]
    assert top.dict_revert.bbox == Rect(50, 28, 20, 12) and top.dict_revert.origin_y == 40


def test_text_element_defaults():
    el = _text("x", 0, 10)
    assert el.dict_revert is None
```

- [ ] **Step 2: 失敗を確認**

Run: `cd pdf-to-svg && python -m pytest test/test_dict_revert.py -v`
Expected: FAIL — `ImportError: cannot import name 'DictRevertInfo'`

- [ ] **Step 3: モデルを追加**

`pdf-to-svg/src/model/elements.py` の `DictMatch` の直後に追加し、`TextElement` にフィールドを足す:

```python
@dataclass
class DictRevertInfo:
    """辞書置換を 1 箇所だけ戻すための置換前状態。

    置換コマンドは Undo マクロの中に埋まっていて個別には辿れず、Undo 深さ上限で
    捨てられもするため、復元元は要素自身が持つ。`extra_ids` は折返し畳み込みで
    論理削除した後続行の id (戻すときに再表示する)。
    """

    text: str
    bbox: Rect
    wrap_align: Optional[str]
    origin_y: float
    extra_ids: List[int] = field(default_factory=list)
```

`TextElement` の `wrap_align` の下に:

```python
    # 置換が当たっている間だけ持つ復元情報 (箇所単位の「戻す」用)。None = 未置換。
    dict_revert: Optional[DictRevertInfo] = None
```

`from typing import List, Optional` が無ければ追加。

- [ ] **Step 4: `ReplaceTextCommand` に復元情報の書き込みを足す**

`pdf-to-svg/src/web/commands.py`:

```python
from model.elements import DictMatch, DictRevertInfo, Element, Rect, TextElement


class ReplaceTextCommand:
    def __init__(
        self,
        el: TextElement,
        new_text: str,
        dict_match: Optional[DictMatch] = None,
        new_bbox: Optional[Rect] = None,
        wrap_align: Optional[str] = None,
        baseline_y: Optional[float] = None,
        extras: Optional[List[TextElement]] = None,
    ):
        self.el = el
        self.new_text = new_text
        self.dict_match = dict_match
        # 折返し畳み込み時に結合テキストを据え直す合成領域と据え方 (`dictionary/apply.py`
        # の `Replacement.new_bbox` / `align` / `baseline_y`)。None なら変更しない。
        self.new_bbox = new_bbox
        self.wrap_align = wrap_align
        self.baseline_y = baseline_y
        self.old_text = el.text
        self.old_match = el.dict_match
        self.old_bbox = el.bbox
        self.old_wrap_align = el.wrap_align
        self.old_origin_y = el.origin_y
        self.old_revert = el.dict_revert
        # 箇所単位の「戻す」が復元に使う置換前状態。後続行 (extras) は id で持つ。
        self.revert_info = DictRevertInfo(
            text=el.text, bbox=el.bbox, wrap_align=el.wrap_align, origin_y=el.origin_y,
            extra_ids=[e.id for e in (extras or [])],
        )

    def redo(self) -> None:
        self.el.text = self.new_text
        if self.dict_match is not None:
            self.el.dict_match = self.dict_match
        if self.new_bbox is not None:
            self.el.bbox = self.new_bbox
        if self.wrap_align is not None:
            self.el.wrap_align = self.wrap_align
        if self.baseline_y is not None:  # 折返し畳み込みは下揃え (最終行のベースライン)
            self.el.origin_y = self.baseline_y
        self.el.dict_revert = self.revert_info

    def undo(self) -> None:
        self.el.text = self.old_text
        self.el.dict_match = self.old_match
        self.el.bbox = self.old_bbox
        self.el.wrap_align = self.old_wrap_align
        self.el.origin_y = self.old_origin_y
        self.el.dict_revert = self.old_revert
```

- [ ] **Step 5: テストが通ることを確認**

Run: `cd pdf-to-svg && python -m pytest test/test_dict_revert.py test/test_undo_stack.py test/test_web_rpc.py -v`
Expected: PASS（既存テストも緑のまま）

- [ ] **Step 6: コミット**

```bash
git add pdf-to-svg/src/model/elements.py pdf-to-svg/src/web/commands.py pdf-to-svg/test/test_dict_revert.py
git commit -m "feat(pdf-to-svg): 辞書置換の復元情報 dict_revert をモデルへ追加"
```

---

### Task 2: `RevertDictMatchCommand`

**Files:**
- Modify: `pdf-to-svg/src/web/commands.py`（末尾に追加）
- Modify: `pdf-to-svg/test/test_dict_revert.py`

**Interfaces:**
- Consumes: Task 1 の `DictRevertInfo` / `dict_revert`
- Produces: `web.commands.RevertDictMatchCommand(el: TextElement, extras: List[TextElement])` — `redo()` で置換前へ復元、`undo()` で置換状態へ戻す。

- [ ] **Step 1: 失敗するテストを書く**（`test_dict_revert.py` に追記）

```python
from web.commands import RevertDictMatchCommand


def test_revert_command_restores_single_line_and_is_undoable():
    el = _text("Item No.", 10, 20, w=40)
    stack = UndoStack()
    stack.push(ReplaceTextCommand(el, "品番", DictMatch(source="Item No.", target="品番")))
    stack.push(RevertDictMatchCommand(el, []))
    assert el.text == "Item No." and el.dict_match is None and el.dict_revert is None
    assert el.bbox == Rect(10, 8, 40, 12)
    stack.undo()  # 戻しの取り消し = 置換状態へ
    assert el.text == "品番" and el.dict_match.target == "品番" and el.dict_revert is not None
    stack.redo()
    assert el.text == "Item No." and el.dict_match is None


def test_revert_command_restores_wrapped_group():
    top = _text("商品", 50, 40)
    bottom = _text("名称", 50, 52)
    stack = UndoStack()
    stack.push(ReplaceTextCommand(
        top, "Product", DictMatch(source="商品名称", target="Product"),
        new_bbox=Rect(50, 28, 20, 24), wrap_align="left", baseline_y=52.0, extras=[bottom],
    ))
    bottom.deleted = True  # `_apply_plans` は extras を DeleteCommand で別途畳む
    stack.push(RevertDictMatchCommand(top, [bottom]))
    assert top.text == "商品" and top.bbox == Rect(50, 28, 20, 12)
    assert top.origin_y == 40 and top.wrap_align is None
    assert bottom.deleted is False
    stack.undo()
    assert top.text == "Product" and top.bbox == Rect(50, 28, 20, 24) and bottom.deleted is True
```

- [ ] **Step 2: 失敗を確認**

Run: `cd pdf-to-svg && python -m pytest test/test_dict_revert.py -v`
Expected: FAIL — `ImportError: cannot import name 'RevertDictMatchCommand'`

- [ ] **Step 3: 実装**（`commands.py` 末尾）

```python
class RevertDictMatchCommand:
    """辞書置換を 1 箇所だけ置換前へ戻す (Undo 可)。

    復元元は要素の `dict_revert` (`ReplaceTextCommand` が書く)。`extras` は折返し
    畳み込みで論理削除した後続行で、戻すときに再表示し、undo で再び畳む。
    """

    def __init__(self, el: TextElement, extras: List[TextElement]):
        self.el = el
        self.extras = list(extras)
        info = el.dict_revert
        if info is None:
            raise ValueError("dict_revert が無い要素は戻せない")
        self.info = info
        # undo (= 置換状態へ戻す) 用に現在値を握る
        self.cur_text = el.text
        self.cur_match = el.dict_match
        self.cur_bbox = el.bbox
        self.cur_wrap_align = el.wrap_align
        self.cur_origin_y = el.origin_y

    def redo(self) -> None:
        self.el.text = self.info.text
        self.el.bbox = self.info.bbox
        self.el.wrap_align = self.info.wrap_align
        self.el.origin_y = self.info.origin_y
        self.el.dict_match = None
        self.el.dict_revert = None
        for ex in self.extras:
            ex.deleted = False

    def undo(self) -> None:
        self.el.text = self.cur_text
        self.el.bbox = self.cur_bbox
        self.el.wrap_align = self.cur_wrap_align
        self.el.origin_y = self.cur_origin_y
        self.el.dict_match = self.cur_match
        self.el.dict_revert = self.info
        for ex in self.extras:
            ex.deleted = True
```

- [ ] **Step 4: 通ることを確認**

Run: `cd pdf-to-svg && python -m pytest test/test_dict_revert.py -v`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add pdf-to-svg/src/web/commands.py pdf-to-svg/test/test_dict_revert.py
git commit -m "feat(pdf-to-svg): 辞書置換を 1 箇所だけ戻す RevertDictMatchCommand を追加"
```

---

### Task 3: `apply_replacement`（バッチ用ヘルパ）も `dict_revert` を書く

**Files:**
- Modify: `pdf-to-svg/src/dictionary/apply.py:292-304`（`apply_replacement`）
- Modify: `pdf-to-svg/test/test_wrap_header.py`（末尾に追記）

**Interfaces:**
- Consumes: Task 1 の `DictRevertInfo`
- Produces: `auto_apply` / `apply_replacement` を通った要素も `dict_revert` を持つ（Command 経路と同じ状態）

- [ ] **Step 1: 失敗するテストを書く**（`test_wrap_header.py` 末尾）

```python
def test_apply_replacement_writes_dict_revert(tmp_path):
    """バッチ用 `apply_replacement` も Command と同じく復元情報を残す。"""
    top = _text("商品", x=50, oy=40)
    bottom = _text("名称", x=50, oy=52)
    pg = _page([top, bottom])
    store = DictionaryStore(tmp_path / "d.json")
    store.add("商品名称", "Product", joined=True)
    dict_apply.auto_apply(pg, store)
    assert top.dict_revert is not None
    assert top.dict_revert.text == "商品" and top.dict_revert.extra_ids == [bottom.id]
    assert top.dict_revert.origin_y == 40 and top.dict_revert.wrap_align is None
    store.close()
```

- [ ] **Step 2: 失敗を確認**

Run: `cd pdf-to-svg && python -m pytest test/test_wrap_header.py -v -k dict_revert`
Expected: FAIL — `assert None is not None`

- [ ] **Step 3: 実装**

`apply_replacement` の先頭（`rep.element.text = rep.target` の前）に追加:

```python
    # 箇所単位の「戻す」が復元に使う置換前状態 (`ReplaceTextCommand` と同じ内容)。
    rep.element.dict_revert = DictRevertInfo(
        text=rep.element.text, bbox=rep.element.bbox, wrap_align=rep.element.wrap_align,
        origin_y=rep.element.origin_y, extra_ids=[e.id for e in rep.extras],
    )
```

import を `from model.elements import DictMatch, DictRevertInfo, ...` に。

- [ ] **Step 4: 通ることを確認**

Run: `cd pdf-to-svg && python -m pytest test/test_wrap_header.py test/test_store_matcher.py test/test_pipeline.py -q`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add pdf-to-svg/src/dictionary/apply.py pdf-to-svg/test/test_wrap_header.py
git commit -m "feat(pdf-to-svg): バッチ用 apply_replacement も dict_revert を残す"
```

---

### Task 4: RPC — `revertDictMatch` / `applyDictMatch`、`planPage` の `state`、`changed2`

**Files:**
- Modify: `pdf-to-svg/src/web/rpc_methods.py:64-68, 143-160, 252-294, 433-455`
- Modify: `pdf-to-svg/test/test_web_rpc.py`（末尾に追記）

**Interfaces:**
- Consumes: Task 2 `RevertDictMatchCommand`
- Produces（JSON）:
  - `planPage` → `{"changes": [{elId, source, target, loc, warning, state: "applied"|"pending"}, ...]}`（要素の出現順）
  - `revertDictMatch {fileIndex, pageInFile, elId}` → `{"reverted": bool}`
  - `applyDictMatch {fileIndex, pageInFile, elId}` → `{"count": int, "warnings": int}`

- [ ] **Step 1: 失敗するテストを書く**（`test_web_rpc.py` 末尾）

```python
def test_revert_dict_match_single_and_plan_page_states(session):
    """1 件だけ戻す: 要素は置換前へ、planPage は pending 行として並べ続ける。"""
    rpc_methods.dispatch(session, "dictAdd", {"source": "A-1042", "target": "ボルト"})
    rpc_methods.dispatch(session, "reapplyDictPage", {"fileIndex": 0, "pageInFile": 0})
    body = session.page(0, 0).elements[1]
    assert body.text == "ボルト"
    plan = rpc_methods.dispatch(session, "planPage", {"fileIndex": 0, "pageInFile": 0})
    assert [c["state"] for c in plan["changes"]] == ["applied", "applied"]

    r = rpc_methods.dispatch(session, "revertDictMatch",
                             {"fileIndex": 0, "pageInFile": 0, "elId": body.id})
    assert r["reverted"] is True
    assert body.text == "A-1042" and body.dict_match is None and body.dict_revert is None
    plan = rpc_methods.dispatch(session, "planPage", {"fileIndex": 0, "pageInFile": 0})
    rows = {c["elId"]: c for c in plan["changes"]}
    assert rows[body.id]["state"] == "pending"
    assert rows[body.id]["source"] == "A-1042" and rows[body.id]["target"] == "ボルト"
    # 戻した後もページは「要確認」のまま (一覧から消えない)
    assert rpc_methods.dispatch(session, "state", {})["changed2"] == [True]
    # 戻しは Undo/Redo に乗る
    rpc_methods.dispatch(session, "undo", {})
    assert body.text == "ボルト"
    rpc_methods.dispatch(session, "redo", {})
    assert body.text == "A-1042"
    # 復元情報が無い要素は no-op
    r = rpc_methods.dispatch(session, "revertDictMatch",
                             {"fileIndex": 0, "pageInFile": 0, "elId": body.id})
    assert r["reverted"] is False
    # 戻しはその場限り: 次の再適用でまた置換される
    r = rpc_methods.dispatch(session, "reapplyDictPage", {"fileIndex": 0, "pageInFile": 0})
    assert r["count"] == 1 and body.text == "ボルト"


def test_revert_dict_match_wrapped_group(tmp_path):
    """折返し畳み込みを戻すと 2 行目が再表示され、合成領域・ベースラインも元へ戻る。"""
    s, top, bottom = _wrapped_pair_session(tmp_path)
    rpc_methods.dispatch(s, "dictAdd", {"source": "商品名称", "target": "Product", "joined": True})
    rpc_methods.dispatch(s, "reapplyDictPage", {"fileIndex": 0, "pageInFile": 0})
    assert top.text == "Product" and bottom.deleted is True
    rpc_methods.dispatch(s, "revertDictMatch", {"fileIndex": 0, "pageInFile": 0, "elId": top.id})
    assert top.text == "商品" and bottom.deleted is False
    assert (top.bbox.x, top.bbox.y, top.bbox.w, top.bbox.h) == (50.0, 28.0, 20.0, 12.0)
    assert top.origin_y == 40 and top.wrap_align is None


def test_apply_dict_match_applies_only_one_element(session):
    """applyDictMatch は指定要素だけを置換する (他の候補は未置換のまま)。"""
    session.page(0, 0).elements.append(
        TextElement(bbox=Rect(10, 60, 60, 12), text="A-1042", origin_x=10, origin_y=70)
    )
    body, other = session.page(0, 0).elements[1], session.page(0, 0).elements[3]
    rpc_methods.dispatch(session, "dictAdd", {"source": "A-1042", "target": "ボルト"})
    r = rpc_methods.dispatch(session, "applyDictMatch",
                             {"fileIndex": 0, "pageInFile": 0, "elId": other.id})
    assert r["count"] == 1
    assert other.text == "ボルト" and body.text == "A-1042"
    plan = rpc_methods.dispatch(session, "planPage", {"fileIndex": 0, "pageInFile": 0})
    rows = {c["elId"]: c for c in plan["changes"]}
    assert rows[body.id]["state"] == "pending" and rows[other.id]["state"] == "applied"
    # 候補でない要素は no-op
    r = rpc_methods.dispatch(session, "applyDictMatch",
                             {"fileIndex": 0, "pageInFile": 0, "elId": 999999})
    assert r["count"] == 0


def test_state_changed2_true_for_pending_candidates(session):
    """未適用の候補しか無いページも要確認 (戻した箇所を一覧から消さない)。"""
    hdr = session.page(0, 0).elements[0]
    hdr.dict_match = None  # 置換済みを消し、候補だけの状態にする
    rpc_methods.dispatch(session, "dictAdd", {"source": "A-1042", "target": "ボルト"})
    assert rpc_methods.dispatch(session, "state", {})["changed2"] == [True]
```

- [ ] **Step 2: 失敗を確認**

Run: `cd pdf-to-svg && python -m pytest test/test_web_rpc.py -v -k "revert or apply_dict_match or pending"`
Expected: FAIL — `KeyError: 'revertDictMatch'` 等

- [ ] **Step 3: 実装**

`pdf-to-svg/src/web/rpc_methods.py`:

(a) import に `RevertDictMatchCommand` を足す（`from web.commands import ...` の行）。

(b) `_page_has_replacements` を置き換え、`rpc_state` の呼び出しを `_page_has_replacements(pg, s.store)` に変更:

```python
def _page_has_replacements(page: Page, store: DictionaryStore) -> bool:
    """手順 2 で「要確認」にするか。置換済みが 1 件でもあるか、未適用の候補 (戻した箇所・
    まだ当てていない箇所) が残るページ。候補も数えるのは、箇所単位で戻したページが一覧から
    消えて再び置換できなくなるのを避けるため。"""
    if any(
        isinstance(e, TextElement) and not e.deleted and e.dict_match is not None
        for e in page.elements
    ):
        return True
    return bool(dict_apply.plan_replacements(page, store))
```

(c) `rpc_planPage` を置き換え:

```python
def rpc_planPage(s: WebSession, args: dict) -> dict:
    """確認一覧の行。置換済み (`applied`) と未適用の候補 (`pending` = 戻した箇所・まだ
    当てていない箇所) を要素の出現順に混ぜて返す。UI はこの順で通し番号を振り、ページ上の
    番号マーカーと対応させる。"""
    pg = s.page(args["fileIndex"], args["pageInFile"])
    pending = {rep.element.id: rep for rep in dict_apply.plan_replacements(pg, s.store)}
    changes = []
    for el in pg.elements:
        if not isinstance(el, TextElement) or el.deleted:
            continue
        loc = "ヘッダ" if el.is_header else "本文"
        if el.dict_match is not None:
            changes.append(
                {
                    "elId": el.id,
                    "source": el.dict_match.source,
                    "target": el.dict_match.target,
                    "loc": loc,
                    # 置換語が収め先の箱幅を超え圧縮表示される恐れ (簡易推定)。
                    "warning": fonts.is_width_overflow(el.text, el.font_size, el.bbox.w),
                    "state": "applied",
                }
            )
        elif el.id in pending:
            rep = pending[el.id]
            changes.append(
                {
                    "elId": el.id,
                    "source": rep.source,
                    "target": rep.target,
                    "loc": loc,
                    "warning": rep.warning is not None,
                    "state": "pending",
                }
            )
    return {"changes": changes}
```

(d) `_apply_plans` の `ReplaceTextCommand(...)` に `extras=rep.extras,` を渡す。

(e) `rpc_reapplyDictPage` の後に追加:

```python
def _find_text_element(pg: Page, el_id: int) -> Optional[TextElement]:
    return next(
        (e for e in pg.elements if e.id == el_id and isinstance(e, TextElement) and not e.deleted),
        None,
    )


def rpc_revertDictMatch(s: WebSession, args: dict) -> dict:
    """辞書置換を 1 箇所だけ置換前へ戻す (Undo 可)。復元情報が無ければ no-op。
    戻しはその場限りで、次の再適用ではまた置換される (恒久除外のフラグは持たない)。"""
    pg = s.page(int(args["fileIndex"]), int(args["pageInFile"]))
    el = _find_text_element(pg, int(args["elId"]))
    if el is None or el.dict_revert is None:
        return {"reverted": False}
    ids = set(el.dict_revert.extra_ids)
    extras = [e for e in pg.elements if e.id in ids and isinstance(e, TextElement)]
    s.undo.push(RevertDictMatchCommand(el, extras))
    return {"reverted": True}


def rpc_applyDictMatch(s: WebSession, args: dict) -> dict:
    """指定要素 1 件だけ辞書を当てる (Undo 可・1 マクロ)。候補でなければ no-op。"""
    pg = s.page(int(args["fileIndex"]), int(args["pageInFile"]))
    el_id = int(args["elId"])
    plans = [rep for rep in dict_apply.plan_replacements(pg, s.store) if rep.element.id == el_id]
    return _apply_plans(s, plans)
```

`rpc_dictSuggest` 内の同形の `next(...)` 検索も `_find_text_element` に置き換える（重複の集約）。

(f) `HANDLERS` に追加:

```python
    "revertDictMatch": rpc_revertDictMatch,
    "applyDictMatch": rpc_applyDictMatch,
```

- [ ] **Step 4: 通ることを確認**

Run: `cd pdf-to-svg && python -m pytest -q`
Expected: 全件 PASS（`test_shell_rpc.py` の実 UndoStack 経路も含む）

- [ ] **Step 5: コミット**

```bash
git add pdf-to-svg/src/web/rpc_methods.py pdf-to-svg/test/test_web_rpc.py
git commit -m "feat(pdf-to-svg): 箇所単位の戻し / 単件置換の RPC と planPage の state を追加"
```

---

### Task 5: UI — 確認一覧の「戻す」「置換」・番号マーカー・ホバー強調

**Files:**
- Modify: `pdf-to-svg/resources/web/app.js:241-290`（`renderConfirm` / `flashElement` 付近）
- Modify: `pdf-to-svg/resources/web/styles.css:485-500`
- Modify: `pdf-to-svg/test/app_flow.e2e.ts:36-45`

**Interfaces:**
- Consumes: Task 4 の `planPage` 行（`state`）、`revertDictMatch` / `applyDictMatch`
- Produces: `.change-row .num` / `.act-revert` / `.act-apply` / `.state`、SVG 内 `g[data-editor-marks]`

- [ ] **Step 1: e2e に失敗する期待を書く**（`app_flow.e2e.ts` の `#doc-master` の `売上高` 確認の直後）

```ts
  // 箇所単位: 一覧の「戻す」で 1 件だけ置換前へ → 行は未置換 (置換ボタン) になる → 「置換」で再び当たる
  await page.click('[data-tab="confirm"]');
  const rows = page.locator("#confirm-dyn .change-row");
  await expect(rows.first().locator(".num")).toHaveText("1");
  // 番号マーカーは一覧の行数と同数だけページ上に描かれる
  await expect(page.locator("#doc-master svg [data-editor-marks] > g")).toHaveCount(await rows.count());
  await rows.first().locator(".act-revert").click();
  await expect(page.locator("#doc-master")).toContainText("Revenue", { timeout: 15_000 });
  await expect(page.locator("#confirm-dyn")).toContainText("未置換 1 件");
  await page.locator("#confirm-dyn .change-row").first().locator(".act-apply").click();
  await expect(page.locator("#doc-master")).toContainText("売上高", { timeout: 15_000 });
  await expect(page.locator("#confirm-dyn")).not.toContainText("未置換");
```

- [ ] **Step 2: 失敗を確認**

Run: `cd pdf-to-svg && pnpm exec playwright test test/app_flow.e2e.ts`
Expected: FAIL — `.num` が見つからない

- [ ] **Step 3: `renderConfirm` を実装し、マーカー・ホバー強調のヘルパを追加**

`app.js` の `renderConfirm` を次に置き換え、`flashElement` の隣に `highlightElement` / `drawChangeMarkers` を追加する（`svg` / `esc` / `chevD` / `checkD` / `rpc` / `invalidate` / `reloadState` / `render` / `flashElement` / `noChangeNote` は既存）:

```js
  // ── 9. 確認ペイン (手順2) ──
  async function renderConfirm() {
    var el = document.getElementById("confirm-dyn");
    var ed2 = app.querySelector('[data-screen="2"] .editor');
    if (!S.changed2[S.page]) {
      ed2.classList.add("nochange");
      el.innerHTML = noChangeNote("このページに置換はありません");
      drawChangeMarkers([]);
      return;
    }
    ed2.classList.remove("nochange");
    var pg = S.PAGES[S.page];
    var token = pg.fileIndex + ":" + pg.pageInFile;
    var data = await rpc("planPage", { fileIndex: pg.fileIndex, pageInFile: pg.pageInFile });
    if (token !== S.PAGES[S.page].fileIndex + ":" + S.PAGES[S.page].pageInFile) return; // ページが変わった
    var applied = data.changes.filter(function (c) { return c.state === "applied"; }).length;
    var pending = data.changes.length - applied;
    var rows = data.changes.map(function (ch, i) {
      var isApplied = ch.state === "applied";
      var warn = ch.warning ? '<span class="warn" title="置換語が元の幅より長く、圧縮表示される可能性があります">幅超過</span>' : "";
      var badge = isApplied ? "" : '<span class="state">未置換</span>';
      // 置換済み行は「戻す」、未置換行 (戻した箇所・まだ当てていない箇所) は「置換」。
      var act = isApplied
        ? '<button type="button" class="row-btn act-revert" title="この箇所だけ置換前に戻す">戻す</button>'
        : '<button type="button" class="row-btn act-apply" title="この箇所だけ置換する">置換</button>';
      return '<div class="change-row' + (isApplied ? "" : " pending") + '" data-el="' + ch.elId + '">' +
        '<span class="num">' + (i + 1) + '</span><span class="loc">' + esc(ch.loc) +
        '</span><span class="pair"><span class="from">' + esc(ch.source) + "</span>" +
        svg('<path d="M4 12h15M13 6l6 6-6 6"/>', 15) + '<span class="to">' + esc(ch.target) + "</span></span>" +
        warn + badge + act + "</div>";
    }).join("");
    el.innerHTML =
      '<div class="confirm-banner"><span class="ic">' + svg('<path d="' + checkD + '"/>', 22, 2.2) + '</span><div><div class="t">このページで ' +
      applied + ' 件を置換</div>' + (pending ? '<div class="t sub">未置換 ' + pending + ' 件</div>' : "") +
      '<div class="s">番号はページ上のマーカーと対応します</div></div></div>' +
      '<div style="display:flex;flex-direction:column;min-height:0;flex:1;"><div class="field-label">変更の一覧（行に乗せると該当箇所を強調）</div><div class="change-list">' +
      rows + "</div></div>";
    drawChangeMarkers(data.changes);
    el.querySelectorAll(".change-row[data-el]").forEach(function (row) {
      var elId = row.dataset.el;
      row.addEventListener("click", function () { flashElement("doc-master", elId); });
      row.addEventListener("mouseenter", function () { highlightElement("doc-master", elId, true); });
      row.addEventListener("mouseleave", function () { highlightElement("doc-master", elId, false); });
      var args = { fileIndex: pg.fileIndex, pageInFile: pg.pageInFile, elId: elId };
      // 置換の有無が変わると SVG も一覧も変わるので、再適用ボタンと同じく再生成→再描画する。
      async function after() {
        highlightElement("doc-master", elId, false);
        invalidate(pg.fileIndex, pg.pageInFile);
        await reloadState();
        render();
      }
      var revert = row.querySelector(".act-revert");
      if (revert) revert.addEventListener("click", async function (e) {
        e.stopPropagation(); await rpc("revertDictMatch", args); await after();
      });
      var apply = row.querySelector(".act-apply");
      if (apply) apply.addEventListener("click", async function (e) {
        e.stopPropagation(); await rpc("applyDictMatch", args); await after();
      });
    });
  }

  // 一覧の行に乗せている間だけ該当要素を枠で示す (`flashElement` の持続版)。
  function highlightElement(hostId, elId, on) {
    var host = document.getElementById(hostId);
    if (!host) return;
    var old = host.querySelector('.sel-box[data-hl="' + elId + '"]');
    if (old) old.remove();
    if (!on) return;
    var svgEl = host.querySelector("svg"); if (!svgEl) return;
    var target = svgEl.querySelector('[data-el="' + elId + '"]'); if (!target) return;
    var hb = host.getBoundingClientRect(); var tb = target.getBoundingClientRect();
    var box = document.createElement("div");
    box.className = "sel-box"; box.dataset.hl = elId;
    box.style.left = (tb.left - hb.left - 3) + "px"; box.style.top = (tb.top - hb.top - 3) + "px";
    box.style.width = (tb.width + 6) + "px"; box.style.height = (tb.height + 6) + "px";
    host.appendChild(box);
  }

  // 一覧の通し番号をページ上の該当要素の左上へ描く。SVG 座標系 (getBBox) に置くので
  // ズームに追随し、表示用 DOM にだけ入る (書き出しはサーバ側 exportSvg で別生成)。
  var SVG_NS = "http://www.w3.org/2000/svg";
  function drawChangeMarkers(changes) {
    var host = document.getElementById("doc-master");
    var svgEl = host && host.querySelector("svg");
    if (!svgEl) return;
    var old = svgEl.querySelector("[data-editor-marks]");
    if (old) old.remove();
    if (!changes.length) return;
    var vb = svgEl.viewBox.baseVal;
    var r = Math.max(4, Math.min(vb.width, vb.height) * 0.012); // ページ寸法に対する相対サイズ
    var g = document.createElementNS(SVG_NS, "g");
    g.setAttribute("data-editor-marks", "");
    g.setAttribute("font-family", "BIZ UDPGothic, Yu Gothic UI, sans-serif");
    g.setAttribute("font-weight", "700");
    g.setAttribute("font-size", String(r * 1.3));
    g.setAttribute("pointer-events", "none");
    changes.forEach(function (ch, i) {
      var t = svgEl.querySelector('[data-el="' + ch.elId + '"]'); if (!t) return;
      var bb = t.getBBox();
      var m = document.createElementNS(SVG_NS, "g");
      var c = document.createElementNS(SVG_NS, "circle");
      c.setAttribute("cx", bb.x); c.setAttribute("cy", bb.y); c.setAttribute("r", r);
      c.setAttribute("fill", ch.state === "applied" ? "oklch(0.585 0.105 240)" : "oklch(0.68 0.010 262)");
      var tx = document.createElementNS(SVG_NS, "text");
      tx.setAttribute("x", bb.x); tx.setAttribute("y", bb.y + r * 0.45);
      tx.setAttribute("text-anchor", "middle"); tx.setAttribute("fill", "#fff");
      tx.textContent = String(i + 1);
      m.appendChild(c); m.appendChild(tx); g.appendChild(m);
    });
    svgEl.appendChild(g);
  }
```

`renderConfirm` は SVG 描画後に呼ばれる前提（現行どおり）。ページ SVG を差し替える描画関数（`render` 内で `#doc-master` に `svg` を入れる箇所）が `renderConfirm` より後に走る経路があれば、その直後にも `drawChangeMarkers` を呼び直せるよう `S.lastChanges` に `data.changes` を保存し、SVG 挿入直後に `drawChangeMarkers(S.lastChanges || [])` を呼ぶ（該当箇所は `app.js` の「── 14. 描画 ──」節で `doc-master` に innerHTML を入れる場所）。

- [ ] **Step 4: スタイルを追加**（`styles.css` の `.change-row .warn` の直後）

```css
.change-row { flex-wrap: wrap; row-gap: 8px; }
.change-row .num { width: 18px; height: 18px; border-radius: 50%; background: var(--accent); color: #fff; font-size: 11px; font-weight: 700; display: grid; place-items: center; flex: none; font-family: var(--font-round); }
.change-row .loc { width: auto; }
.change-row .row-btn { margin-left: auto; font: inherit; font-size: 11.5px; font-weight: 700; padding: 3px 12px; border-radius: 999px; border: 1px solid var(--border); background: var(--surface); color: var(--ink); cursor: pointer; }
.change-row .row-btn:hover { border-color: var(--border-strong); background: var(--paper); }
.change-row .act-apply { border-color: var(--accent-line); color: var(--accent-ink); background: var(--accent-soft); }
.change-row .state { font-size: 10px; font-weight: 700; color: var(--faint); border: 1px solid var(--border); border-radius: 999px; padding: 1px 7px; white-space: nowrap; }
.change-row.pending { background: var(--sunk); border-style: dashed; }
.change-row.pending .num { background: var(--faint); }
.change-row.pending .from { text-decoration: none; color: var(--ink); }
.change-row.pending .to { color: var(--faint); font-weight: 400; }
.confirm-banner .t.sub { font-size: 12.5px; color: var(--muted); }
```

- [ ] **Step 5: 単体・e2e を通す**

Run: `cd pdf-to-svg && python -m pytest -q && pnpm exec playwright test test/app_flow.e2e.ts`
Expected: PASS。失敗するなら `.change-row` の DOM を `resources/web/index.html` / 実装で確認して e2e のセレクタを合わせる（実装側の挙動は変えない）。

- [ ] **Step 6: コミット**

```bash
git add pdf-to-svg/resources/web/app.js pdf-to-svg/resources/web/styles.css pdf-to-svg/test/app_flow.e2e.ts
git commit -m "feat(pdf-to-svg): 確認一覧に箇所単位の「戻す」「置換」と番号マーカー・ホバー強調を追加"
```

---

### Task 6: ドキュメント更新と HTML 再生成

**Files:**
- Modify: `docs/pdf-to-svg/src/操作手順書.md`（4.1 節の確認手順の直後）
- Modify: `docs/pdf-to-svg/src/PdfToSvg_仕様一覧.md`（UI 表・RPC 表）
- Modify: `docs/pdf-to-svg/src/設計書.md`（辞書適用の節。`apply_replacement` の説明段落付近）
- Generated: `docs/pdf-to-svg/PdfToSvg_手引き.html` / `docs/pdf-to-svg/PdfToSvg_設計.html`

- [ ] **Step 1: 操作手引きに追記**（`操作手順書.md` の「このページのみ再適用」の手順の後。既存の節番号に合わせて振る）

```markdown
### 4.2 置き換えを 1 か所だけ戻す / 当てる

確認一覧（左の「確認」欄）の各行には、ページ上の同じ番号のマーカーが対応しています。同じ言葉が何度も出てくるページでも、番号を見れば「どこの置き換えか」が分かります。行にマウスを乗せると、その箇所がページ上で枠で強調されます。

| 操作 | 内容 |
|---|---|
| **戻す** | その 1 か所だけを置き換え前の言葉に戻します（Undo で取り消せます）。戻した行は「未置換」として一覧に残ります。 |
| **置換** | 未置換の行を、その 1 か所だけ置き換えます。 |

> [!INFO] 「戻す」で戻した箇所は、次に「再適用」を押すとまた置き換わります。戻したままにしたいときは、再適用のあとにもう一度「戻す」を押してください。
```

- [ ] **Step 2: 仕様一覧に追記**

UI 表（`#btn-reapply` の行の下）:

```markdown
| 11 | 2. 用語置換 | 戻す / 置換 | `.change-row .act-revert` / `.act-apply` | 確認一覧の行ごとに 1 箇所だけ置換前へ戻す / 1 箇所だけ置換する（Undo 可） |
| 12 | 2. 用語置換 | 番号マーカー | `#doc-master svg [data-editor-marks]` | 一覧の通し番号をページ上の該当箇所へ描く（表示用のみ・書き出しには含めない）。行ホバーで枠強調 |
```

RPC 表（`reapplyDict / reapplyDictPage` の行の下）:

```markdown
| 13 | RPC | `revertDictMatch` | 指定要素の置換を 1 箇所だけ戻す（`dict_revert` から復元、`RevertDictMatchCommand`。次の再適用ではまた置換される） |
| 14 | RPC | `applyDictMatch` | 指定要素 1 件だけ辞書を当てる（1 マクロ） |
```

既存の番号と重複するなら以降を振り直す。`planPage` の行があれば `state`（applied/pending）を返す旨を追記。

- [ ] **Step 3: 設計書に追記**（辞書適用の節）

```markdown
#### 箇所単位の戻し・単件適用

置換の適用時、`ReplaceTextCommand`（バッチ用の `apply_replacement` も同様）は置換前の状態を要素自身の `TextElement.dict_revert`（`DictRevertInfo`: text / bbox / wrap_align / origin_y / 畳んだ後続行の id）へ書く。置換コマンドは Undo マクロの中に埋まっていて個別には辿れず、Undo 深さ上限で捨てられもするため、復元元は要素が持つ。`revertDictMatch` は `RevertDictMatchCommand` を Undo スタックへ push し、`dict_revert` から復元して後続行を再表示する（戻し自体も Undo/Redo に乗る）。戻しはその場限りで、恒久除外のフラグは持たない（戻した箇所は次の再適用でまた置換される）。`applyDictMatch` は `plan_replacements` の候補から 1 件だけを `_apply_plans` に渡す。

確認一覧（`planPage`）は置換済み（`applied`）と未適用の候補（`pending`）を要素の出現順に混ぜて返し、`state` の `changed2` も候補があるページを要確認にする（戻したページが一覧から消えないため）。UI はこの順で通し番号を振り、表示中の SVG に `g[data-editor-marks]` として番号マーカーを描く（SVG 座標系なのでズームに追随。表示用 DOM のみで、書き出し SVG はサーバの `exportSvg` が別に生成するため混入しない）。
```

- [ ] **Step 4: HTML を再生成し、差分を確認**

Run: `python docs/_build/build_all.py --project pdf-to-svg`
Expected: `docs/pdf-to-svg/PdfToSvg_手引き.html` / `PdfToSvg_設計.html` が更新される。`git status` で 2 つの HTML と 3 つの md 以外に差分が無いこと。

- [ ] **Step 5: docs のテストを通す**

Run: `python -m pytest docs -q`
Expected: PASS

- [ ] **Step 6: コミット**

```bash
git add docs/pdf-to-svg
git commit -m "docs(pdf-to-svg): 辞書置換の箇所単位の戻し・単件適用と番号マーカーを手引き・仕様一覧・設計書へ反映"
```

---

## Self-Review

- Spec 2.1 → Task 1 / 2.2 → Task 3 / 2.3 → Task 1・2 / 2.4 → Task 4 / 2.5 → Task 5 / 2.6 → Task 6 / 3 テスト → Task 1〜5。
- 名称の一貫性: `DictRevertInfo` / `dict_revert` / `RevertDictMatchCommand` / `revertDictMatch` / `applyDictMatch` / `.num` / `.act-revert` / `.act-apply` / `.state` / `data-editor-marks` / `highlightElement` / `drawChangeMarkers` を全タスクで同一に使用。
- `ReplaceTextCommand.extras` は Task 1 で追加、Task 4 の `_apply_plans` が渡す。Task 2 の折返しテストは `_apply_plans` を経由しないため `bottom.deleted = True` を手で立てている（意図的）。
