"""web.rpc_methods のディスパッチを Qt を起動せず検証する。

QUndoStack の代わりに FakeUndo (push で redo を即実行) を使うことで、
GUI なしで「状態の読み出し」「編集の反映」を確認できる。
"""
from __future__ import annotations

import pytest

from dictionary.store import DictionaryStore
from model.document import Document, Page
from model.elements import DictMatch, LineElement, Rect, TextElement
from web import rpc_methods
from web.rpc_methods import WebSession


class FakeUndo:
    """QUndoStack の最小代用 (push=redo 実行、undo/redo、マクロは透過)。"""

    def __init__(self):
        self._stack = []
        self._pos = 0

    def clear(self):
        self._stack = []
        self._pos = 0

    def beginMacro(self, _label):  # noqa: N802
        pass

    def endMacro(self):  # noqa: N802
        pass

    def push(self, cmd):
        del self._stack[self._pos:]
        cmd.redo()
        self._stack.append(cmd)
        self._pos += 1

    def canUndo(self):  # noqa: N802
        return self._pos > 0

    def canRedo(self):  # noqa: N802
        return self._pos < len(self._stack)

    def undo(self):
        if self.canUndo():
            self._pos -= 1
            self._stack[self._pos].undo()

    def redo(self):
        if self.canRedo():
            self._stack[self._pos].redo()
            self._pos += 1


def _make_doc(path="部品表.pdf") -> Document:
    page = Page(index=0, width_pt=200.0, height_pt=300.0)
    hdr = TextElement(
        bbox=Rect(10, 10, 40, 12), text="品番", original_text="Item No.",
        origin_x=10, origin_y=20, is_header=True,
        dict_match=DictMatch(source="Item No.", target="品番"),
    )
    body = TextElement(bbox=Rect(10, 40, 60, 12), text="A-1042", origin_x=10, origin_y=50)
    rule = LineElement(bbox=Rect(10, 30, 180, 0), x0=10, y0=30, x1=190, y1=30)
    page.elements = [hdr, body, rule]
    return Document(source_path=path, pages=[page])


@pytest.fixture()
def session(tmp_path):
    store = DictionaryStore(tmp_path / "dict.json")
    s = WebSession(store, FakeUndo())
    s.docs = [_make_doc()]
    return s


def test_state(session):
    st = rpc_methods.dispatch(session, "state", {})
    assert st["total"] == 1
    assert st["files"][0]["pages"] == 1
    assert st["changed2"] == [True]   # dict_match のあるページは要確認
    assert st["changed3"] == [True]   # トリミングは全ページ対象


def test_page_svg_has_data_el(session):
    data = rpc_methods.dispatch(session, "pageSvg", {"fileIndex": 0, "pageInFile": 0})
    assert "data-el=" in data["svg"]
    assert data["width"] == 200.0 and data["height"] == 300.0


def test_plan_page(session):
    data = rpc_methods.dispatch(session, "planPage", {"fileIndex": 0, "pageInFile": 0})
    assert len(data["changes"]) == 1
    ch = data["changes"][0]
    assert ch["source"] == "Item No." and ch["target"] == "品番" and ch["loc"] == "ヘッダ"


def test_apply_delete_and_removed_list(session):
    page = session.page(0, 0)
    target = page.elements[1]  # body text
    rpc_methods.dispatch(session, "applyDelete",
                         {"fileIndex": 0, "pageInFile": 0, "elIds": [target.id]})
    assert target.deleted is True
    removed = rpc_methods.dispatch(session, "removedList", {"fileIndex": 0, "pageInFile": 0})
    assert len(removed["removed"]) == 1
    # undo で戻る
    rpc_methods.dispatch(session, "undo", {})
    assert target.deleted is False


def test_delete_region(session):
    page = session.page(0, 0)
    body = page.elements[1]  # bbox(10,40,60,12)
    # 重なる矩形 → 削除される
    res = rpc_methods.dispatch(session, "deleteRegion",
                               {"fileIndex": 0, "pageInFile": 0,
                                "rect": {"x": 0, "y": 35, "w": 100, "h": 40}})
    assert res["deleted"] >= 1 and body.deleted is True
    # 戻して、重ならない矩形では 0 件
    rpc_methods.dispatch(session, "undo", {})
    assert body.deleted is False
    res2 = rpc_methods.dispatch(session, "deleteRegion",
                                {"fileIndex": 0, "pageInFile": 0,
                                 "rect": {"x": 150, "y": 150, "w": 10, "h": 10}})
    assert res2["deleted"] == 0


def test_remove_file(session):
    session.docs.append(_make_doc("図面.pdf"))
    assert len(session.docs) == 2
    res = rpc_methods.dispatch(session, "removeFile", {"fileIndex": 0})
    assert res["total"] == 1
    # 先頭を消したので残るのは 2 番目に追加したファイル
    assert session.docs[0].source_path == "図面.pdf"
    # 範囲外の index は無視 (例外を投げない)
    res2 = rpc_methods.dispatch(session, "removeFile", {"fileIndex": 9})
    assert res2["total"] == 1


def test_add_border(session):
    page = session.page(0, 0)
    before = len(page.live_elements())
    res = rpc_methods.dispatch(session, "addBorder",
                               {"fileIndex": 0, "pageInFile": 0,
                                "rect": {"x": 5, "y": 5, "w": 100, "h": 80},
                                "color": "#ff0000", "width": 2})
    el = next(e for e in page.elements if e.id == res["elId"])
    assert el.stroke == "#ff0000" and el.fill is None and el.stroke_width == 2.0
    assert el.kind == "rect" and el.deleted is False
    assert len(page.live_elements()) == before + 1
    # 書き出し SVG に枠線が出る (塗りなし stroke 指定)
    data = rpc_methods.dispatch(session, "pageSvg", {"fileIndex": 0, "pageInFile": 0})
    assert 'stroke="#ff0000"' in data["svg"] and 'fill="none"' in data["svg"]
    # undo で消え、redo で戻る (既存の選択→削除でも消せる前提の通常要素)
    rpc_methods.dispatch(session, "undo", {})
    assert el.deleted is True and len(page.live_elements()) == before
    rpc_methods.dispatch(session, "redo", {})
    assert el.deleted is False and len(page.live_elements()) == before + 1


def test_dict_add_and_list(session):
    rpc_methods.dispatch(session, "dictAdd", {"source": "Q'ty", "target": "数量"})
    lst = rpc_methods.dispatch(session, "dictList", {})
    sources = [e["source"] for e in lst["entries"]]
    assert "Q'ty" in sources


def test_dict_export_import(tmp_path):
    out = tmp_path / "shared_dict.json"
    # 書き出し元セッション
    s1 = WebSession(DictionaryStore(tmp_path / "d1.json"), FakeUndo())
    rpc_methods.dispatch(s1, "dictAdd", {"source": "Item No.", "target": "品番"})
    rpc_methods.dispatch(s1, "dictAdd", {"source": "Q'ty", "target": "数量"})
    res = rpc_methods.dispatch(s1, "dictExport", {"path": str(out)})
    assert out.exists() and res["count"] == 2

    # 別セッションへ読み込み
    s2 = WebSession(DictionaryStore(tmp_path / "d2.json"), FakeUndo())
    imp = rpc_methods.dispatch(s2, "dictImport", {"path": str(out)})
    assert imp["imported"] == 2
    sources = [e["source"] for e in imp["entries"]]
    assert "Item No." in sources and "Q'ty" in sources


def test_reapply_dict(session):
    # 辞書に body テキストの語を登録し、ヘッダ以外も対象にして再適用
    rpc_methods.dispatch(session, "dictAdd", {"source": "A-1042", "target": "ボルト"})
    rpc_methods.dispatch(session, "setOnlyHeaders", {"value": False})
    r = rpc_methods.dispatch(session, "reapplyDict", {})
    assert r["count"] >= 1
    assert session.page(0, 0).elements[1].text == "ボルト"
