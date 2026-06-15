"""編集操作の QUndoCommand 群。モデル (Page/Element) を直接更新する。

旧 ``editor/commands.py`` を QGraphicsScene 非依存へ作り替えたもの。Web UI では
編集後に Bridge が ``pageInvalidated`` を発火し、JS がページ SVG を取り直す。
"""
from __future__ import annotations

from typing import List, Optional

from PySide6.QtGui import QUndoCommand

from model.document import Page
from model.elements import DictMatch, Element, Rect, TextElement


class DeleteCommand(QUndoCommand):
    def __init__(self, elements: List[Element]):
        super().__init__(f"{len(elements)} 要素を削除")
        self.elements = list(elements)

    def redo(self) -> None:
        for el in self.elements:
            el.deleted = True

    def undo(self) -> None:
        for el in self.elements:
            el.deleted = False


class CropCommand(QUndoCommand):
    def __init__(self, page: Page, new_rect: Optional[Rect]):
        super().__init__("クロップ" if new_rect else "クロップ解除")
        self.page = page
        self.new_rect = new_rect
        self.old_rect = page.crop_rect

    def redo(self) -> None:
        self.page.crop_rect = self.new_rect

    def undo(self) -> None:
        self.page.crop_rect = self.old_rect


class ReplaceTextCommand(QUndoCommand):
    def __init__(
        self,
        el: TextElement,
        new_text: str,
        dict_match: Optional[DictMatch] = None,
    ):
        super().__init__("テキスト置換")
        self.el = el
        self.new_text = new_text
        self.dict_match = dict_match
        self.old_text = el.text
        self.old_match = el.dict_match

    def redo(self) -> None:
        self.el.text = self.new_text
        if self.dict_match is not None:
            self.el.dict_match = self.dict_match

    def undo(self) -> None:
        self.el.text = self.old_text
        self.el.dict_match = self.old_match
