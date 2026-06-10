"""編集操作の QUndoCommand 群。すべて DocumentScene を介してモデルを更新する。"""
from __future__ import annotations

from typing import List, Optional

from PySide6.QtGui import QUndoCommand

from model.elements import DictMatch, Element, Rect, TextElement
from editor.scene import DocumentScene


class DeleteCommand(QUndoCommand):
    def __init__(self, scene: DocumentScene, elements: List[Element]):
        super().__init__(f"{len(elements)} 要素を削除")
        self.scene = scene
        self.elements = list(elements)

    def redo(self) -> None:
        for el in self.elements:
            self.scene.set_deleted(el, True)

    def undo(self) -> None:
        for el in self.elements:
            self.scene.set_deleted(el, False)


class CropCommand(QUndoCommand):
    def __init__(self, scene: DocumentScene, new_rect: Optional[Rect]):
        super().__init__("クロップ" if new_rect else "クロップ解除")
        self.scene = scene
        self.new_rect = new_rect
        self.old_rect = scene.page.crop_rect

    def redo(self) -> None:
        self.scene.set_crop(self.new_rect)

    def undo(self) -> None:
        self.scene.set_crop(self.old_rect)


class ReplaceTextCommand(QUndoCommand):
    def __init__(
        self,
        scene: DocumentScene,
        el: TextElement,
        new_text: str,
        dict_match: Optional[DictMatch] = None,
    ):
        super().__init__("テキスト置換")
        self.scene = scene
        self.el = el
        self.new_text = new_text
        self.dict_match = dict_match
        self.old_text = el.text
        self.old_match = el.dict_match

    def redo(self) -> None:
        self.el.text = self.new_text
        if self.dict_match is not None:
            self.el.dict_match = self.dict_match
        self.scene.refresh_text(self.el)

    def undo(self) -> None:
        self.el.text = self.old_text
        self.el.dict_match = self.old_match
        self.scene.refresh_text(self.el)
