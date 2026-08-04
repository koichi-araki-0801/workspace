"""同一オリジン検査 (CSRF / DNS リバインディング対策) の唯一の関所。

127.0.0.1 に bind するだけでは外部ページからの副作用を防げない。攻撃者ページの
`fetch(..., {mode:'no-cors'})` や `navigator.sendBeacon()` は応答を読めなくても
**リクエストは確実に届く**ため、`/rpc` の辞書書き換えや `/quit` は素通りしてしまう。
さらに短 TTL DNS で攻撃者ドメインを 127.0.0.1 へ再束縛されると、ブラウザから見て同一
オリジンになり応答まで読まれる (DNS リバインディング)。よって「どこから来たか」を
`Host` と `Origin` で検査する必要がある。

**検査は `parse_request()` の 1 箇所だけに置く。** `BaseHTTPRequestHandler` は
リクエスト行とヘッダを解析した直後に `parse_request()` を呼び、戻り値が偽なら
「エラー応答は送信済み」とみなして `do_*` へ分岐せず接続処理を終える。ここへ載せると
新しい `do_XXX` を足しても検査を忘れられない。各ハンドラの先頭に `if` を書く設計は
必ず書き忘れるので採らない。同じ理由で「危険な RPC メソッドだけ検査する」も採らない
(列挙 = ブロックリストは 1 つ足した瞬間に穴になるうえ、`pageSvg` / `dictJson` のような
読み出し系こそリバインディングの本命)。

判定はすべて**完全一致の許可リスト**で、`startswith` / 部分一致 / 正規表現は使わない
(`http://127.0.0.1:5180.evil.com` のような前方一致バイパスを構造的に排除する)。
`Access-Control-Allow-Origin` は**将来も出さない**: 出さないこと自体が防御であり、
許可外オリジンからのプリフライトを必ず失敗させる。

本モジュールは `graph-editor/app.py` の「同一オリジン検査」セクションと**同一仕様の
並行実装**である (graph-editor は実行時依存ゼロ・単一 `app.py` が設計前提のため共有
モジュールを持てない)。判定順・理由コード・許可リストの中身は逐語で揃えてあり、
**片方を変えたら必ず両方を変える**こと。テストベクタも両プロジェクトへ複製している
(`tests/test_origin_guard.py` と `graph-editor/tests/test_app_guard.py`)。
"""
from __future__ import annotations

import http.server
import logging
import socket
import string
import time

# ── 許可リスト (2 プロジェクトで同一) ──

# 非安全メソッドで許す Content-Type。どちらも CORS セーフリスト外なので、クロスオリジンから
# 送るにはプリフライトが要る。本サーバは `do_OPTIONS` を持たず ACAO も出さないため、
# プリフライトは必ず失敗する。P003 の PoC (`text/plain;charset=UTF-8` の simple request) は
# Origin 検査とは独立にここで閉じる。値は現行クライアントが実際に送っているものの写しで、
# 「サーバに合わせてクライアントを直す」のではなく「実態を許可リストとして固定する」向き。
ALLOWED_REQUEST_CONTENT_TYPES = frozenset({"application/json", "application/octet-stream"})

# Origin を要求しないメソッド。Fetch 仕様上、GET/HEAD 以外にはブラウザが必ず Origin を
# 付けるので、非安全メソッドで Origin が無い = ブラウザ以外とみなして拒否できる。
SAFE_METHODS = frozenset({"GET", "HEAD"})

# 403 の理由コードごとにログへ出す上限。全件出すと攻撃者にログを膨らませられる
# (`startup.log` はローテーションを持たない)。
REJECT_LOG_LIMIT = 3

# 403 を返す前に読み捨てる本文の上限。読み捨てずに閉じると未読データの残った TCP が RST し、
# クライアントは 403 ではなく接続エラーを見る。上限超はそのまま閉じる (DoS 対策を優先)。
_DRAIN_LIMIT = 1 << 20

# `_drain_body` で読み切れなかった本文を応答送信後に読み捨てる待ち時間 (秒)。相手が応答を
# 読んで閉じれば即 EOF になるので、これは相手が黙り込んだ場合に接続を抱え続けないための上限。
_LINGER_TIMEOUT = 0.5

# ログへ出す詳細値の整形。攻撃者が入れた制御文字でログ行を偽装できないよう、印字可能 ASCII
# 以外は落として短く切る。
_LOG_SAFE_CHARS = frozenset(string.ascii_letters + string.digits + "-._:[]/")
_LOG_DETAIL_MAX = 64

_log = logging.getLogger("pdftosvg")


def allowed_hosts(port: int) -> frozenset[str]:
    """許可する `Host` ヘッダ値。ブラウザは Host を書き換えられないので、これが
    DNS リバインディング (攻撃者ドメイン名のまま 127.0.0.1 へ解決) の決定的な壁になる。"""
    return frozenset({f"127.0.0.1:{port}", f"localhost:{port}"})


def allowed_origins(port: int) -> frozenset[str]:
    """許可する `Origin` ヘッダ値。`null` (sandbox iframe・`file://`・`data:`) は含めない。
    IPv6 の `[::1]` も含めない (127.0.0.1 に bind しているので到達しない)。"""
    return frozenset({f"http://127.0.0.1:{port}", f"http://localhost:{port}"})


def configure_guard(server, port: int) -> None:
    """サーバへ許可リストを固定する。**bind 後の実ポート**で呼ぶこと (port 0 で組むと全滅する)。
    設定されていないサーバは `unconfigured` で全拒否になる (fail closed)。"""
    server.guard_hosts = allowed_hosts(port)
    server.guard_origins = allowed_origins(port)
    server.guard_reject_counts = {}


class GuardedHTTPRequestHandler(http.server.BaseHTTPRequestHandler):
    """`parse_request()` で同一オリジン検査を行うハンドラ基底。

    サブクラスは `do_GET` / `do_POST` を素直に書けばよく、検査は上に載る。
    **`do_GET` / `do_HEAD` に副作用を持たせないこと**: 安全メソッドは Origin 無しでも
    通す (ブラウザが付けないため) ので、副作用を置くと CSRF が素通りする。
    idle watchdog 用の `last_seen` 更新もその副作用の 1 つなので、判定と同じ場所
    (`_touch_if_same_origin`) に置いて `do_*` からは触らせない。
    """

    def parse_request(self) -> bool:
        # `super()` の解析後 (self.command / self.path / self.headers が揃った直後) かつ
        # `do_*` への分岐前が唯一の共通点。ここで落とせばハンドラ本体へは一切到達しない
        # ("実行してから 403 を返す" = `quit_event` が立ってしまう形を構造的に避ける)。
        if not super().parse_request():
            return False
        reason = self._guard_reason()
        if reason is not None:
            return self._reject(reason)
        self._touch_if_same_origin()
        return True

    def _touch_if_same_origin(self) -> None:
        """idle watchdog の最終アクセス時刻を更新する。**Origin が完全一致した
        リクエストだけ**が対象である。

        安全メソッドは Origin 無しでも通す (G3/G4) ため、`do_GET` 側で無条件に更新すると
        クロスオリジンの no-cors GET (`<img src>` / `<link href>` の連打) で
        `IDLE_TIMEOUT` を永久に先送りでき、ゾンビサーバを維持できてしまう。正規の
        ハートビートは `resources/web/app.js` の `POST /ping` で必ず Origin を伴うので、
        Origin 無しの経路を延命へ使わせない。
        """
        origin = self._single_header("Origin")
        if origin is None:
            return
        if origin.strip().lower() in (getattr(self.server, "guard_origins", None) or ()):
            self.server.last_seen = time.monotonic()

    # ── 判定 ──

    def _guard_reason(self) -> str | None:
        """拒否理由コードを返す。通してよければ `None`。判定順は graph-editor と同一。"""
        hosts = getattr(self.server, "guard_hosts", None)
        origins = getattr(self.server, "guard_origins", None)
        if not hosts or not origins:
            return "unconfigured"

        # G0: リクエストターゲットは origin-form (`/...`) のみ。absolute-form
        # (`POST http://127.0.0.1:p/quit`) を許すと `urlsplit(path).path` での経路分岐は
        # 通るのに Host は攻撃者値、という食い違いを作れる。
        if not self.path.startswith("/"):
            return "request-target"

        # G1: Host は完全一致。重複ヘッダは `get()` が先頭しか返さず食い違うので個数を見る。
        host = self._single_header("Host")
        if host is None or host.strip().lower() not in hosts:
            return "host-mismatch"

        # G2: フレーミングは Content-Length 単独のみ。`Transfer-Encoding` は本文が未読のまま
        # keep-alive 接続に残り、次のリクエスト行として解釈されうる (デシンク)。
        if self.headers.get_all("Transfer-Encoding"):
            return "framing"
        if len(self.headers.get_all("Content-Length") or ()) > 1:
            return "framing"

        raw_origin = self.headers.get_all("Origin")
        if raw_origin:
            # G3: Origin があるなら完全一致。`null` は許可リストに入れていないので落ちる。
            if len(raw_origin) != 1 or raw_origin[0].strip().lower() not in origins:
                return "origin-mismatch"
        elif self.command not in SAFE_METHODS:
            # G4: 非安全メソッドで Origin が無い = ブラウザではない。ローカルの非ブラウザ
            # プロセスは任意ヘッダを詐称できて防御力が変わらない以上、閉じる方を採る。
            # 注意: 応答へ `Referrer-Policy: no-referrer` を足すと sendBeacon (no-cors POST)
            # の Origin が `null` へ置換され `/quit` が 403 になる。足すなら `same-origin` か
            # `strict-origin-when-cross-origin` を選ぶこと。
            return "origin-missing"

        # G5: 非安全メソッドの Content-Type。無い場合は本文も無いこと (`/quit` `/ping` の
        # 空ビーコン)。ある場合はパラメータを落として完全一致。
        if self.command not in SAFE_METHODS:
            return self._content_type_reason()
        return None

    def _content_type_reason(self) -> str | None:
        raw = self.headers.get_all("Content-Type")
        if not raw:
            length = self._single_header("Content-Length")
            if length is not None and length.strip() not in ("", "0"):
                return "content-type"
            return None
        if len(raw) != 1:
            return "content-type"
        if raw[0].split(";", 1)[0].strip().lower() not in ALLOWED_REQUEST_CONTENT_TYPES:
            return "content-type"
        return None

    def _single_header(self, name: str) -> str | None:
        """ちょうど 1 本だけ存在するときにその値を返す。0 本・2 本以上は `None`。"""
        values = self.headers.get_all(name)
        return values[0] if values and len(values) == 1 else None

    # ── 拒否応答 ──

    def _reject(self, reason: str) -> bool:
        """本文を読み捨ててから 403 を返し、接続を閉じる。常に `False` を返す
        (= `handle_one_request` から見て「エラー応答送信済み」)。"""
        drained = self._drain_body()
        self.close_connection = True
        body = b"forbidden"
        try:
            self.send_response(403)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(body)
        except OSError:
            pass  # 相手が先に切っただけ。ログを増やさない。
        if not drained:
            self._linger_close()
        self._log_reject(reason)
        return False

    def _drain_body(self) -> bool:
        """宣言された本文を上限まで読み捨てる。403 の本体はリクエスト内容を一切反射しない。
        未読データを残していなければ `True`、残したなら `False` (呼び出し側が lingering close)。"""
        if self.headers.get_all("Transfer-Encoding"):
            return False  # チャンク解析はしない (それ自体がデシンクの温床)。残りは linger 任せ。
        raw = self._single_header("Content-Length")
        if raw is None:
            # Content-Length も Transfer-Encoding も無ければ本文は存在しない。重複 Content-Length
            # (`_single_header` が None) はどちらが真か決められないので読まずに linger へ回す。
            return not self.headers.get_all("Content-Length")
        try:
            remaining = int(raw.strip())
        except ValueError:
            return False
        if remaining == 0:
            return True
        if remaining < 0 or remaining > _DRAIN_LIMIT:
            return False  # 未認可の巨大 body は読まない (DoS 対策を優先)。
        while remaining > 0:
            chunk = self.rfile.read(min(remaining, 65536))
            if not chunk:
                return True  # 相手が先に切った。未読データは残らない。
            remaining -= len(chunk)
        return True

    def _linger_close(self) -> None:
        """応答送信後、相手が送った未読データを短時間だけ読み捨ててから接続を手放す。

        未読データを残したまま閉じると OS は RST を送り、**送信済みの 403 ごと**クライアントの
        受信バッファが捨てられる (Windows で顕在化し、クライアントは接続エラーだけを見る)。
        書き込み側だけ先に閉じて FIN を届け、相手が閉じるまで読み捨てる。`_DRAIN_LIMIT` と
        `_LINGER_TIMEOUT` で上限を切り、拒否した相手に接続を抱えさせない。
        """
        sock = self.connection
        try:
            sock.shutdown(socket.SHUT_WR)
            sock.settimeout(_LINGER_TIMEOUT)
            drained = 0
            while drained < _DRAIN_LIMIT:
                chunk = sock.recv(65536)
                if not chunk:
                    return
                drained += len(chunk)
        except OSError:
            pass  # timeout・相手が先に切った等。いずれも RST 回避の努力目標でしかない。

    def _log_reject(self, reason: str) -> None:
        counts = getattr(self.server, "guard_reject_counts", None)
        if counts is None:
            counts = self.server.guard_reject_counts = {}
        seen = counts.get(reason, 0) + 1
        counts[reason] = seen
        if seen > REJECT_LOG_LIMIT:
            return
        _log.warning("rejected request reason=%s host=%s origin=%s",
                     reason,
                     _log_safe(self.headers.get("Host")),
                     _log_safe(self.headers.get("Origin")))


def _log_safe(value: str | None) -> str:
    """ログへ出す前に印字可能 ASCII の部分集合だけへ落として短く切る (ログ行の偽装防止)。"""
    if not value:
        return "-"
    kept = "".join(c for c in value if c in _LOG_SAFE_CHARS)
    return (kept[:_LOG_DETAIL_MAX] or "-")
