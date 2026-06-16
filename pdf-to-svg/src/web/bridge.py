"""QWebChannel に公開する Bridge。JS からの RPC を受けてバックエンドを駆動する。

通信は「要求/応答」方式:
  JS  -> ``call(json)``           {reqId, method, args}
  Py  -> ``result(json)`` シグナル {reqId, ok, data} または {reqId, ok:false, error}

重い処理 (複数 PDF 読み込み・SVG 書き出し) は QThreadPool のワーカーで実行し、
UI を固めない。ファイルダイアログは GUI スレッド (call 内) で開く。
それ以外の純粋メソッドは ``rpc_methods.dispatch`` へ即時ディスパッチする。
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Callable, List, Optional

from PySide6.QtCore import QObject, QRunnable, QThreadPool, Signal, Slot
from PySide6.QtGui import QUndoStack
from PySide6.QtWidgets import QFileDialog

from config import dictionary_json_path
from dictionary import apply as dict_apply
from dictionary.store import DictionaryStore
from engine.pdf_engine import load_document
from export.svg_exporter import page_to_svg
from web import rpc_methods
from web.rpc_methods import WebSession

ASYNC_METHODS = {"load", "exportPage", "exportAll", "exportPages"}
# ダイアログでパスを得てから通常 dispatch する軽量メソッド (IO は極小・同期で十分)
DIALOG_METHODS = {"dictExport", "dictImport"}


class _TaskSignals(QObject):
    done = Signal(str, str)  # reqId, data(JSON)
    fail = Signal(str, str)  # reqId, error
    progress = Signal(str)   # message


class _Task(QRunnable):
    def __init__(self, req_id: str, fn: Callable[[Callable[[str], None]], dict],
                 signals: _TaskSignals):
        super().__init__()
        self.req_id = req_id
        self.fn = fn
        self.signals = signals

    def run(self) -> None:  # ワーカースレッド
        try:
            data = self.fn(self.signals.progress.emit)
        except Exception as exc:  # noqa: BLE001
            self.signals.fail.emit(self.req_id, str(exc))
        else:
            self.signals.done.emit(self.req_id, json.dumps(data, ensure_ascii=False))


class Bridge(QObject):
    result = Signal(str)
    progress = Signal(str)

    def __init__(self, window, parent=None):
        super().__init__(parent)
        self._window = window
        self.store = DictionaryStore(dictionary_json_path())
        self.undo = QUndoStack(self)
        self.session = WebSession(self.store, self.undo)
        self._pool = QThreadPool.globalInstance()
        self._signals = _TaskSignals()
        self._signals.done.connect(self._on_task_done)
        self._signals.fail.connect(self._on_task_fail)
        self._signals.progress.connect(self.progress)

    # ---- JS からの入口 ----
    @Slot(str)
    def call(self, req_json: str) -> None:
        try:
            req = json.loads(req_json)
            req_id = str(req.get("reqId"))
            method = req.get("method")
            args = req.get("args") or {}
        except (json.JSONDecodeError, TypeError) as exc:
            self._emit_err("?", f"bad request: {exc}")
            return

        if method in ASYNC_METHODS:
            self._handle_async(req_id, method, args)
            return
        if method in DIALOG_METHODS:
            path = self._dialog_path(method)
            if path is None:
                self._emit_ok(req_id, {"cancelled": True})
                return
            args["path"] = path
        try:
            data = rpc_methods.dispatch(self.session, method, args)
        except KeyError:
            self._emit_err(req_id, f"unknown method: {method}")
        except Exception as exc:  # noqa: BLE001
            self._emit_err(req_id, str(exc))
        else:
            self._emit_ok(req_id, data)

    # ---- 応答 ----
    def _emit_ok(self, req_id: str, data) -> None:
        self.result.emit(json.dumps({"reqId": req_id, "ok": True, "data": data},
                                    ensure_ascii=False))

    def _emit_err(self, req_id: str, error: str) -> None:
        self.result.emit(json.dumps({"reqId": req_id, "ok": False, "error": error},
                                    ensure_ascii=False))

    def _on_task_done(self, req_id: str, data_json: str) -> None:
        self._emit_ok(req_id, json.loads(data_json))

    def _on_task_fail(self, req_id: str, error: str) -> None:
        self._emit_err(req_id, error)

    # ---- ダイアログ (辞書 JSON 入出力) ----
    def _dialog_path(self, method: str):
        if method == "dictExport":
            path, _ = QFileDialog.getSaveFileName(
                self._window, "辞書を書き出す", "dictionary.json", "JSON (*.json)"
            )
        else:  # dictImport
            path, _ = QFileDialog.getOpenFileName(
                self._window, "辞書を読み込む", "", "JSON (*.json)"
            )
        return path or None

    # ---- 非同期 (ダイアログ→ワーカー) ----
    def _handle_async(self, req_id: str, method: str, args: dict) -> None:
        if method == "load":
            self._start_load(req_id)
        elif method == "exportPage":
            self._start_export(req_id, scope="page", args=args)
        elif method == "exportAll":
            self._start_export(req_id, scope="all", args=args)
        elif method == "exportPages":
            self._start_export(req_id, scope="list", args=args)

    def _start_load(self, req_id: str) -> None:
        paths, _ = QFileDialog.getOpenFileNames(
            self._window, "PDF を開く", "", "PDF (*.pdf)"
        )
        if not paths:
            self._emit_ok(req_id, {"cancelled": True})
            return
        session = self.session
        store = self.store
        only_headers = session.only_headers
        # 新規読み込み時は履歴をリセット (GUI スレッド)
        self.undo.clear()

        def work(emit_progress) -> dict:
            for i, p in enumerate(paths, 1):
                emit_progress(f"読み込み中 {i}/{len(paths)}: {Path(p).name}")
                doc = load_document(p)
                for page in doc.pages:
                    dict_apply.auto_apply(page, store, only_headers=only_headers)
                session.docs.append(doc)
            return rpc_methods.rpc_state(session, {})

        self._pool.start(_Task(req_id, work, self._signals))

    def _start_export(self, req_id: str, scope: str, args: dict) -> None:
        session = self.session
        if not session.docs:
            self._emit_ok(req_id, {"count": 0})
            return

        if scope == "page":
            fi = int(args["fileIndex"])
            pi = int(args["pageInFile"])
            stem = Path(session.docs[fi].source_path).stem
            default = f"{stem}_p{pi + 1}.svg"
            path, _ = QFileDialog.getSaveFileName(
                self._window, "SVG 書出", default, "SVG (*.svg)"
            )
            if not path:
                self._emit_ok(req_id, {"cancelled": True})
                return
            page = session.docs[fi].pages[pi]

            def work_page(emit_progress) -> dict:
                Path(path).write_text(page_to_svg(page), encoding="utf-8")
                return {"count": 1, "path": path}

            self._pool.start(_Task(req_id, work_page, self._signals))
            return

        if scope == "list":
            # フロントが組み立てた (fileIndex, pageInFile) の明示リストだけを書き出す。
            # ページ番号は元のまま (_p{pageInFile + 1}.svg) を保つ。
            targets = []
            for it in (args.get("pages") or []):
                fi = int(it["fileIndex"])
                pi = int(it["pageInFile"])
                targets.append((fi, pi))
            if not targets:
                self._emit_ok(req_id, {"count": 0})
                return
            folder = QFileDialog.getExistingDirectory(self._window, "書き出し先フォルダ")
            if not folder:
                self._emit_ok(req_id, {"cancelled": True})
                return

            def work_list(emit_progress) -> dict:
                out_dir = Path(folder)
                total = len(targets)
                for done, (fi, pi) in enumerate(targets, 1):
                    d = session.docs[fi]
                    stem = Path(d.source_path).stem
                    (out_dir / f"{stem}_p{pi + 1}.svg").write_text(
                        page_to_svg(d.pages[pi]), encoding="utf-8"
                    )
                    emit_progress(f"書き出し中 {done}/{total}")
                return {"count": total, "folder": str(out_dir)}

            self._pool.start(_Task(req_id, work_list, self._signals))
            return

        # scope == "all"
        folder = QFileDialog.getExistingDirectory(self._window, "書き出し先フォルダ")
        if not folder:
            self._emit_ok(req_id, {"cancelled": True})
            return

        def work_all(emit_progress) -> dict:
            out_dir = Path(folder)
            total = sum(len(d.pages) for d in session.docs)
            done = 0
            for d in session.docs:
                stem = Path(d.source_path).stem
                for i, page in enumerate(d.pages, 1):
                    (out_dir / f"{stem}_p{i}.svg").write_text(
                        page_to_svg(page), encoding="utf-8"
                    )
                    done += 1
                    emit_progress(f"書き出し中 {done}/{total}")
            return {"count": total, "folder": str(out_dir)}

        self._pool.start(_Task(req_id, work_all, self._signals))

    def close(self) -> None:
        self.store.close()
