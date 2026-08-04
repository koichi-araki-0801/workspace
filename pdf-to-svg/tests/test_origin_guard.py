"""同一オリジン検査 (`web/origin_guard.py`) の迂回耐性を外形から固定する。

主張の形は「**迂回入力では 403 になり、かつ副作用が発生していない**」。ステータスだけを
見ると「実行してから 403 を返す」実装 (`quit_event` は立ってしまう) を見逃すため、
`quit_event` / `last_seen` / `store` / `docs` を毎回突き合わせる。

ここのテストベクタ表は `graph-editor/tests/test_app_guard.py` と**同一仕様の複製**である
(2 プロジェクトは並行実装で、片方を変えたら両方を変える)。`urllib` は URL から Host を
強制するので `Host: evil.example` を送れない。`http.client` の `putrequest(skip_host=True)`
で任意のリクエスト行・ヘッダを手組みする。
"""
from __future__ import annotations

import http.client
import http.server
import json
import threading
import time

import config
import pytest
from dictionary.store import DictionaryStore
from web import origin_guard
from web.rpc_methods import WebSession
from web.server import Handler, create_server
from web.undo_stack import UndoStack

# 「Host ヘッダを省略する」を `None` と区別するための番兵。
_DEFAULT = object()


@pytest.fixture
def server(tmp_path):
    """`create_server` で組んだ実サーバ (ガード設定済み) を空きポートで走らせる。"""
    session = WebSession(DictionaryStore(tmp_path / "dict.json"), UndoStack())
    srv = create_server(str(config.resource_path("web")), session)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        yield srv
    finally:
        srv.shutdown()
        srv.server_close()
        session.store.close()


def _request(port, method, target, *, host=_DEFAULT, headers=(), body=None, raw_tail=None):
    """リクエスト行とヘッダを手組みして 1 往復する。`(status, body, headers)` を返す。"""
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    try:
        conn.putrequest(method, target, skip_host=True, skip_accept_encoding=True)
        if host is _DEFAULT:
            conn.putheader("Host", f"127.0.0.1:{port}")
        elif host is not None:
            conn.putheader("Host", host)
        for name, value in headers:
            conn.putheader(name, value)
        if body is not None and not any(n.lower() == "transfer-encoding" for n, _ in headers):
            conn.putheader("Content-Length", str(len(body)))
        conn.endheaders()
        if body is not None:
            conn.send(body)
        if raw_tail is not None:
            conn.send(raw_tail)
        res = conn.getresponse()
        return res.status, res.read(), res.headers
    finally:
        conn.close()


def _rpc(port, method, args, *, origin=_DEFAULT, ctype="application/json", host=_DEFAULT):
    headers = []
    if origin is _DEFAULT:
        headers.append(("Origin", f"http://127.0.0.1:{port}"))
    elif origin is not None:
        headers.append(("Origin", origin))
    if ctype is not None:
        headers.append(("Content-Type", ctype))
    body = json.dumps({"method": method, "args": args}).encode()
    return _request(port, "POST", "/rpc", host=host, headers=headers, body=body)


def _dict_add(port, **kwargs):
    return _rpc(port, "dictAdd", {"source": "Item No.", "target": "侵入"}, **kwargs)


# ── 正常系 (これが壊れると UI が動かない) ──


def test_legitimate_ui_request_passes(server):
    port = server.server_address[1]
    status, body, _ = _dict_add(port)
    assert status == 200 and json.loads(body)["ok"] is True
    assert [e.target for e in server.session.store.all()] == ["侵入"]


def test_localhost_host_and_case_and_padding_pass(server):
    """`localhost` 表記・大文字・前後空白は正規化して通す (許可リストの正常系)。"""
    port = server.server_address[1]
    for host in (f"  127.0.0.1:{port}  ", f"LOCALHOST:{port}"):
        status, _, _ = _request(port, "GET", "/", host=host)
        assert status == 200, host


def test_quit_beacon_with_origin_sets_quit_event(server):
    """`navigator.sendBeacon('/quit')` 相当 (Content-Type 無し・本文なし) は通る。"""
    port = server.server_address[1]
    status, _, _ = _request(port, "POST", "/quit",
                            headers=[("Origin", f"http://127.0.0.1:{port}")])
    assert status == 204
    # `quit_event.set()` は 204 送信の**後**なので、応答受信直後はまだ立っていないことがある。
    # 拒否側の主張 (`is_set() is False`) は待たずに成立するが、こちらは待つ必要がある。
    assert server.quit_event.wait(5) is True


# ── 迂回入力: Origin ──


@pytest.mark.parametrize("origin", [
    None,                                   # Origin ヘッダ無し (非ブラウザ / 素の curl)
    "https://evil.example",                 # 別オリジン
    "http://127.0.0.1:65535",               # 同ホスト別ポート
    "null",                                 # sandbox iframe / file:// / data:
])
def test_rpc_rejected_and_dictionary_untouched(server, origin):
    port = server.server_address[1]
    status, body, _ = _dict_add(port, origin=origin)
    assert status == 403 and body == b"forbidden"
    assert server.session.store.all() == []


def test_rpc_rejects_prefix_match_origin(server):
    """`http://127.0.0.1:<port>.evil.com` — 前方一致で判定していれば通ってしまう値。"""
    port = server.server_address[1]
    status, _, _ = _dict_add(port, origin=f"http://127.0.0.1:{port}.evil.com")
    assert status == 403
    assert server.session.store.all() == []


def test_rpc_rejects_duplicate_origin_headers(server):
    """正規 Origin を 2 本目に潜ませる。`get()` は先頭しか返さないので個数を見る必要がある。"""
    port = server.server_address[1]
    headers = [("Origin", "https://evil.example"),
               ("Origin", f"http://127.0.0.1:{port}"),
               ("Content-Type", "application/json")]
    body = json.dumps({"method": "dictAdd", "args": {"source": "a", "target": "b"}}).encode()
    status, _, _ = _request(port, "POST", "/rpc", headers=headers, body=body)
    assert status == 403
    assert server.session.store.all() == []


# ── 迂回入力: Content-Type (プリフライトを起こさない simple request) ──


@pytest.mark.parametrize("ctype", [
    "text/plain;charset=UTF-8",             # P003 の PoC そのもの
    "application/x-www-form-urlencoded",    # <form> 送信
    "multipart/form-data; boundary=x",      # <form enctype>
    "application/json+evil",                # 許可値の前方一致狙い
    "x/application/json",                   # 許可値の部分一致狙い
])
def test_rpc_rejects_simple_request_content_types(server, ctype):
    port = server.server_address[1]
    status, _, _ = _dict_add(port, ctype=ctype)
    assert status == 403
    assert server.session.store.all() == []


def test_rpc_accepts_content_type_parameters(server):
    """許可値にパラメータが付いていても `;` の前で完全一致するなら通す。"""
    port = server.server_address[1]
    status, _, _ = _dict_add(port, ctype="Application/JSON ; charset=utf-8")
    assert status == 200
    assert len(server.session.store.all()) == 1


def test_post_without_content_type_but_with_body_is_rejected(server):
    """Content-Type 無しで通してよいのは本文の無いビーコンだけ。"""
    port = server.server_address[1]
    status, _, _ = _request(port, "POST", "/quit",
                            headers=[("Origin", f"http://127.0.0.1:{port}")],
                            body=b"{}")
    assert status == 403
    assert server.quit_event.is_set() is False


# ── 迂回入力: Host (DNS リバインディング) ──


@pytest.mark.parametrize("host", [
    "evil.example",                         # リバインディング時に実際に届く値
    "127.0.0.1.evil.com:{port}",            # 前方一致狙い
    "evil.com:{port}",                      # 部分一致狙い
    "127.0.0.1.:{port}",                    # 末尾ドット付き FQDN
    "[::1]:{port}",                         # 別ループバック表記
    None,                                   # Host ヘッダ無し
])
def test_get_rejected_on_host_mismatch(server, host):
    port = server.server_address[1]
    status, _, _ = _request(port, "GET", "/",
                            host=None if host is None else host.format(port=port))
    assert status == 403


def test_rejects_duplicate_host_headers(server):
    port = server.server_address[1]
    status, _, _ = _request(port, "GET", "/", host="evil.example",
                            headers=[("Host", f"127.0.0.1:{port}")])
    assert status == 403


def test_static_asset_rejected_on_host_mismatch(server):
    """既知パスの `<script src>` が 200 を返す = 確実なポート探索オラクル。Host 検査で塞ぐ。"""
    port = server.server_address[1]
    assert _request(port, "GET", "/app.js", host="evil.example")[0] == 403
    assert _request(port, "GET", "/app.js")[0] == 200


# ── 迂回入力: リクエスト行 / フレーミング ──


def test_absolute_form_request_target_is_rejected(server):
    """`POST http://127.0.0.1:p/quit` + `Host: evil.example`。経路分岐は通るが Host は攻撃者値。"""
    port = server.server_address[1]
    status, _, _ = _request(port, "POST", f"http://127.0.0.1:{port}/quit",
                            host="evil.example",
                            headers=[("Origin", f"http://127.0.0.1:{port}")])
    assert status == 403
    assert server.quit_event.is_set() is False


def test_transfer_encoding_is_rejected(server):
    """Content-Length しか読まない `_read_body` とチャンク本文の食い違い (デシンク) を封じる。"""
    port = server.server_address[1]
    status, _, _ = _request(port, "POST", "/quit",
                            headers=[("Origin", f"http://127.0.0.1:{port}"),
                                     ("Transfer-Encoding", "chunked")],
                            raw_tail=b"0\r\n\r\n")
    assert status == 403
    assert server.quit_event.is_set() is False


def test_unread_body_does_not_reset_the_connection(server):
    """拒否時に未読本文を残したまま閉じると OS が RST を送り、**送信済みの 403 ごと**
    クライアントの受信バッファが捨てられる (拒否はできているのに接続エラーしか見えない)。
    `_drain_body` は `Transfer-Encoding` を読めないのでこの経路へ落ちる。

    上の `test_transfer_encoding_is_rejected` は本文の続きが届くのとサーバが閉じるのの
    競争になっていて、この退行を取りこぼす (実測で 3 回に 1 回ほど接続エラー側へ倒れた)。
    ここでは 403 を送り終えた頃合いに続きを送りつけ、確定的に踏ませる。
    """
    port = server.server_address[1]
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    try:
        conn.putrequest("POST", "/quit", skip_host=True, skip_accept_encoding=True)
        conn.putheader("Host", f"127.0.0.1:{port}")
        conn.putheader("Origin", f"http://127.0.0.1:{port}")
        conn.putheader("Transfer-Encoding", "chunked")
        conn.endheaders()
        time.sleep(0.1)  # 拒否は即座なので、これで「閉じるなら閉じ終えた」状態になる
        conn.send(b"0\r\n\r\n")
        res = conn.getresponse()
        assert res.status == 403
        assert res.read() == b"forbidden"
    finally:
        conn.close()
    assert server.quit_event.is_set() is False


def test_duplicate_content_length_is_rejected(server):
    port = server.server_address[1]
    status, _, _ = _request(port, "POST", "/ping",
                            headers=[("Origin", f"http://127.0.0.1:{port}"),
                                     ("Content-Length", "0"),
                                     ("Content-Length", "0")])
    assert status == 403


# ── 迂回入力: ライフサイクル (副作用の不発を確認する) ──


def test_quit_without_origin_does_not_set_quit_event(server):
    """「実行してから 403」ではないこと。ここが緩むとアプリを外部から落とせる。"""
    port = server.server_address[1]
    status, _, _ = _request(port, "POST", "/quit", headers=[])
    assert status == 403
    assert server.quit_event.is_set() is False


def test_ping_from_foreign_origin_does_not_refresh_last_seen(server):
    """外部から `/ping` を打ち続けて idle watchdog を無効化できないこと。"""
    port = server.server_address[1]
    server.last_seen = -1.0
    status, _, _ = _request(port, "POST", "/ping",
                            headers=[("Origin", "https://evil.example")])
    assert status == 403
    assert server.last_seen == -1.0


@pytest.mark.parametrize("target", ["/", "/favicon.ico", "/does-not-exist"])
def test_get_without_origin_does_not_refresh_last_seen(server, target):
    """Origin 無しの GET (`<img src>` / no-cors fetch) は応答するが延命はしないこと。

    Host は攻撃者ページからの取得でも `127.0.0.1:<port>` になり G1 を通り、Origin が無い以上
    G3/G4 のどちらにも掛からない。ここで `last_seen` が進むと、数十秒間隔で叩き続けるだけで
    `IDLE_TIMEOUT` が永久に発火しなくなる (= watchdog の無効化)。
    """
    port = server.server_address[1]
    server.last_seen = -1.0
    for _ in range(3):
        status, _, _ = _request(port, "GET", target)
        assert status in (200, 204, 404)
    assert server.last_seen == -1.0


def test_same_origin_get_refreshes_last_seen(server):
    """正規ページからの取得 (Origin 完全一致) は延命する = 判定と副作用が同じ 1 箇所にある。"""
    port = server.server_address[1]
    server.last_seen = -1.0
    status, _, _ = _request(port, "GET", "/",
                            headers=[("Origin", f"http://127.0.0.1:{port}")])
    assert status == 200
    assert server.last_seen > 0.0


def test_upload_without_origin_is_rejected_before_parsing(server):
    """本文を読む前に落ちる (未認可の巨大 body を解析させない)。"""
    port = server.server_address[1]
    status, _, _ = _request(port, "POST", "/upload?name=x.pdf",
                            headers=[("Content-Type", "application/octet-stream")],
                            body=b"%PDF-1.4\n" + b"A" * (512 * 1024))
    assert status == 403
    assert server.session.docs == []


# ── fail closed / CORS ヘッダを出さない ──


def test_unconfigured_server_rejects_everything(tmp_path):
    """`ThreadingHTTPServer` を素で組んで `configure_guard` を忘れた場合は全拒否 (fail open しない)。
    `test/e2e_server.py` がかつてこの形だったので、回帰として固定する。"""
    session = WebSession(DictionaryStore(tmp_path / "dict.json"), UndoStack())
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    srv.web_root = str(config.resource_path("web"))
    srv.session = session
    srv.lock = threading.Lock()
    srv.quit_event = threading.Event()
    srv.last_seen = 0.0
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    port = srv.server_address[1]
    try:
        assert _request(port, "GET", "/")[0] == 403
        assert _dict_add(port)[0] == 403
        assert session.store.all() == []
    finally:
        srv.shutdown()
        srv.server_close()
        session.store.close()


def test_no_cors_headers_are_ever_emitted(server):
    """ACAO を出さないこと自体が防御 (許可外オリジンのプリフライトを必ず失敗させる)。"""
    port = server.server_address[1]
    responses = [
        _request(port, "GET", "/"),
        _request(port, "GET", "/", host="evil.example"),
        _dict_add(port),
        _dict_add(port, origin="https://evil.example"),
        _request(port, "OPTIONS", "/rpc", headers=[("Origin", f"http://127.0.0.1:{port}")]),
    ]
    for _, _, headers in responses:
        assert not [k for k in headers.keys() if k.lower().startswith("access-control-")]


def test_reject_logging_is_capped_per_reason(server, caplog):
    """403 の理由コードごとに先頭 N 件だけログへ出す (`startup.log` はローテーション無し)。"""
    port = server.server_address[1]
    with caplog.at_level("WARNING", logger="pdftosvg"):
        for _ in range(origin_guard.REJECT_LOG_LIMIT + 3):
            _request(port, "GET", "/", host="evil.example")
    lines = [r for r in caplog.records if "host-mismatch" in r.getMessage()]
    assert len(lines) == origin_guard.REJECT_LOG_LIMIT
    # 攻撃者の入れた値をそのままログへ出さない (制御文字での行偽装を防ぐ整形が効いている)。
    assert all("\n" not in r.getMessage() for r in lines)
