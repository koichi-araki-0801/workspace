"""辞書管理ドックパネル。

マッピングの一覧/追加/編集/削除、JSON 入出力、現在ページへの適用を行う。
"""
from __future__ import annotations

from pathlib import Path
from typing import Callable, Optional

from PySide6.QtCore import Qt, Signal
from PySide6.QtWidgets import (
    QAbstractItemView,
    QCheckBox,
    QFileDialog,
    QHBoxLayout,
    QHeaderView,
    QInputDialog,
    QLineEdit,
    QMessageBox,
    QPushButton,
    QTableWidget,
    QTableWidgetItem,
    QVBoxLayout,
    QWidget,
)

from dictionary.store import DictionaryStore


class DictionaryPanel(QWidget):
    apply_requested = Signal(bool)  # only_headers

    def __init__(self, store: DictionaryStore, parent=None):
        super().__init__(parent)
        self.store = store
        self._build_ui()
        self.reload()

    def _build_ui(self) -> None:
        layout = QVBoxLayout(self)

        # 追加フォーム
        form = QHBoxLayout()
        self.src_edit = QLineEdit()
        self.src_edit.setPlaceholderText("元の語")
        self.tgt_edit = QLineEdit()
        self.tgt_edit.setPlaceholderText("置換後")
        add_btn = QPushButton("追加")
        add_btn.clicked.connect(self._on_add)
        form.addWidget(self.src_edit)
        form.addWidget(self.tgt_edit)
        form.addWidget(add_btn)
        layout.addLayout(form)

        # 一覧
        self.table = QTableWidget(0, 3)
        self.table.setHorizontalHeaderLabels(["元の語", "置換後", "有効"])
        self.table.horizontalHeader().setSectionResizeMode(0, QHeaderView.Stretch)
        self.table.horizontalHeader().setSectionResizeMode(1, QHeaderView.Stretch)
        self.table.setEditTriggers(QAbstractItemView.NoEditTriggers)
        self.table.setSelectionBehavior(QAbstractItemView.SelectRows)
        layout.addWidget(self.table)

        # 行操作
        row_ops = QHBoxLayout()
        del_btn = QPushButton("削除")
        del_btn.clicked.connect(self._on_delete)
        row_ops.addWidget(del_btn)
        layout.addLayout(row_ops)

        # 適用オプション
        self.headers_only = QCheckBox("ヘッダのみに適用")
        self.headers_only.setChecked(True)
        layout.addWidget(self.headers_only)

        apply_btn = QPushButton("現在ページに適用")
        apply_btn.clicked.connect(
            lambda: self.apply_requested.emit(self.headers_only.isChecked())
        )
        layout.addWidget(apply_btn)

        # JSON 入出力
        io = QHBoxLayout()
        imp = QPushButton("JSON 取込")
        imp.clicked.connect(self._on_import)
        exp = QPushButton("JSON 書出")
        exp.clicked.connect(self._on_export)
        io.addWidget(imp)
        io.addWidget(exp)
        layout.addLayout(io)

    def only_headers(self) -> bool:
        return self.headers_only.isChecked()

    def reload(self) -> None:
        rows = self.store.all()
        self.table.setRowCount(len(rows))
        for i, m in enumerate(rows):
            src = QTableWidgetItem(m.source_raw)
            src.setData(Qt.UserRole, m.id)
            self.table.setItem(i, 0, src)
            self.table.setItem(i, 1, QTableWidgetItem(m.target))
            self.table.setItem(i, 2, QTableWidgetItem("✓" if m.enabled else ""))

    def prefill_source(self, text: str) -> None:
        self.src_edit.setText(text)
        self.tgt_edit.setFocus()

    # ---- ハンドラ ----
    def _on_add(self) -> None:
        src = self.src_edit.text().strip()
        tgt = self.tgt_edit.text().strip()
        if not src:
            return
        self.store.upsert(src, tgt)
        self.src_edit.clear()
        self.tgt_edit.clear()
        self.reload()

    def _on_delete(self) -> None:
        row = self.table.currentRow()
        if row < 0:
            return
        mid = self.table.item(row, 0).data(Qt.UserRole)
        self.store.delete(mid)
        self.reload()

    def _on_import(self) -> None:
        path, _ = QFileDialog.getOpenFileName(self, "辞書 JSON を取込", "", "JSON (*.json)")
        if path:
            n = self.store.import_json(Path(path))
            self.reload()
            QMessageBox.information(self, "取込", f"{n} 件を取り込みました。")

    def _on_export(self) -> None:
        path, _ = QFileDialog.getSaveFileName(self, "辞書 JSON を書出", "dictionary.json", "JSON (*.json)")
        if path:
            self.store.export_json(Path(path))
