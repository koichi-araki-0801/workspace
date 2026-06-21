"""新シェル (HTTP + 文字列ベース I/O) の RPC を検証する。

- `exportSvg`: 書き出し用 SVG 文字列 (annotate なし) と推奨ファイル名を返す
- `dictJson` / `dictImportJson`: 文字列ベースの辞書入出力 (ブラウザ FSA が保存/読込)
- `reapplyDict` + `UndoStack`: マクロが 1 回の undo で戻る (実 `UndoStack` で end-to-end)
- HTTP smoke: ローカルサーバを立て /、/rpc、/upload を `urllib` で叩く (旧 `smoke_web.py` 置換)
"""
from __future__ import annotations

import json
import threading
import urllib.request
from pathlib import Path

import config
from dictionary.store import DictionaryStore
from model.document import Document, Page
from model.elements import Rect, TextElement
from web import rpc_methods
from web.rpc_methods import WebSession
from web.server import create_server
from web.undo_stack import UndoStack


def _session(tmp_path) -> WebSession:
    return WebSession(DictionaryStore(tmp_path / "dict.json"), UndoStack())


def _doc_two_body() -> Document:
    page = Page(index=0, width_pt=200.0, height_pt=300.0)
    a = TextElement(bbox=Rect(10, 40, 60, 12), text="A-1042", origin_x=10, origin_y=50)
    b = TextElement(bbox=Rect(10, 60, 60, 12), text="B-2055", origin_x=10, origin_y=70)
    page.elements = [a, b]
    return Document(source_path="部品表.pdf", pages=[page])


def test_export_svg_returns_string_and_name(tmp_path):
    s = _session(tmp_path)
    s.docs = [_doc_two_body()]
    res = rpc_methods.dispatch(s, "exportSvg", {"fileIndex": 0, "pageInFile": 0})
    assert res["svg"].startswith("<?xml") or "<svg" in res["svg"]
    assert "data-el=" not in res["svg"]  # 書き出しは annotate なし (従来出力と一致)
    assert res["name"] == "部品表_p1.svg"


def test_dict_json_roundtrip(tmp_path):
    s1 = _session(tmp_path / "a")
    (tmp_path / "a").mkdir()
    rpc_methods.dispatch(s1, "dictAdd", {"source": "Item No.", "target": "品番"})
    rpc_methods.dispatch(s1, "dictAdd", {"source": "Q'ty", "target": "数量"})
    out = rpc_methods.dispatch(s1, "dictJson", {})
    assert out["count"] == 2
    # 文字列は実体ファイルと同形式
    parsed = json.loads(out["json"])
    assert {e["source"] for e in parsed} == {"Item No.", "Q'ty"}

    s2 = _session(tmp_path / "b")
    (tmp_path / "b").mkdir()
    imp = rpc_methods.dispatch(s2, "dictImportJson", {"json": out["json"]})
    assert imp["imported"] == 2
    assert {e["source"] for e in imp["entries"]} == {"Item No.", "Q'ty"}


def test_reapply_macro_reverts_in_one_undo(tmp_path):
    s = _session(tmp_path)
    s.docs = [_doc_two_body()]
    a, b = s.docs[0].pages[0].elements
    rpc_methods.dispatch(s, "dictAdd", {"source": "A-1042", "target": "AAA"})
    rpc_methods.dispatch(s, "dictAdd", {"source": "B-2055", "target": "BBB"})
    rpc_methods.dispatch(s, "setOnlyHeaders", {"value": False})
    r = rpc_methods.dispatch(s, "reapplyDict", {})
    assert r["count"] == 2 and a.text == "AAA" and b.text == "BBB"
    # マクロなので 1 回の undo で両方戻る
    rpc_methods.dispatch(s, "undo", {})
    assert a.text == "A-1042" and b.text == "B-2055"


def _post(url: str, data: bytes, ctype: str):
    req = urllib.request.Request(
        url, data=data, headers={"Content-Type": ctype}, method="POST"
    )
    with urllib.request.urlopen(req) as r:
        return r.status, r.read()


def test_http_shell_smoke(tmp_path, vector_pdf):
    s = _session(tmp_path)
    server = create_server(str(config.resource_path("web")), s)
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{port}"
    try:
        # GET / → HTML
        with urllib.request.urlopen(base + "/") as r:
            assert r.status == 200
            assert b"<html" in r.read().lower()
        # POST /rpc {state} → ok, total 0
        _, body = _post(base + "/rpc",
                        json.dumps({"method": "state", "args": {}}).encode(),
                        "application/json")
        assert json.loads(body)["data"]["total"] == 0
        # POST /upload (実 PDF バイト) → 取り込み
        pdf = Path(vector_pdf).read_bytes()
        _, body = _post(base + "/upload?name=sample.pdf", pdf, "application/octet-stream")
        assert json.loads(body)["ok"] is True
        # state が total>0 に
        _, body = _post(base + "/rpc",
                        json.dumps({"method": "state", "args": {}}).encode(),
                        "application/json")
        assert json.loads(body)["data"]["total"] >= 1
        # exportSvg → SVG 文字列 + 推奨名
        _, body = _post(base + "/rpc",
                        json.dumps({"method": "exportSvg",
                                    "args": {"fileIndex": 0, "pageInFile": 0}}).encode(),
                        "application/json")
        data = json.loads(body)["data"]
        assert "<svg" in data["svg"] and data["name"] == "sample_p1.svg"
    finally:
        server.shutdown()
        server.server_close()
        s.store.close()
