"""同一オリジン検査 (`app.py` の「同一オリジン検査」セクション) の迂回耐性を外形から固定する。

主張の形は「**迂回入力では 403 になり、かつ副作用が発生していない**」。ステータスだけを見ると
「実行してから 403 を返す」実装 (`quit_event` は立ってしまう) を見逃すため、`quit_event` と
`last_seen` を毎回突き合わせる。`/quit` は `main()` の `finally` で `msedge.exe` へ
`proc.terminate()` を撃つ = 外部から撃たれると編集内容が消えるうえ他の Edge 窓を巻き添えに
しうるので、ここが緩むと実害が出る。

ここのテストベクタ表は `pdf-to-svg/tests/test_origin_guard.py` と**同一仕様の複製**である
(2 プロジェクトは並行実装で、片方を変えたら両方を変える)。`urllib` は URL から Host を
強制するので `Host: evil.example` を送れない。`http.client` の `putrequest(skip_host=True)`
で任意のリクエスト行・ヘッダを手組みする。

`import app` の副作用は `ui.html` と `lib/leader_geom.cjs` の読み込みだけで Edge は起動しない
(`main()` を呼ばない)。
"""
from __future__ import annotations

import http.client
import http.server
import threading
import time

import app
import pytest

# 「Host ヘッダを省略する」を `None` と区別するための番兵。
_DEFAULT = object()


@pytest.fixture
def server():
    """`create_server` で組んだ実サーバ (ガード設定済み) を空きポートで走らせる。"""
    srv = app.create_server()
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        yield srv
    finally:
        srv.shutdown()
        srv.server_close()


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


def _beacon(port, target, *, origin=_DEFAULT, host=_DEFAULT, extra=()):
    """`navigator.sendBeacon(target)` / `fetch(target, {method:'POST'})` 相当
    (本文なし・Content-Type なし) を送る。"""
    headers = []
    if origin is _DEFAULT:
        headers.append(("Origin", f"http://127.0.0.1:{port}"))
    elif origin is not None:
        headers.append(("Origin", origin))
    headers.extend(extra)
    return _request(port, "POST", target, host=host, headers=headers)


# ── 正常系 (これが壊れると UI が動かない / 窓を閉じてもプロセスが残る) ──


def test_ui_html_is_served(server):
    port = server.server_address[1]
    status, body, _ = _request(port, "GET", "/")
    assert status == 200 and b"<html" in body.lower()


def test_localhost_host_and_case_and_padding_pass(server):
    """`localhost` 表記・大文字・前後空白は正規化して通す (許可リストの正常系)。"""
    port = server.server_address[1]
    for host in (f"  127.0.0.1:{port}  ", f"LOCALHOST:{port}"):
        assert _request(port, "GET", "/", host=host)[0] == 200, host


def test_quit_beacon_with_origin_sets_quit_event(server):
    """`main.js` の `navigator.sendBeacon('/quit')` がそのまま通ること (無改修の裏取り)。"""
    port = server.server_address[1]
    status, _, _ = _beacon(port, "/quit")
    assert status == 204
    # `quit_event.set()` は 204 送信の**後**なので、応答受信直後はまだ立っていないことがある。
    # 拒否側の主張 (`is_set() is False`) は待たずに成立するが、こちらは待つ必要がある。
    assert server.quit_event.wait(5) is True


def test_ping_beacon_with_origin_refreshes_last_seen(server):
    """`main.js` の 10 秒毎 `fetch('/ping', {method:'POST', keepalive:true})` が通ること。"""
    port = server.server_address[1]
    server.last_seen = -1.0
    status, _, _ = _beacon(port, "/ping")
    assert status == 204
    assert server.last_seen > 0.0


# ── 迂回入力: Origin ──


@pytest.mark.parametrize("origin", [
    None,                                   # Origin ヘッダ無し (非ブラウザ / 素の curl)
    "https://evil.example",                 # 別オリジン
    "http://127.0.0.1:65535",               # 同ホスト別ポート
    "null",                                 # sandbox iframe / file:// / data:
])
def test_quit_rejected_without_valid_origin(server, origin):
    """「実行してから 403」ではないこと。ここが緩むとアプリを外部ページから落とせる。"""
    port = server.server_address[1]
    status, body, _ = _beacon(port, "/quit", origin=origin)
    assert status == 403 and body == b"forbidden"
    assert server.quit_event.is_set() is False


def test_quit_rejects_prefix_match_origin(server):
    """`http://127.0.0.1:<port>.evil.com` — 前方一致で判定していれば通ってしまう値。"""
    port = server.server_address[1]
    status, _, _ = _beacon(port, "/quit", origin=f"http://127.0.0.1:{port}.evil.com")
    assert status == 403
    assert server.quit_event.is_set() is False


def test_quit_rejects_duplicate_origin_headers(server):
    """正規 Origin を 2 本目に潜ませる。`get()` は先頭しか返さないので個数を見る必要がある。"""
    port = server.server_address[1]
    status, _, _ = _beacon(port, "/quit", origin="https://evil.example",
                           extra=[("Origin", f"http://127.0.0.1:{port}")])
    assert status == 403
    assert server.quit_event.is_set() is False


def test_ping_from_foreign_origin_does_not_refresh_last_seen(server):
    """外部から `/ping` を打ち続けて idle watchdog を無効化し、ゾンビサーバを維持できないこと。"""
    port = server.server_address[1]
    server.last_seen = -1.0
    status, _, _ = _beacon(port, "/ping", origin="https://evil.example")
    assert status == 403
    assert server.last_seen == -1.0


@pytest.mark.parametrize("target", ["/", "/favicon.ico", "/styles.css", "/does-not-exist"])
def test_get_without_origin_does_not_refresh_last_seen(server, target):
    """Origin 無しの GET (`<img src>` / no-cors fetch) は 200/204/404 を返すが延命はしない。

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


# ── 迂回入力: Content-Type (プリフライトを起こさない simple request) ──


@pytest.mark.parametrize("ctype", [
    "text/plain;charset=UTF-8",             # `fetch(..., {mode:'no-cors'})` の抜け道
    "application/x-www-form-urlencoded",    # <form> 送信
    "multipart/form-data; boundary=x",      # <form enctype>
    "application/json+evil",                # 許可値の前方一致狙い
    "x/application/json",                   # 許可値の部分一致狙い
])
def test_quit_rejects_simple_request_content_types(server, ctype):
    port = server.server_address[1]
    status, _, _ = _request(port, "POST", "/quit",
                            headers=[("Origin", f"http://127.0.0.1:{port}"),
                                     ("Content-Type", ctype)],
                            body=b"x")
    assert status == 403
    assert server.quit_event.is_set() is False


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
    """`<script src>` の 200/404 差でポートを当てるオラクルも塞がっていること。"""
    port = server.server_address[1]
    assert _request(port, "GET", "/js/main.js", host="evil.example")[0] == 403
    assert _request(port, "GET", "/js/main.js")[0] == 200


# ── 迂回入力: リクエスト行 / フレーミング ──


def test_absolute_form_request_target_is_rejected(server):
    """`POST http://127.0.0.1:p/quit` + `Host: evil.example`。経路分岐は通るが Host は攻撃者値。"""
    port = server.server_address[1]
    status, _, _ = _beacon(port, f"http://127.0.0.1:{port}/quit", host="evil.example")
    assert status == 403
    assert server.quit_event.is_set() is False


def test_transfer_encoding_is_rejected(server):
    """チャンク本文が未読のまま keep-alive 接続に残る食い違い (デシンク) を封じる。"""
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
    競争になっていて、この退行を取りこぼす (pdf-to-svg 側の実測で 3 回に 1 回ほど接続エラー
    側へ倒れた)。ここでは 403 を送り終えた頃合いに続きを送りつけ、確定的に踏ませる。
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
    status, _, _ = _beacon(port, "/ping", extra=[("Content-Length", "0"),
                                                 ("Content-Length", "0")])
    assert status == 403


# ── fail closed / CORS ヘッダを出さない ──


def test_unconfigured_server_rejects_everything():
    """`ThreadingHTTPServer` を素で組んで `configure_guard` を忘れた場合は全拒否 (fail open しない)。"""
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), app.Handler)
    srv.quit_event = threading.Event()
    srv.last_seen = 0.0
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    port = srv.server_address[1]
    try:
        assert _request(port, "GET", "/")[0] == 403
        assert _beacon(port, "/quit")[0] == 403
        assert srv.quit_event.is_set() is False
    finally:
        srv.shutdown()
        srv.server_close()


def test_no_cors_headers_are_ever_emitted(server):
    """ACAO を出さないこと自体が防御 (許可外オリジンのプリフライトを必ず失敗させる)。"""
    port = server.server_address[1]
    responses = [
        _request(port, "GET", "/"),
        _request(port, "GET", "/", host="evil.example"),
        _beacon(port, "/ping"),
        _beacon(port, "/ping", origin="https://evil.example"),
        _request(port, "OPTIONS", "/quit", headers=[("Origin", f"http://127.0.0.1:{port}")]),
    ]
    for _, _, headers in responses:
        assert not [k for k in headers.keys() if k.lower().startswith("access-control-")]


def test_reject_logging_is_capped_per_reason(server, caplog):
    """403 の理由コードごとに先頭 N 件だけログへ出す (ログを膨らませられないこと)。"""
    port = server.server_address[1]
    with caplog.at_level("WARNING", logger="labeleditor"):
        for _ in range(app.REJECT_LOG_LIMIT + 3):
            _request(port, "GET", "/", host="evil.example")
    lines = [r for r in caplog.records if "host-mismatch" in r.getMessage()]
    assert len(lines) == app.REJECT_LOG_LIMIT
    # 攻撃者の入れた値をそのままログへ出さない (制御文字での行偽装を防ぐ整形が効いている)。
    assert all("\n" not in r.getMessage() for r in lines)
