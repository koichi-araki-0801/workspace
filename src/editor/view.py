"""EditorView — 選択 / クロップ のツールモードを持つ QGraphicsView。

- select モード: ラバーバンドで複数選択。Delete キーで削除要求。
- crop モード: ドラッグで矩形を描き、離すと crop_drawn を発火。
ホイールでズーム。実際のモデル更新は MainWindow が UndoStack 経由で行う。
"""
from __future__ import annotations

from PySide6.QtCore import QPointF, QRectF, Qt, Signal
from PySide6.QtGui import QColor, QPainter, QPen
from PySide6.QtWidgets import QGraphicsRectItem, QGraphicsView

from model.elements import Rect

MODE_SELECT = "select"
MODE_CROP = "crop"


class EditorView(QGraphicsView):
    crop_drawn = Signal(object)        # Rect
    delete_requested = Signal()
    selection_changed = Signal()

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setRenderHint(QPainter.Antialiasing, True)
        self.setRenderHint(QPainter.TextAntialiasing, True)
        self.setDragMode(QGraphicsView.RubberBandDrag)
        self.setTransformationAnchor(QGraphicsView.AnchorUnderMouse)
        self._mode = MODE_SELECT
        self._crop_origin: QPointF | None = None
        self._crop_rubber: QGraphicsRectItem | None = None

    def set_mode(self, mode: str) -> None:
        self._mode = mode
        if mode == MODE_SELECT:
            self.setDragMode(QGraphicsView.RubberBandDrag)
            self.setCursor(Qt.ArrowCursor)
        else:
            self.setDragMode(QGraphicsView.NoDrag)
            self.setCursor(Qt.CrossCursor)

    def mode(self) -> str:
        return self._mode

    # ---- ズーム ----
    def wheelEvent(self, event) -> None:
        if event.modifiers() & Qt.ControlModifier:
            factor = 1.15 if event.angleDelta().y() > 0 else 1 / 1.15
            self.scale(factor, factor)
            event.accept()
        else:
            super().wheelEvent(event)

    # ---- キーボード ----
    def keyPressEvent(self, event) -> None:
        if event.key() in (Qt.Key_Delete, Qt.Key_Backspace):
            self.delete_requested.emit()
            event.accept()
            return
        super().keyPressEvent(event)

    # ---- クロップ描画 ----
    def mousePressEvent(self, event) -> None:
        if self._mode == MODE_CROP and event.button() == Qt.LeftButton:
            self._crop_origin = self.mapToScene(event.position().toPoint())
            self._crop_rubber = QGraphicsRectItem(
                QRectF(self._crop_origin, self._crop_origin)
            )
            self._crop_rubber.setPen(QPen(QColor(0, 120, 215), 1.0, Qt.DashLine))
            self._crop_rubber.setBrush(QColor(0, 120, 215, 30))
            self._crop_rubber.setZValue(11000)
            self.scene().addItem(self._crop_rubber)
            event.accept()
            return
        super().mousePressEvent(event)

    def mouseMoveEvent(self, event) -> None:
        if self._mode == MODE_CROP and self._crop_origin is not None:
            cur = self.mapToScene(event.position().toPoint())
            self._crop_rubber.setRect(QRectF(self._crop_origin, cur).normalized())
            event.accept()
            return
        super().mouseMoveEvent(event)

    def mouseReleaseEvent(self, event) -> None:
        if self._mode == MODE_CROP and self._crop_origin is not None:
            cur = self.mapToScene(event.position().toPoint())
            r = QRectF(self._crop_origin, cur).normalized()
            if self._crop_rubber is not None:
                self.scene().removeItem(self._crop_rubber)
                self._crop_rubber = None
            self._crop_origin = None
            if r.width() > 3 and r.height() > 3:
                self.crop_drawn.emit(Rect(r.x(), r.y(), r.width(), r.height()))
            event.accept()
            return
        super().mouseReleaseEvent(event)
