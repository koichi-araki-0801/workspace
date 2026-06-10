"""メインウィンドウ。PDF を開き、編集し、SVG として書き出す。"""
from __future__ import annotations

from pathlib import Path
from typing import List, Optional

from PySide6.QtCore import Qt
from PySide6.QtGui import QAction, QKeySequence, QUndoStack
from PySide6.QtWidgets import (
    QDockWidget,
    QFileDialog,
    QLabel,
    QMainWindow,
    QMessageBox,
    QToolBar,
)

from config import dictionary_json_path
from dictionary import apply as dict_apply
from dictionary.store import DictionaryStore
from editor.commands import CropCommand, DeleteCommand, ReplaceTextCommand
from editor.scene import DocumentScene
from editor.view import MODE_CROP, MODE_SELECT, EditorView
from engine.pdf_engine import load_document
from export.svg_exporter import page_to_svg
from model.document import Document
from model.elements import DictMatch, TextElement
from ui.dictionary_panel import DictionaryPanel


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("PdfToSvg — PDF→SVG 変換・編集")
        self.resize(1100, 800)

        self.store = DictionaryStore(dictionary_json_path())
        self.undo_stack = QUndoStack(self)
        self.document: Optional[Document] = None
        self.scenes: List[DocumentScene] = []
        self.page_index = 0

        self.view = EditorView()
        self.view.delete_requested.connect(self._delete_selected)
        self.view.crop_drawn.connect(self._on_crop_drawn)
        self.setCentralWidget(self.view)

        self.page_label = QLabel("  ページ: -/-  ")
        self.statusBar().addPermanentWidget(self.page_label)

        self._build_actions()
        self._build_toolbar()
        self._build_dock()

    # ---- UI 構築 ----
    def _build_actions(self) -> None:
        self.act_open = QAction("開く…", self)
        self.act_open.setShortcut(QKeySequence.Open)
        self.act_open.triggered.connect(self._open_pdf)

        self.act_export_page = QAction("このページを SVG 書出…", self)
        self.act_export_page.triggered.connect(self._export_current_page)
        self.act_export_all = QAction("全ページを SVG 書出…", self)
        self.act_export_all.triggered.connect(self._export_all_pages)

        self.act_undo = self.undo_stack.createUndoAction(self, "元に戻す")
        self.act_undo.setShortcut(QKeySequence.Undo)
        self.act_redo = self.undo_stack.createRedoAction(self, "やり直し")
        self.act_redo.setShortcut(QKeySequence.Redo)

        self.act_select = QAction("選択", self, checkable=True)
        self.act_select.setChecked(True)
        self.act_select.triggered.connect(lambda: self._set_mode(MODE_SELECT))
        self.act_crop = QAction("クロップ", self, checkable=True)
        self.act_crop.triggered.connect(lambda: self._set_mode(MODE_CROP))
        self.act_clear_crop = QAction("クロップ解除", self)
        self.act_clear_crop.triggered.connect(self._clear_crop)

        self.act_delete = QAction("選択を削除", self)
        self.act_delete.triggered.connect(self._delete_selected)

        self.act_add_dict = QAction("選択を辞書に追加", self)
        self.act_add_dict.triggered.connect(self._add_selection_to_dict)

        self.act_prev = QAction("◀ 前", self)
        self.act_prev.triggered.connect(lambda: self._goto_page(self.page_index - 1))
        self.act_next = QAction("次 ▶", self)
        self.act_next.triggered.connect(lambda: self._goto_page(self.page_index + 1))

    def _build_toolbar(self) -> None:
        tb = QToolBar("メイン")
        tb.setMovable(False)
        self.addToolBar(tb)
        for a in (self.act_open, self.act_export_page, self.act_export_all):
            tb.addAction(a)
        tb.addSeparator()
        tb.addAction(self.act_undo)
        tb.addAction(self.act_redo)
        tb.addSeparator()
        tb.addAction(self.act_select)
        tb.addAction(self.act_crop)
        tb.addAction(self.act_clear_crop)
        tb.addAction(self.act_delete)
        tb.addSeparator()
        tb.addAction(self.act_add_dict)
        tb.addSeparator()
        tb.addAction(self.act_prev)
        tb.addAction(self.act_next)

    def _build_dock(self) -> None:
        self.dict_panel = DictionaryPanel(self.store)
        self.dict_panel.apply_requested.connect(self._apply_dictionary)
        dock = QDockWidget("辞書 (用語統一・翻訳)", self)
        dock.setWidget(self.dict_panel)
        self.addDockWidget(Qt.RightDockWidgetArea, dock)

    # ---- ファイル ----
    def _open_pdf(self) -> None:
        path, _ = QFileDialog.getOpenFileName(self, "PDF を開く", "", "PDF (*.pdf)")
        if not path:
            return
        try:
            self.document = load_document(path)
        except Exception as exc:  # noqa: BLE001
            QMessageBox.critical(self, "読み込みエラー", str(exc))
            return

        self.undo_stack.clear()
        only_headers = self.dict_panel.only_headers()
        applied = 0
        for page in self.document.pages:
            applied += dict_apply.auto_apply(page, self.store, only_headers=only_headers)

        self.scenes = [DocumentScene(p) for p in self.document.pages]
        self.page_index = 0
        self._goto_page(0)
        self.statusBar().showMessage(
            f"{Path(path).name} を読み込みました（辞書自動適用 {applied} 件）", 5000
        )

    def _export_current_page(self) -> None:
        scene = self._current_scene()
        if scene is None:
            return
        path, _ = QFileDialog.getSaveFileName(
            self, "SVG 書出", f"page_{self.page_index + 1}.svg", "SVG (*.svg)"
        )
        if path:
            Path(path).write_text(page_to_svg(scene.page), encoding="utf-8")
            self.statusBar().showMessage(f"書き出しました: {path}", 5000)

    def _export_all_pages(self) -> None:
        if not self.scenes:
            return
        folder = QFileDialog.getExistingDirectory(self, "書き出し先フォルダ")
        if not folder:
            return
        stem = Path(self.document.source_path).stem
        for i, scene in enumerate(self.scenes):
            out = Path(folder) / f"{stem}_p{i + 1}.svg"
            out.write_text(page_to_svg(scene.page), encoding="utf-8")
        self.statusBar().showMessage(f"{len(self.scenes)} ページを書き出しました", 5000)

    # ---- ページ移動 ----
    def _current_scene(self) -> Optional[DocumentScene]:
        if 0 <= self.page_index < len(self.scenes):
            return self.scenes[self.page_index]
        return None

    def _goto_page(self, index: int) -> None:
        if not self.scenes:
            return
        index = max(0, min(index, len(self.scenes) - 1))
        self.page_index = index
        scene = self.scenes[index]
        self.view.setScene(scene)
        self.view.fitInView(scene.sceneRect(), Qt.KeepAspectRatio)
        self.page_label.setText(f"  ページ: {index + 1}/{len(self.scenes)}  ")

    # ---- 編集 ----
    def _set_mode(self, mode: str) -> None:
        self.view.set_mode(mode)
        self.act_select.setChecked(mode == MODE_SELECT)
        self.act_crop.setChecked(mode == MODE_CROP)

    def _delete_selected(self) -> None:
        scene = self._current_scene()
        if scene is None:
            return
        els = scene.selected_elements()
        if els:
            self.undo_stack.push(DeleteCommand(scene, els))

    def _on_crop_drawn(self, rect) -> None:
        scene = self._current_scene()
        if scene is None:
            return
        self.undo_stack.push(CropCommand(scene, rect))
        self._set_mode(MODE_SELECT)

    def _clear_crop(self) -> None:
        scene = self._current_scene()
        if scene is not None and scene.page.crop_rect is not None:
            self.undo_stack.push(CropCommand(scene, None))

    def _add_selection_to_dict(self) -> None:
        scene = self._current_scene()
        if scene is None:
            return
        for el in scene.selected_elements():
            if isinstance(el, TextElement):
                self.dict_panel.prefill_source(el.text)
                return
        QMessageBox.information(self, "辞書追加", "テキスト要素を選択してください。")

    def _apply_dictionary(self, only_headers: bool) -> None:
        scene = self._current_scene()
        if scene is None:
            return
        dict_apply.detect_headers(scene.page)
        plans = dict_apply.plan_replacements(scene.page, self.store, only_headers)
        if not plans:
            self.statusBar().showMessage("一致する辞書項目がありませんでした", 4000)
            return
        self.undo_stack.beginMacro("辞書適用")
        for rep in plans:
            self.undo_stack.push(
                ReplaceTextCommand(
                    scene, rep.element, rep.target,
                    DictMatch(source=rep.source, target=rep.target),
                )
            )
        self.undo_stack.endMacro()
        self.statusBar().showMessage(f"{len(plans)} 件を置換しました", 4000)

    def closeEvent(self, event) -> None:
        self.store.close()
        super().closeEvent(event)
