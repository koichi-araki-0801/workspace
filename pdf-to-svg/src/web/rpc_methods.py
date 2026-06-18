"""RPC メソッドの実体。

``WebSession`` が複数 PDF・辞書・Undo スタックを保持し、各 ``rpc_*`` 関数が
既存の engine/dictionary/export を薄く包んで JSON 化可能な dict を返す。
ファイルダイアログやスレッドを要する重い処理 (読み込み・書き出し) は Bridge 側で
扱い、ここには「純粋に状態を読む / モデルを更新する」メソッドだけを置く
(→ Qt を起動せずユニットテスト可能)。
"""
from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from typing import Callable, Dict, List, Optional

from dictionary import apply as dict_apply
from dictionary.store import DictionaryStore
from export.svg_exporter import page_to_svg
from model.document import Document, Page
from model.elements import DictMatch, Rect, RectElement, TextElement
from web.commands import (
    AddElementCommand,
    DeleteCommand,
    ReplaceTextCommand,
)


class WebSession:
    """Web UI 1 セッション分の状態。"""

    def __init__(self, store: DictionaryStore, undo):
        self.store = store
        self.undo = undo  # QUndoStack (test では push() を持つ任意オブジェクト可)
        self.docs: List[Document] = []
        self.only_headers: bool = True

    # ---- 参照ヘルパ ----
    def doc(self, file_index: int) -> Document:
        return self.docs[file_index]

    def page(self, file_index: int, page_in_file: int) -> Page:
        return self.docs[file_index].pages[page_in_file]

    def all_pages(self):
        """(fileIndex, pageInFile, Page) を順に列挙。"""
        for fi, d in enumerate(self.docs):
            for pi, pg in enumerate(d.pages):
                yield fi, pi, pg


# ---- 状態のスナップショット ----

def _page_has_replacements(page: Page) -> bool:
    return any(
        isinstance(e, TextElement) and not e.deleted and e.dict_match is not None
        for e in page.elements
    )


def _human_size(n: int) -> str:
    if n >= 1024 * 1024:
        return f"{n / 1024 / 1024:.1f} MB"
    if n >= 1024:
        return f"{n / 1024:.0f} KB"
    return f"{n} B"


def _file_size_str(doc: Document) -> str:
    # アップロード経由では実パスが無いので loader が付与した byte_size を使う。
    # 旧来の実パス読み込みでも getsize でフォールバックする。
    n = getattr(doc, "byte_size", None)
    if n is None:
        try:
            n = os.path.getsize(doc.source_path)
        except OSError:
            return ""
    return _human_size(n)


def rpc_state(s: WebSession, _args: dict) -> dict:
    """ファイル・ページ一覧と、各ページの初期レビュー要否 (changed) を返す。"""
    files = []
    pages = []
    changed2: List[bool] = []
    changed3: List[bool] = []
    for fi, d in enumerate(s.docs):
        files.append(
            {
                "id": fi,
                "name": Path(d.source_path).name,
                "pages": len(d.pages),
                "size": _file_size_str(d),
            }
        )
        for pi, pg in enumerate(d.pages):
            pages.append({"fileIndex": fi, "pageInFile": pi})
            # 手順2: 辞書置換が当たったページは「要確認」。
            changed2.append(_page_has_replacements(pg))
            # 手順3: トリミングは全ページが対象 (各ページを見て確認/スキップ)。
            changed3.append(True)
    total = len(pages)
    return {
        "files": files,
        "pages": pages,
        "changed2": changed2,
        "changed3": changed3,
        "total": total,
        "onlyHeaders": s.only_headers,
    }


def rpc_pageSvg(s: WebSession, args: dict) -> dict:
    pg = s.page(args["fileIndex"], args["pageInFile"])
    return {
        "svg": page_to_svg(pg, annotate=True),
        "width": pg.width_pt,
        "height": pg.height_pt,
    }


def rpc_planPage(s: WebSession, args: dict) -> dict:
    pg = s.page(args["fileIndex"], args["pageInFile"])
    changes = []
    for el in pg.elements:
        if isinstance(el, TextElement) and not el.deleted and el.dict_match is not None:
            changes.append(
                {
                    "elId": el.id,
                    "source": el.dict_match.source,
                    "target": el.dict_match.target,
                    "loc": "ヘッダ" if el.is_header else "本文",
                }
            )
    return {"changes": changes}


_KIND_LABEL = {
    "text": "文字",
    "line": "罫線",
    "rect": "矩形",
    "path": "図形",
    "image": "画像",
}


def rpc_removedList(s: WebSession, args: dict) -> dict:
    pg = s.page(args["fileIndex"], args["pageInFile"])
    removed = []
    for el in pg.elements:
        if not el.deleted:
            continue
        label = _KIND_LABEL.get(el.kind, "要素")
        if isinstance(el, TextElement):
            snippet = el.text.strip()[:16]
            label = f"文字「{snippet}」" if snippet else "文字"
        removed.append({"elId": el.id, "kind": el.kind, "label": label})
    return {"removed": removed}


# ---- 辞書 ----

def _dict_payload(s: WebSession) -> dict:
    return {
        "entries": [
            {"id": m.id, "source": m.source_raw, "target": m.target, "enabled": m.enabled}
            for m in s.store.all()
        ],
        "onlyHeaders": s.only_headers,
    }


def rpc_dictList(s: WebSession, _args: dict) -> dict:
    return _dict_payload(s)


def rpc_dictAdd(s: WebSession, args: dict) -> dict:
    src = (args.get("source") or "").strip()
    tgt = (args.get("target") or "").strip()
    if src:
        s.store.upsert(src, tgt)
    return _dict_payload(s)


def rpc_dictDelete(s: WebSession, args: dict) -> dict:
    s.store.delete(int(args["id"]))
    return _dict_payload(s)


def rpc_setOnlyHeaders(s: WebSession, args: dict) -> dict:
    s.only_headers = bool(args.get("value", True))
    return {"onlyHeaders": s.only_headers}


def rpc_dictExport(s: WebSession, args: dict) -> dict:
    """辞書を JSON ファイルへ書き出す (パスは Bridge がダイアログで渡す)。"""
    s.store.export_json(Path(args["path"]))
    return {"count": len(s.store.all()), "path": args["path"]}


def rpc_dictImport(s: WebSession, args: dict) -> dict:
    """JSON ファイルから辞書を取り込む (upsert)。取り込み件数と一覧を返す。"""
    n = s.store.import_json(Path(args["path"]))
    payload = _dict_payload(s)
    payload["imported"] = n
    return payload


def rpc_reapplyDict(s: WebSession, _args: dict) -> dict:
    """全ファイル・全ページに辞書を再適用 (Undo 可・1 マクロ)。置換件数を返す。"""
    plans_all = []
    for _fi, _pi, pg in s.all_pages():
        dict_apply.detect_headers(pg)
        plans_all.extend(
            (pg, rep)
            for rep in dict_apply.plan_replacements(pg, s.store, s.only_headers)
        )
    if not plans_all:
        return {"count": 0}
    s.undo.beginMacro("辞書適用")
    for _pg, rep in plans_all:
        s.undo.push(
            ReplaceTextCommand(
                rep.element, rep.target, DictMatch(source=rep.source, target=rep.target)
            )
        )
        if rep.extras:  # 折返しヘッダの 2 行目以降を描画から除外
            s.undo.push(DeleteCommand(rep.extras))
    s.undo.endMacro()
    return {"count": len(plans_all)}


# ---- 編集 ----

def rpc_applyDelete(s: WebSession, args: dict) -> dict:
    pg = s.page(args["fileIndex"], args["pageInFile"])
    ids = set(int(i) for i in args.get("elIds", []))
    els = [e for e in pg.elements if e.id in ids and not e.deleted]
    if els:
        s.undo.push(DeleteCommand(els))
    return {"deleted": len(els)}


def _bbox_hits(bbox: Rect, rect: Rect) -> bool:
    """要素 bbox が矩形 rect に重なるか。ゼロ寸法 (罫線/点) は内包判定で拾う。"""
    if bbox.w == 0 and bbox.h == 0:
        return rect.x <= bbox.x <= rect.x1 and rect.y <= bbox.y <= rect.y1
    return bbox.intersects(rect)


def rpc_deleteRegion(s: WebSession, args: dict) -> dict:
    """ドラッグした矩形に重なる live 要素をまとめて削除する (範囲削除)。"""
    pg = s.page(args["fileIndex"], args["pageInFile"])
    r = args["rect"]
    rect = Rect(float(r["x"]), float(r["y"]), float(r["w"]), float(r["h"]))
    els = [e for e in pg.live_elements() if _bbox_hits(e.bbox, rect)]
    if els:
        s.undo.push(DeleteCommand(els))
    return {"deleted": len(els)}


def rpc_removeFile(s: WebSession, args: dict) -> dict:
    """追加済み PDF を 1 つ一覧から取り除く。Undo 履歴は旧 doc の要素を参照する
    ため無効化する (アップロードと同方針)。残ったファイル数を返す。"""
    fi = int(args["fileIndex"])
    if 0 <= fi < len(s.docs):
        s.undo.clear()
        s.docs.pop(fi)
    return {"total": len(s.docs)}


def rpc_addBorder(s: WebSession, args: dict) -> dict:
    """ドラッグした矩形に塗りなしの枠線 (RectElement) を 1 つ追加する (Undo 可)。"""
    pg = s.page(args["fileIndex"], args["pageInFile"])
    r = args["rect"]
    rect = Rect(float(r["x"]), float(r["y"]), float(r["w"]), float(r["h"]))
    color = args.get("color") or "#000000"
    width = float(args.get("width") or 1.0)
    z = max((e.z for e in pg.elements), default=0) + 1
    el = RectElement(
        bbox=rect, z=z, rect=rect, stroke=color, fill=None, stroke_width=width
    )
    s.undo.push(AddElementCommand(pg, el))
    return {"elId": el.id}


def rpc_undo(s: WebSession, _args: dict) -> dict:
    if s.undo.canUndo():
        s.undo.undo()
    return {"canUndo": s.undo.canUndo(), "canRedo": s.undo.canRedo()}


def rpc_redo(s: WebSession, _args: dict) -> dict:
    if s.undo.canRedo():
        s.undo.redo()
    return {"canUndo": s.undo.canUndo(), "canRedo": s.undo.canRedo()}


# ---- 書き出し (SVG 文字列を返す。ファイル保存はブラウザの FSA が行う) ----

def rpc_exportSvg(s: WebSession, args: dict) -> dict:
    """指定ページの SVG 文字列と推奨ファイル名を返す (annotate なし=書き出し用・従来出力と一致)。"""
    fi = int(args["fileIndex"])
    pi = int(args["pageInFile"])
    d = s.doc(fi)
    stem = Path(d.source_path).stem
    return {"svg": page_to_svg(d.pages[pi]), "name": f"{stem}_p{pi + 1}.svg"}


# ---- 辞書 JSON (文字列ベース。ファイル保存/読込はブラウザの FSA が行う) ----

def rpc_dictJson(s: WebSession, _args: dict) -> dict:
    """現在の辞書を共有用 JSON 文字列 (実体ファイルと同形式) で返す。"""
    data = [
        {"source": m.source_raw, "target": m.target, "enabled": m.enabled}
        for m in s.store.all()
    ]
    return {"json": json.dumps(data, ensure_ascii=False, indent=2), "count": len(data)}


def rpc_dictImportJson(s: WebSession, args: dict) -> dict:
    """JSON 文字列から辞書を取り込む (upsert)。取り込み件数と一覧を返す。"""
    text = args.get("json") or ""
    fd, tmp = tempfile.mkstemp(suffix=".json")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
        n = s.store.import_json(Path(tmp))
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass
    payload = _dict_payload(s)
    payload["imported"] = n
    return payload


# メソッド名 → 関数。load (アップロード) は server.py が、ファイル保存はブラウザが扱う。
HANDLERS: Dict[str, Callable[[WebSession, dict], dict]] = {
    "state": rpc_state,
    "pageSvg": rpc_pageSvg,
    "planPage": rpc_planPage,
    "removedList": rpc_removedList,
    "dictList": rpc_dictList,
    "dictAdd": rpc_dictAdd,
    "dictDelete": rpc_dictDelete,
    "dictExport": rpc_dictExport,
    "dictImport": rpc_dictImport,
    "dictJson": rpc_dictJson,
    "dictImportJson": rpc_dictImportJson,
    "exportSvg": rpc_exportSvg,
    "setOnlyHeaders": rpc_setOnlyHeaders,
    "reapplyDict": rpc_reapplyDict,
    "applyDelete": rpc_applyDelete,
    "deleteRegion": rpc_deleteRegion,
    "removeFile": rpc_removeFile,
    "addBorder": rpc_addBorder,
    "undo": rpc_undo,
    "redo": rpc_redo,
}


def dispatch(session: WebSession, method: str, args: Optional[dict]) -> dict:
    """純粋メソッドを実行して結果 dict を返す。未知メソッドは KeyError。"""
    handler = HANDLERS[method]
    return handler(session, args or {})
