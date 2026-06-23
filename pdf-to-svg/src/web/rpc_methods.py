"""RPC メソッドの実体。

``WebSession`` が複数 PDF・辞書・Undo スタックを保持し、各 ``rpc_*`` 関数が
既存の engine/dictionary/export を薄く包んで JSON 化可能な dict を返す。
ファイルダイアログやスレッドを要する重い処理 (読み込み・書き出し) は Bridge 側で
扱い、ここには「純粋に状態を読む / モデルを更新する」メソッドだけを置く
(→ Qt を起動せずユニットテスト可能)。
"""
from __future__ import annotations

import json
import logging
import os
import tempfile
from pathlib import Path
from typing import Callable, Dict, List, Optional

from dictionary import apply as dict_apply
from dictionary.store import DictionaryStore
from export.svg_exporter import page_to_svg
from model import fonts
from model.document import Document, Page
from model.elements import DictMatch, Rect, RectElement, TextElement

_log = logging.getLogger("pdftosvg")
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
                    # 置換語が収め先の箱幅を超え圧縮表示される恐れ (簡易推定)。
                    "warning": fonts.is_width_overflow(el.text, el.font_size, el.bbox.w),
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


def rpc_dictSuggest(s: WebSession, args: dict) -> dict:
    """クリックした文字要素から辞書「元の語」候補を返す。

    折返しで複数行に分かれた 1 文 (セル) の場合、マッチャと同じ束ね方で連結した
    文字列を返すため、クリック 1 回で文全体を取り込める。単独行は当該行の文字列。
    対象が無ければ空文字 (クライアントはクリック行の textContent にフォールバック)。
    """
    pg = s.page(int(args["fileIndex"]), int(args["pageInFile"]))
    el_id = int(args["elId"])
    el = next(
        (
            e
            for e in pg.elements
            if e.id == el_id and isinstance(e, TextElement) and not e.deleted
        ),
        None,
    )
    if el is None:
        return {"source": ""}
    return {"source": dict_apply.joined_candidate(pg, el)}


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


def _apply_plans(s: WebSession, plans, label: str) -> dict:
    """plans を 1 Undo マクロで適用し {count, warnings} を返す (全ファイル/1ページ共有)。"""
    if not plans:
        return {"count": 0, "warnings": 0}
    warnings = 0
    s.undo.beginMacro(label)
    for rep in plans:
        s.undo.push(
            ReplaceTextCommand(
                rep.element, rep.target,
                DictMatch(source=rep.source, target=rep.target),
                new_bbox=rep.new_bbox,
            )
        )
        if rep.extras:  # 折返しヘッダの 2 行目以降を描画から除外
            s.undo.push(DeleteCommand(rep.extras))
        if rep.warning:  # 置換語が元幅を超え圧縮表示される恐れ
            warnings += 1
            _log.warning("辞書置換 幅超過: %r → %r (%s)", rep.source, rep.target, rep.warning)
    s.undo.endMacro()
    return {"count": len(plans), "warnings": warnings}


def rpc_reapplyDict(s: WebSession, _args: dict) -> dict:
    """全ファイル・全ページに辞書を再適用 (Undo 可・1 マクロ)。置換件数を返す。"""
    plans = []
    for _fi, _pi, pg in s.all_pages():
        dict_apply.detect_headers(pg)
        plans.extend(dict_apply.plan_replacements(pg, s.store, s.only_headers))
    return _apply_plans(s, plans, "辞書適用")


def rpc_reapplyDictPage(s: WebSession, args: dict) -> dict:
    """指定ページにのみ辞書を再適用 (Undo 可・1 マクロ)。置換件数を返す。"""
    pg = s.page(int(args["fileIndex"]), int(args["pageInFile"]))
    dict_apply.detect_headers(pg)
    plans = dict_apply.plan_replacements(pg, s.store, s.only_headers)
    return _apply_plans(s, plans, "辞書適用 (ページ)")


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
    "dictSuggest": rpc_dictSuggest,
    "dictExport": rpc_dictExport,
    "dictImport": rpc_dictImport,
    "dictJson": rpc_dictJson,
    "dictImportJson": rpc_dictImportJson,
    "exportSvg": rpc_exportSvg,
    "setOnlyHeaders": rpc_setOnlyHeaders,
    "reapplyDict": rpc_reapplyDict,
    "reapplyDictPage": rpc_reapplyDictPage,
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
