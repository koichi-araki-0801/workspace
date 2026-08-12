"""接続の資源上限 (`app.py` の `REQUEST_TIMEOUT` / `MAX_CONNECTIONS`) の退行ガード。

「正しい入力を正しく処理する」ではなく**「迂回入力で破綻しない」**を主張する形で書く。
所要時間ではなく**上限が効くこと**を見る (実時間はマシン依存で脆い): 上限に当たったら
拒否して**必ず返る**こと、そして上限が正常系を壊していないこと。

同一オリジン検査 (`parse_request`) はリクエスト行とヘッダが届いて初めて走るので、
**何も送らない接続はガードの手前でブロックし続ける**。ここを閉じられるのはハンドラ側の
期限と受け入れ枠だけで、認可のテスト (`test_app_guard.py`) では捕まえられない。

pdf-to-svg の `test/test_resource_limits.py`「F42: 接続の資源上限」節と**同一仕様の複製**
である (並行実装)。2 実装の値が揃っていることは `test_parallel_impl_drift.py` が検証する。
"""
from __future__ import annotations

import socket
import threading
import time
import urllib.error
import urllib.request

import app


def _serve(**kwargs):
    """`create_server` でサーバを起動して返す (呼び出し側で shutdown)。"""
    server = app.create_server(**kwargs)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def test_silent_connection_is_closed_by_the_handler_timeout(monkeypatch):
    """何も送らない接続はスレッドを恒久占有できない (`parse_request` は届かない)。"""
    monkeypatch.setattr(app.Handler, "timeout", 0.5)
    server = _serve()
    try:
        sock = socket.create_connection(("127.0.0.1", server.server_address[1]), timeout=10)
        sock.settimeout(10)
        # 1 バイトも送らない。期限が効いていれば向こうから閉じる (recv が EOF を返す)。
        assert sock.recv(1) == b""
        sock.close()
    finally:
        server.shutdown()
        server.server_close()


def test_connection_cap_refuses_extra_connections(monkeypatch):
    """同時接続数の上限を超えた接続は受け付けず即切断する (スレッドを積み上げない)。"""
    monkeypatch.setattr(app.Handler, "timeout", 5.0)
    server = _serve(max_connections=2)
    port = server.server_address[1]
    hogs = []
    try:
        for _ in range(2):  # 無言接続で枠を 2 つとも埋める
            hogs.append(socket.create_connection(("127.0.0.1", port), timeout=10))
        time.sleep(0.2)  # accept → ハンドラスレッド起動まで待つ
        extra = socket.create_connection(("127.0.0.1", port), timeout=10)
        extra.settimeout(10)
        assert extra.recv(1) == b""  # 枠が無いので応答せず切断される
        extra.close()

        for sock in hogs:  # 枠を返せば通常のリクエストがまた通る
            sock.close()
        hogs = []
        deadline = time.monotonic() + 10
        while True:
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{port}/", timeout=5) as res:
                    assert res.status == 200
                break
            except urllib.error.URLError:
                if time.monotonic() > deadline:
                    raise
                time.sleep(0.1)
    finally:
        for sock in hogs:
            sock.close()
        server.shutdown()
        server.server_close()
