"""編集操作のコマンド群。モデル (Page/Element) を直接更新する。

旧実装は ``QUndoCommand`` 派生だったが、QtWebEngine 撤廃に伴い素の Python クラスへ。
:class:`web.undo_stack.UndoStack` が push 時に ``redo()`` を実行し、``undo()`` /
``redo()`` で巻き戻す。``redo()`` / ``undo()`` の本体とコンストラクタ・シグネチャは
従来と不変 (rpc_methods 側は無改変)。
"""
from __future__ import annotations

from typing import List, Optional

from model.document import Page
from model.elements import DictMatch, Element, Rect, TextElement


class DeleteCommand:
    def __init__(self, elements: List[Element]):
        self.elements = list(elements)

    def redo(self) -> None:
        for el in self.elements:
            el.deleted = True

    def undo(self) -> None:
        for el in self.elements:
            el.deleted = False


class AddElementCommand:
    """要素を 1 つページに追加する (枠線など)。``DeleteCommand`` と対称で、
    redo で可視化・undo で非表示にする (要素はリストに残し ``deleted`` で制御)。"""

    def __init__(self, page: Page, element: Element):
        self.page = page
        self.element = element

    def redo(self) -> None:
        if self.element not in self.page.elements:
            self.page.elements.append(self.element)
        self.element.deleted = False

    def undo(self) -> None:
        self.element.deleted = True


class ReplaceTextCommand:
    def __init__(
        self,
        el: TextElement,
        new_text: str,
        dict_match: Optional[DictMatch] = None,
        new_bbox: Optional[Rect] = None,
    ):
        self.el = el
        self.new_text = new_text
        self.dict_match = dict_match
        # 折返し畳み込み時に結合テキストを据え直す合成領域 (`dictionary/apply.py` の
        # `Replacement.new_bbox`)。None なら bbox は変更しない。
        self.new_bbox = new_bbox
        self.old_text = el.text
        self.old_match = el.dict_match
        self.old_bbox = el.bbox

    def redo(self) -> None:
        self.el.text = self.new_text
        if self.dict_match is not None:
            self.el.dict_match = self.dict_match
        if self.new_bbox is not None:
            self.el.bbox = self.new_bbox

    def undo(self) -> None:
        self.el.text = self.old_text
        self.el.dict_match = self.old_match
        self.el.bbox = self.old_bbox
