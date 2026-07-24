# =============================================================================
# e2e_server.py — Playwright E2E 用のサーバ起動 (Edge を開かず固定ポートで待受)
# =============================================================================
# `src/app.py` の main() から「Edge 起動・watchdog・終了管理」を除いた最小構成。
# 本番は空きポート (port 0) だが、E2E は playwright.config.ts の baseURL と合わせる
# ため固定ポート 5180 で待ち受ける。辞書はテンポラリに置き、実環境の
# data/dictionary.json を汚さない。終了は Playwright webServer のプロセス kill に任せる。
from __future__ import annotations

import http.server
import os
import sys
import tempfile
import threading
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

import config  # noqa: E402
from dictionary.store import DictionaryStore  # noqa: E402
from web.rpc_methods import WebSession  # noqa: E402
from web.server import Handler  # noqa: E402
from web.undo_stack import UndoStack  # noqa: E402

PORT = 5180


def main() -> None:
    tmp = tempfile.mkdtemp(prefix="pdftosvg-e2e-")
    store = DictionaryStore(os.path.join(tmp, "dictionary.json"))
    session = WebSession(store, UndoStack())
    # `create_server` は port 0 で bind してしまうため、同じ属性構成で固定ポート版を組む。
    server = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    server.web_root = os.path.abspath(str(config.resource_path("web")))
    server.session = session
    server.lock = threading.Lock()
    server.quit_event = threading.Event()
    server.last_seen = time.monotonic()
    print(f"e2e server listening on http://127.0.0.1:{PORT}/", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
