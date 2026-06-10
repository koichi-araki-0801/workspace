"""DocumentScene — 1 ページ分のモデルを QGraphicsScene として表示・編集する。

モデルが真実。scene 上の編集 (削除/テキスト変更/クロップ) はモデルへ書き戻し、
SVG 書き出しはモデルから行う。
"""
from __future__ import annotations

from typing import Dict, List, Optional

from PySide6.QtCore import QRectF, Qt
from PySide6.QtGui import QColor, QPen
from PySide6.QtWidgets import QGraphicsItem, QGraphicsRectItem, QGraphicsScene

from model.document import Page
from model.elements import Element, Rect, TextElement
from editor import items as items_mod

HIGHLIGHT_COLOR = QColor(255, 140, 0)  # 辞書置換のハイライト枠


class DocumentScene(QGraphicsScene):
    def __init__(self, page: Page, parent=None):
        super().__init__(parent)
        self.page = page
        self._items_by_id: Dict[int, QGraphicsItem] = {}
        self._crop_overlay: Optional[QGraphicsRectItem] = None
        self.build()

    # ---- 構築 ----
    def build(self) -> None:
        self.clear()
        self._items_by_id.clear()
        self._crop_overlay = None

        self.setSceneRect(0, 0, self.page.width_pt, self.page.height_pt)

        # 用紙の白背景
        paper = QGraphicsRectItem(0, 0, self.page.width_pt, self.page.height_pt)
        paper.setBrush(Qt.white)
        paper.setPen(QPen(Qt.NoPen))
        paper.setZValue(-20000)
        paper.setFlag(QGraphicsItem.ItemIsSelectable, False)
        self.addItem(paper)

        if self.page.background is not None:
            bg = items_mod.make_background_item(
                self.page.background.png_bytes, self.page.background.rect
            )
            if bg is not None:
                self.addItem(bg)

        for el in self.page.live_elements():
            self._add_element_item(el)

        if self.page.crop_rect is not None:
            self._show_crop_overlay(self.page.crop_rect)

    def _add_element_item(self, el: Element) -> None:
        item = items_mod.make_item(el)
        if item is None:
            return
        self.addItem(item)
        self._items_by_id[el.id] = item
        if isinstance(el, TextElement) and el.dict_match is not None:
            self._mark_highlight(item)

    def _mark_highlight(self, item: QGraphicsItem) -> None:
        rect = item.mapToScene(item.boundingRect()).boundingRect()
        hi = QGraphicsRectItem(rect)
        hi.setPen(QPen(HIGHLIGHT_COLOR, 0.8, Qt.DashLine))
        hi.setBrush(Qt.NoBrush)
        hi.setZValue(9000)
        hi.setFlag(QGraphicsItem.ItemIsSelectable, False)
        hi.setData(items_mod.ELEMENT_ID_KEY, -1)
        self.addItem(hi)

    # ---- 参照 ----
    def element_for_item(self, item: QGraphicsItem) -> Optional[Element]:
        el_id = item.data(items_mod.ELEMENT_ID_KEY)
        if el_id is None or el_id < 0:
            return None
        return self._element_by_id(el_id)

    def _element_by_id(self, el_id: int) -> Optional[Element]:
        for el in self.page.elements:
            if el.id == el_id:
                return el
        return None

    def selected_elements(self) -> List[Element]:
        out = []
        for item in self.selectedItems():
            el = self.element_for_item(item)
            if el is not None:
                out.append(el)
        return out

    # ---- 編集 ----
    def set_deleted(self, el: Element, deleted: bool) -> None:
        el.deleted = deleted
        if deleted:
            item = self._items_by_id.pop(el.id, None)
            if item is not None:
                self.removeItem(item)
        else:
            if el.id not in self._items_by_id:
                self._add_element_item(el)

    def refresh_text(self, el: TextElement) -> None:
        """テキスト変更後に該当 item を作り直す。"""
        item = self._items_by_id.pop(el.id, None)
        if item is not None:
            self.removeItem(item)
        self._add_element_item(el)

    # ---- クロップ ----
    def set_crop(self, rect: Optional[Rect]) -> None:
        self.page.crop_rect = rect
        if self._crop_overlay is not None:
            self.removeItem(self._crop_overlay)
            self._crop_overlay = None
        if rect is not None:
            self._show_crop_overlay(rect)

    def _show_crop_overlay(self, rect: Rect) -> None:
        overlay = QGraphicsRectItem(rect.x, rect.y, rect.w, rect.h)
        overlay.setPen(QPen(QColor(0, 120, 215), 1.0, Qt.DashLine))
        overlay.setBrush(Qt.NoBrush)
        overlay.setZValue(10000)
        overlay.setFlag(QGraphicsItem.ItemIsSelectable, False)
        overlay.setData(items_mod.ELEMENT_ID_KEY, -1)
        self.addItem(overlay)
        self._crop_overlay = overlay
