"""ローカル HTTP サーバ (127.0.0.1 のみ・標準ライブラリ)。

QtWebEngine / QWebChannel を廃し、graph-editor と同じ「小さなローカルサーバ +
ブラウザ (Edge アプリモード)」方式へ。本ハンドラは以下を担う:

- `GET /` ほか: `resources/web/` の静的配信 (拡張子ホワイトリスト + パストラバーサル防止)
- `POST /rpc`: `{method, args}` を受け `rpc_methods.py` の `dispatch` へ流し `{ok, data}` を返す
- `POST /upload?name=...`: PDF バイト列を受け `loader.py` の `load_document_bytes` で読み込む
- `POST /quit` / `POST /ping`: ウィンドウ閉鎖ビーコン / 生存ハートビート (`app.py` のライフサイクル管理用)

ファイル入出力 (PDF を開く / SVG を保存) はブラウザ側の File System Access API が担い、
本サーバはバイト列の受け渡しと純粋な状態操作だけを行う (graph-editor と同じ思想)。
`ThreadingHTTPServer` のため、セッション状態の変更は `server.lock` で直列化する。
"""
from __future__ import annotations

import http.server
import json
import os
import threading
import time
from urllib.parse import parse_qs, unquote, urlsplit

from dictionary import apply as dict_apply
from web import loader, rpc_methods
from web.rpc_methods import WebSession

# 静的配信を許す拡張子と MIME (旧 `scheme.py` の `_MIME` を踏襲)。
_MIME = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".woff2": "font/woff2",
    ".woff": "font/woff",
    ".ttf": "font/ttf",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".ico": "image/x-icon",
}


class Handler(http.server.BaseHTTPRequestHandler):
    """静的配信 + RPC + アップロード + ライフサイクルビーコンの最小ハンドラ。"""

    # ローカル単一ユーザ用途。アクセスログは出さない。
    def log_message(self, *args):
        pass

    # ── 送信ヘルパ ──
    def _send(self, code, body=b"", ctype="text/plain; charset=utf-8"):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if body:
            self.wfile.write(body)

    def _send_json(self, obj, code=200):
        self._send(code, json.dumps(obj, ensure_ascii=False),
                   "application/json; charset=utf-8")

    def _touch(self):
        self.server.last_seen = time.monotonic()

    # ── GET (静的配信) ──
    def do_GET(self):
        self._touch()
        path = urlsplit(self.path).path
        if path in ("/", "/index.html"):
            self._serve_file("index.html")
        elif path == "/favicon.ico":
            self._send(204)
        else:
            self._serve_file(path.lstrip("/"))

    def _serve_file(self, rel: str):
        """`resources/web` 配下のファイルを配信する。拡張子ホワイトリスト一致かつ
        解決後パスがルート配下のものだけを返す (パストラバーサル防止)。それ以外は 404。"""
        root = self.server.web_root
        ctype = _MIME.get(os.path.splitext(rel)[1].lower())
        if not rel or ctype is None:
            self._send(404, b"not found")
            return
        full = os.path.normpath(os.path.join(root, rel))
        if full != root and not full.startswith(root + os.sep):
            self._send(404, b"not found")
            return
        try:
            with open(full, "rb") as f:
                body = f.read()
        except OSError:
            self._send(404, b"not found")
            return
        self._send(200, body, ctype)

    # ── POST ──
    def do_POST(self):
        self._touch()
        path = urlsplit(self.path).path
        if path == "/rpc":
            self._handle_rpc()
        elif path == "/upload":
            self._handle_upload()
        elif path == "/quit":
            self._send(204)
            self.server.quit_event.set()
        elif path == "/ping":
            self._send(204)
        else:
            self._send(404, b"not found")

    def _read_body(self) -> bytes:
        """Content-Length 分を確実に読み切る (大きな PDF での短絡読み防止)。"""
        n = int(self.headers.get("Content-Length") or 0)
        buf = bytearray()
        while len(buf) < n:
            chunk = self.rfile.read(n - len(buf))
            if not chunk:
                break
            buf.extend(chunk)
        return bytes(buf)

    def _handle_rpc(self):
        try:
            req = json.loads(self._read_body() or b"{}")
            method = req.get("method")
            args = req.get("args") or {}
        except (json.JSONDecodeError, AttributeError) as exc:
            self._send_json({"ok": False, "error": f"bad request: {exc}"}, 400)
            return
        try:
            with self.server.lock:
                data = rpc_methods.dispatch(self.server.session, method, args)
        except KeyError:
            self._send_json({"ok": False, "error": f"unknown method: {method}"})
        except Exception as exc:  # noqa: BLE001
            self._send_json({"ok": False, "error": str(exc)})
        else:
            self._send_json({"ok": True, "data": data})

    def _handle_upload(self):
        qs = parse_qs(urlsplit(self.path).query)
        name = unquote((qs.get("name") or ["document.pdf"])[0])
        data = self._read_body()
        try:
            session = self.server.session
            with self.server.lock:
                # 新規読み込みは編集履歴をリセットする (アップロードは履歴を積まない)。
                session.undo.clear()
                doc = loader.load_document_bytes(name, data)
                for page in doc.pages:
                    dict_apply.auto_apply(page, session.store,
                                          only_headers=session.only_headers)
                session.docs.append(doc)
        except Exception as exc:  # noqa: BLE001
            self._send_json({"ok": False, "error": str(exc)})
        else:
            self._send_json({"ok": True, "data": {"total": len(session.docs)}})


def create_server(web_root: str, session: WebSession) -> http.server.ThreadingHTTPServer:
    """127.0.0.1 の空きポートで待ち受けるサーバを構築する (まだ serve はしない)。"""
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.web_root = os.path.abspath(web_root)
    server.session = session
    server.lock = threading.Lock()
    server.quit_event = threading.Event()
    server.last_seen = time.monotonic()
    return server
