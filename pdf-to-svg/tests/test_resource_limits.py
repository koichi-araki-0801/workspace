"""資源上限 (P005 / P012) の退行ガード。

「正しい入力を正しく処理する」ではなく**「迂回入力で破綻しない」**を主張する形で書く。
"""

from __future__ import annotations

import json
import threading
import time
import urllib.error
import urllib.request

import pytest

from engine.pdf_engine import (
    MAX_RASTER_PIXELS,
    MIN_RENDER_SCALE,
    RasterBudget,
    _render_background,
)
from web.server import MAX_RPC_BYTES, MAX_UPLOAD_BYTES

fitz = pytest.importorskip("fitz")


def _page_of(width_pt: float, height_pt: float):
    """指定 MediaBox の 1 ページ PDF を開いて返す (呼び出し側で close)。"""
    doc = fitz.open()
    doc.new_page(width=width_pt, height=height_pt)
    return doc


# ── P005: ラスタ化のピクセル予算 ────────────────────────────────────────────

def test_huge_mediabox_is_rendered_within_the_pixel_budget():
    """20000x20000 pt の PDF は実体 3.6KB で 4.8 GB を確保し 36〜42 秒かかっていた。

    倍率を下げて上限内へ収め、秒オーダーで返ることを主張する。
    """
    doc = _page_of(20_000, 20_000)
    try:
        t0 = time.perf_counter()
        bg = _render_background(doc[0], RasterBudget())
        elapsed = time.perf_counter() - t0
    finally:
        doc.close()
    # `MIN_RENDER_SCALE` まで下げても 20000x20000 は上限を超えるので背景は諦める。
    assert bg is None
    assert elapsed < 5.0


def test_scale_is_reduced_rather_than_refused_when_it_fits():
    """縮小すれば収まるページは degrade して背景を作る (無言の停止より可視な劣化)。"""
    # 5000x5000 pt: 等倍で 25M px (上限超過)、0.5 倍で 6.25M px (収まる)。
    doc = _page_of(5_000, 5_000)
    try:
        bg = _render_background(doc[0], RasterBudget())
    finally:
        doc.close()
    assert bg is not None
    # rect は論理座標のままで、ラスタ倍率が変わっても配置は変わらない。
    assert bg.rect.w == pytest.approx(5_000)


def test_document_budget_stops_many_in_limit_pages():
    """1 ページの上限だけでは「上限内のページを大量に並べる」形を止められない。"""
    budget = RasterBudget(total=MAX_RASTER_PIXELS)  # 1 ページぶんだけの予算
    doc = _page_of(2_000, 2_000)  # 等倍 16M px = ちょうど上限
    try:
        first = _render_background(doc[0], budget)
        second = _render_background(doc[0], budget)
    finally:
        doc.close()
    assert first is not None
    assert second is None


def test_a4_at_the_default_scale_is_untouched():
    """通常の A4 は上限にかからない (上限が正当な運用を止めていないこと)。"""
    doc = _page_of(595, 842)
    try:
        bg = _render_background(doc[0], RasterBudget())
    finally:
        doc.close()
    assert bg is not None
    assert MIN_RENDER_SCALE < 1.0  # 縮小の下限は 1.0 未満 (縮小が起きうる形)


# ── P012: リクエスト本文の上限 ─────────────────────────────────────────────

def _post(base: str, path: str, body: bytes, content_length: int | None = None,
          content_type: str = "application/json"):
    """A2 の Origin/Host/content-type ガードを満たした上で本文上限だけを試す。"""
    req = urllib.request.Request(base + path, data=body, method="POST")
    if content_length is not None:
        req.add_header("Content-Length", str(content_length))
    req.add_header("Origin", base)
    req.add_header("Content-Type", content_type)
    return urllib.request.urlopen(req, timeout=10)


@pytest.fixture()
def running_server(tmp_path):
    import config
    from dictionary.store import DictionaryStore
    from web.rpc_methods import WebSession
    from web.server import create_server
    from web.undo_stack import UndoStack

    session = WebSession(DictionaryStore(tmp_path / "dict.json"), UndoStack())
    server = create_server(str(config.resource_path("web")), session)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}"
    finally:
        server.shutdown()
        server.server_close()
        session.store.close()


def test_oversized_upload_is_refused_without_reading_the_body(running_server):
    """申告値だけで 413 にする。実体を送りつけなくても拒否されること = 読み切っていない。"""
    with pytest.raises(urllib.error.HTTPError) as ei:
        _post(running_server, "/upload?name=x.pdf", b"", MAX_UPLOAD_BYTES + 1,
              content_type="application/octet-stream")
    assert ei.value.code == 413


def test_oversized_rpc_is_refused(running_server):
    with pytest.raises(urllib.error.HTTPError) as ei:
        _post(running_server, "/rpc", b"", MAX_RPC_BYTES + 1)
    assert ei.value.code == 413


def test_malformed_content_length_is_refused(running_server):
    with pytest.raises(urllib.error.HTTPError) as ei:
        _post(running_server, "/rpc", b"", -1)
    assert ei.value.code == 413


def test_normal_rpc_still_works(running_server):
    """上限が正常系を壊していないこと (拒否だけを固定すると気付けない)。"""
    body = json.dumps({"method": "state", "args": {}}).encode("utf-8")
    with _post(running_server, "/rpc", body) as res:
        payload = json.loads(res.read())
    assert payload["ok"] is True


# ── P033: Undo スタックの深さ上限 ──────────────────────────────────────────

def test_undo_stack_drops_the_oldest_beyond_the_depth_limit():
    """各コマンドは置換前後の要素状態を握るので、無制限に積むとメモリが単調増加する。"""
    from web.undo_stack import MAX_UNDO_DEPTH, UndoStack

    class Noop:
        def redo(self):
            pass

        def undo(self):
            pass

    st = UndoStack()
    for _ in range(MAX_UNDO_DEPTH + 50):
        st.push(Noop())
    assert len(st._stack) == MAX_UNDO_DEPTH
    # 上限に当たっても「戻れる」状態は保たれる (degrade であって機能停止ではない)。
    assert st.canUndo() is True
    for _ in range(MAX_UNDO_DEPTH):
        st.undo()
    assert st.canUndo() is False
