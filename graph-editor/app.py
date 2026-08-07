"""SVG ラベル位置エディタ — ローカルサーバ版 (依存ゼロ・標準ライブラリのみ)。

pie-chart が生成した SVG を読み込み、ラベル (テキスト + leader) をマウスでドラッグ調整して
修正版 SVG を書き出すスタンドアロンのデスクトップ風アプリ。

設計: ブラウザエンジンを同梱せず、OS に標準搭載の Edge を「アプリモード」で開いて UI を表示する。
  - 本ファイル = 小さなローカル HTTP サーバ (127.0.0.1 のみ) で `ui.html` を配信し、Edge を
    起動・常駐管理する。
  - ファイル入出力は `ui.html` 側でブラウザの File System Access API を使う (http://127.0.0.1 は
    secure context なので利用可能)。よって本サーバは静的配信とライフサイクル管理のみを担う。

これにより WebView2 ランタイムや pywebview を同梱せずに済み、配布物は ~10MB の単一 exe で済む。

開発実行:  python app.py
exe ビルド:  scripts\build.bat   (PyInstaller --onefile, 同梱の `ui.html` を --add-data)
"""

import hmac
import http.server
import logging
import os
import secrets
import socket
import string
import subprocess
import sys
import threading
import time
import webbrowser
from urllib.parse import parse_qs, quote, urlsplit

# ── 設定定数 ──

# 既定ブラウザ(フォールバック)経路ではプロセスハンドルが無いため、UI からの定期ハートビート
# (`/ping`) が途絶してからこの秒数で self-shutdown する。本来の終了契機は窓を閉じたときの
# `/quit` ビーコンで、これはビーコン不達/タブクラッシュ時にゾンビプロセスを残さないための保険。
# バックグラウンドタブはタイマーが ~1/分 に絞られるため、十分に余裕を持たせる。
IDLE_TIMEOUT = 60

try:
    import winreg  # Windows のみ (Edge のパス探索に使用)
except ImportError:  # pragma: no cover - 非 Windows 開発時
    winreg = None

# Edge 探索用の定数 (App Paths レジストリ → 既知のインストール先 env)
EDGE_EXE = "msedge.exe"
EDGE_APP_PATHS_KEY = r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe"
EDGE_INSTALL_ENV_DIRS = ("ProgramFiles(x86)", "ProgramFiles", "LocalAppData")


# ── 同梱リソースの解決 ──

# 同梱ファイルの基準ディレクトリ。PyInstaller 実行時は展開先 `_MEIPASS`(ui.html 等を
# ルート直下へ収録: `scripts/build.ps1` の --add-data 配置先を参照)、開発実行時は Web 資産を
# 集約した `resources/web/`(`pdf-to-svg` と同じ構成)。
RESOURCE_BASE = getattr(
    sys, "_MEIPASS", os.path.join(os.path.dirname(os.path.abspath(__file__)), "resources", "web")
)


def resource_path(rel: str) -> str:
    """開発実行でも PyInstaller 実行でも同梱ファイルへ解決する。"""
    return os.path.join(RESOURCE_BASE, rel)


# 追加の静的アセット (`styles.css` / `js/*.js`) の配信を許す拡張子と MIME。
# ここに無い拡張子は 404。`/` と `/lib/leader_geom.cjs` は `do_GET` 側で個別配信する。
STATIC_TYPES = {
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
}


with open(resource_path("ui.html"), "rb") as _f:
    UI_HTML = _f.read()

# `ui.html` が `<script src>` で読む共有純粋関数。起動時に一度だけ読み込んで配信する。
with open(resource_path(os.path.join("lib", "leader_geom.cjs")), "rb") as _f:
    LEADER_GEOM = _f.read()


# ── 同一オリジン検査 + セッショントークン認可 (CSRF / frame 埋め込み / 別プロセス) ──

# 127.0.0.1 に bind するだけでは外部ページからの副作用を防げない。攻撃者ページの
# `fetch(..., {mode:'no-cors'})` や `navigator.sendBeacon()` は応答を読めなくても
# **リクエストは確実に届く**ため、`/quit` で編集中の全内容を捨てさせたり、`/ping` を打ち続けて
# idle watchdog を無効化しゾンビサーバを維持したりできてしまう。`/quit` は `main()` の
# `finally` で `msedge.exe` へ `proc.terminate()` を撃つので、既定プロファイル起動 (隔離
# user-data-dir を付けないのが正典) ではユーザーの他の Edge 窓まで巻き添えになりうる。
# さらに短 TTL DNS で攻撃者ドメインを 127.0.0.1 へ再束縛されるとブラウザから見て同一オリジンに
# なる (DNS リバインディング)。よって「どこから来たか」を `Host` と `Origin` で検査する。
#
# ただし Origin 検査は**クロスオリジンのリクエストしか**防げない。攻撃者ページが本アプリを
# `<iframe>` に埋めた場合、frame の中で動くのは**アプリ自身**であり、その `pagehide`
# (`resources/web/js/main.js`) が撃つ `/quit` ビーコンの Origin は完全一致する = 検査を正当に
# 通過してしまう (同経路で `/ping` も届き idle watchdog も無効化できる)。さらに `Host` も
# `Origin` もヘッダでしかなく、同一マシンで動く非ブラウザプロセスは自由に詐称できる。
# そこで 2 段を足す: ①`frame-ancestors 'none'` + `X-Frame-Options: DENY` で frame 化自体を
# 拒む (`SECURITY_HEADERS`)、②非安全メソッドに**起動ごとに CSPRNG で発行したセッション
# トークン**の完全一致を要求する (G6)。トークンは `--app=` の URL でこの窓にだけ渡るので、
# frame に埋められた本アプリも、トークンを知らないローカルプロセスも `/quit` を撃てない。
#
# **検査は `parse_request()` の 1 箇所だけに置く。** `BaseHTTPRequestHandler` はリクエスト行と
# ヘッダを解析した直後に `parse_request()` を呼び、戻り値が偽なら「エラー応答は送信済み」と
# みなして `do_*` へ分岐しない。ここへ載せると新しい `do_XXX` を足しても検査を忘れられない。
# 各ハンドラの先頭に `if` を書く設計は必ず書き忘れるので採らない。判定はすべて**完全一致の
# 許可リスト**で、`startswith` / 部分一致 / 正規表現は使わない (`http://127.0.0.1:5179.evil.com`
# のような前方一致バイパスを構造的に排除する)。`Access-Control-Allow-Origin` は**将来も
# 出さない**: 出さないこと自体が防御で、許可外オリジンのプリフライトを必ず失敗させる。
#
# 本セクションは `pdf-to-svg/src/web/origin_guard.py` と**同一仕様の並行実装**である
# (graph-editor は実行時依存ゼロ・単一 `app.py` が設計前提のため共有モジュールを持てない。
# `resources/web/lib/leader_geom.cjs` と pie-chart の関係と同じ運用)。判定順・理由コード・
# 許可リストの中身は逐語で揃えてあり、**片方を変えたら必ず両方を変える**こと。テストベクタも
# 両プロジェクトへ複製している (`tests/test_app_guard.py` と
# `pdf-to-svg/tests/test_origin_guard.py`)。

# 非安全メソッドで許す Content-Type。どちらも CORS セーフリスト外なので、クロスオリジンから
# 送るにはプリフライトが要る。本サーバは `do_OPTIONS` を持たず ACAO も出さないため、
# プリフライトは必ず失敗する (`text/plain;charset=UTF-8` の simple request 抜け道を Origin 検査
# とは独立に閉じる)。graph-editor の現行 UI は本文付き POST を送らないので実質使われないが、
# **表は削らない**: 2 プロジェクトで判定表を同一に保つことが drift 防止の要。
ALLOWED_REQUEST_CONTENT_TYPES = frozenset({"application/json", "application/octet-stream"})

# Origin を要求しないメソッド。Fetch 仕様上、GET/HEAD 以外にはブラウザが必ず Origin を
# 付けるので、非安全メソッドで Origin が無い = ブラウザ以外とみなして拒否できる。
SAFE_METHODS = frozenset({"GET", "HEAD"})

# セッショントークンの運び方 (2 プロジェクトで同一)。`fetch` はヘッダで送る。
# `navigator.sendBeacon('/quit')` は**ヘッダを付けられない** API なので、そこだけは
# クエリ文字列で送る。クエリを常時許すのは「ビーコンだけ別の判定を書く」= 経路ごとの
# 分岐を作らないため (分岐は必ず片方を書き忘れる)。
TOKEN_HEADER = "X-Session-Token"
TOKEN_QUERY = "token"

# 全応答 (成功 `_send` と拒否 `_reject` の双方) へ載せる防御ヘッダ。**1 応答でも欠けると、
# その URL が `<iframe>` や `<script src>` の足がかりになる**ので、送信経路を増やしたら
# 必ず `_send_security_headers()` を通すこと。
# - `frame-ancestors 'none'` / `X-Frame-Options: DENY`: 上記の frame 埋め込み経路を拒む。
# - `default-src 'self'`: 同梱資産以外を読ませない。inline `<script>` もこれで禁止になる
#   (`ui.html` は inline script を持たない。`<style>` と `style=` 属性だけを例外にする)。
# - `style-src 'unsafe-inline'`: 読み込んだ SVG が `<style>` で `@font-face` を持つため
#   (`svg-policy.js` の許可リストが通す唯一のスタイル経路)。
# - `img-src`/`font-src` の `data:`: その `@font-face` と、SVG に埋め込まれた画像のため。
# - `nosniff` / `Cross-Origin-Resource-Policy: same-origin`: MIME 誤解釈と、他オリジンからの
#   no-cors 読み出し (既知パスの 200/404 差によるポート探索オラクル) を断つ。
# ⚠ pdf-to-svg (`src/web/origin_guard.py` の `SECURITY_HEADERS`) との並行実装。ヘッダ名・
# 値・順序を逐語で揃え、片方を変えたら必ず両方を変えること。
SECURITY_HEADERS = (
    ("X-Frame-Options", "DENY"),
    ("Content-Security-Policy",
     "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; "
     "font-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"),
    ("X-Content-Type-Options", "nosniff"),
    ("Cross-Origin-Resource-Policy", "same-origin"),
)

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


def _allowed_hosts(port):
    """許可する `Host` ヘッダ値。ブラウザは Host を書き換えられないので、これが
    DNS リバインディング (攻撃者ドメイン名のまま 127.0.0.1 へ解決) の決定的な壁になる。"""
    return frozenset({f"127.0.0.1:{port}", f"localhost:{port}"})


def _allowed_origins(port):
    """許可する `Origin` ヘッダ値。`null` (sandbox iframe・`file://`・`data:`) は含めない。
    IPv6 の `[::1]` も含めない (127.0.0.1 に bind しているので到達しない)。"""
    return frozenset({f"http://127.0.0.1:{port}", f"http://localhost:{port}"})


def _new_session_token():
    """この起動のセッショントークンを CSPRNG で作る (URL 安全な 32 バイト相当)。

    受け渡しは `--app=` の URL クエリ 1 本に絞る (`main()`)。**配信する `ui.html` へ埋める案は
    採らない**: `GET /` は安全メソッドで誰でも撃てるうえ、frame に埋め込まれた本アプリ自身も
    その HTML を受け取ってしまうため、守ろうとしている経路 (frame の `pagehide` が撃つ
    `/quit`) をそのまま開くことになる。残る漏えい面は起動した `msedge.exe` のコマンドラインと、
    フォールバック経路でのブラウザ履歴である (Jupyter の `?token=` と同じ割り切り)。
    ログには書かない。
    """
    return secrets.token_urlsafe(32)


def configure_guard(server, port, token):
    """サーバへ許可リストとセッショントークンを固定する。**bind 後の実ポート**で呼ぶこと
    (port 0 で組むと全滅する)。設定されていないサーバは `unconfigured` で全拒否になり、
    トークンだけが空なら非安全メソッドが全拒否になる (いずれも fail closed)。"""
    server.guard_hosts = _allowed_hosts(port)
    server.guard_origins = _allowed_origins(port)
    server.guard_token = token
    server.guard_reject_counts = {}


class GuardedHandler(http.server.BaseHTTPRequestHandler):
    """`parse_request()` で同一オリジン検査を行うハンドラ基底。

    サブクラスは `do_GET` / `do_POST` を素直に書けばよく、検査は上に載る。
    **`do_GET` / `do_HEAD` に副作用を持たせないこと**: 安全メソッドは Origin 無しでも
    通す (ブラウザが付けないため) ので、副作用を置くと CSRF が素通りする。同じ理由で
    **安全メソッドから機微データやセッショントークンを返さないこと**: 安全メソッドは
    トークンも要求しない (G6) ので、返した瞬間に任意のローカルプロセスが読み出せる。
    idle watchdog 用の `last_seen` 更新もその副作用の 1 つなので、判定と同じ場所
    (`_touch_if_same_origin`) に置いて `do_*` からは触らせない。
    """

    def parse_request(self):
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

    def _touch_if_same_origin(self):
        """idle watchdog の最終アクセス時刻を更新する。**Origin が完全一致した
        リクエストだけ**が対象である。

        安全メソッドは Origin 無しでも通す (G3/G4) ため、`do_GET` 側で無条件に更新すると
        クロスオリジンの no-cors GET (`<img src>` / `<link href>` の連打) で
        `IDLE_TIMEOUT` を永久に先送りでき、ゾンビサーバを維持できてしまう。正規の
        ハートビートは `resources/web/js/main.js` の `POST /ping` で必ず Origin を伴うので、
        Origin 無しの経路を延命へ使わせない。
        """
        origin = self._single_header("Origin")
        if origin is None:
            return
        if origin.strip().lower() in (getattr(self.server, "guard_origins", None) or ()):
            self.server.last_seen = time.monotonic()

    def _guard_reason(self):
        """拒否理由コードを返す。通してよければ `None`。判定順は pdf-to-svg と同一。"""
        hosts = getattr(self.server, "guard_hosts", None)
        origins = getattr(self.server, "guard_origins", None)
        if not hosts or not origins:
            return "unconfigured"

        # G0: リクエストターゲットは origin-form (`/...`) のみ。absolute-form
        # (`POST http://127.0.0.1:p/quit`) を許すと経路分岐は通るのに Host は攻撃者値、
        # という食い違いを作れる。
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
            # `navigator.sendBeacon('/quit')` は no-cors POST だが Origin は付くので通る。
            # 注意: 応答へ `Referrer-Policy: no-referrer` を足すとその Origin が `null` へ
            # 置換され `/quit` が 403 になる。足すなら `same-origin` か
            # `strict-origin-when-cross-origin` を選ぶこと。
            return "origin-missing"

        # G5/G6: 非安全メソッドだけに掛かる検査。安全メソッド (静的配信) はトークンを
        # 要求しない — 下位資産 (`js/main.js` / `styles.css`) の取得にトークンは載らないうえ、
        # `do_GET` は副作用も機微データも持たないためである。逆に言えば、GET 側へ副作用や
        # 秘密の読み出しを足した瞬間にこの前提が崩れる (`GuardedHandler` のクラス doc の
        # 禁止事項)。
        if self.command not in SAFE_METHODS:
            return self._content_type_reason() or self._token_reason()
        return None

    def _token_reason(self):
        """G6: セッショントークンの完全一致。`X-Session-Token` ヘッダ、無ければクエリ
        `?token=` を見る (`sendBeacon` はヘッダを付けられないため)。

        比較は `hmac.compare_digest` の定時間比較。素朴な `==` は一致した接頭辞の長さに
        比例して所要時間が変わり、同一マシンから何度でも試せるローカル攻撃者にとっては
        現実的な桁数のオラクルになる。トークン未設定のサーバは全拒否 (fail closed)。
        """
        expected = getattr(self.server, "guard_token", None)
        if not expected:
            return "token"
        supplied = self._single_header(TOKEN_HEADER)
        if supplied is None:
            values = parse_qs(urlsplit(self.path).query).get(TOKEN_QUERY) or ()
            # 2 本以上は「どちらが真か」を決められない (ヘッダ重複と同じ扱いで拒否)。
            supplied = values[0] if len(values) == 1 else None
        if supplied is None:
            return "token"
        try:
            ok = hmac.compare_digest(supplied.strip().encode("utf-8"), expected.encode("utf-8"))
        except UnicodeError:
            return "token"  # サロゲート等でエンコードできない値は一致しえない。
        return None if ok else "token"

    def _content_type_reason(self):
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

    def _single_header(self, name):
        """ちょうど 1 本だけ存在するときにその値を返す。0 本・2 本以上は `None`。"""
        values = self.headers.get_all(name)
        return values[0] if values and len(values) == 1 else None

    def _send_security_headers(self):
        """`SECURITY_HEADERS` を応答へ載せる。**全応答経路から呼ぶこと** (成功も 404 も 403 も)。
        欠けた応答が 1 本でもあれば、その URL だけを frame / 他オリジン読み出しに使える。"""
        for name, value in SECURITY_HEADERS:
            self.send_header(name, value)

    def _reject(self, reason):
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
            self._send_security_headers()
            self.end_headers()
            self.wfile.write(body)
        except OSError:
            pass  # 相手が先に切っただけ。ログを増やさない。
        if not drained:
            self._linger_close()
        self._log_reject(reason)
        return False

    def _drain_body(self):
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

    def _linger_close(self):
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

    def _log_reject(self, reason):
        counts = getattr(self.server, "guard_reject_counts", None)
        if counts is None:
            counts = self.server.guard_reject_counts = {}
        seen = counts.get(reason, 0) + 1
        counts[reason] = seen
        if seen > REJECT_LOG_LIMIT:
            return
        logging.getLogger("labeleditor").warning(
            "rejected request reason=%s host=%s origin=%s",
            reason,
            _log_safe(self.headers.get("Host")),
            _log_safe(self.headers.get("Origin")))


def _log_safe(value):
    """ログへ出す前に印字可能 ASCII の部分集合だけへ落として短く切る (ログ行の偽装防止)。"""
    if not value:
        return "-"
    kept = "".join(c for c in value if c in _LOG_SAFE_CHARS)
    return kept[:_LOG_DETAIL_MAX] or "-"


# ── HTTP ハンドラ ──


class Handler(GuardedHandler):
    """`ui.html` を配信し、ウィンドウ閉鎖時の `/quit` ビーコンでサーバを止めるだけの最小ハンドラ。

    同一オリジン検査は基底 `GuardedHandler.parse_request()` が一手に引き受けるので、以下の
    `do_*` / `_serve_static` に検査は書かない。ここへ `do_GET` の副作用を足すと、Origin を
    要求しない安全メソッドの経路が CSRF の穴になる点にだけ注意する。"""

    # ローカル単一ユーザ用途。アクセスログは出さない。
    def log_message(self, *args):
        pass

    def _send(self, code, body=b"", ctype="text/plain; charset=utf-8"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        # frame 化・他オリジン読み出し・MIME 誤解釈を断つ防御ヘッダ。成功応答も 404 も
        # ここを通るので、`_send` 以外の送信経路を足すときは基底の `_reject` と同じく
        # `_send_security_headers()` を必ず呼ぶこと。
        self._send_security_headers()
        self.end_headers()
        if body:
            self.wfile.write(body)

    # `last_seen` の更新は基底 `GuardedHandler._touch_if_same_origin` が Origin 完全一致時
    # にだけ行う。ここへ書き戻すと Origin 無し GET で watchdog を無期限に延命できる。

    def do_GET(self):
        # 経路分岐はクエリを外したパスで行う。UI へは `--app=http://127.0.0.1:p/?token=...`
        # で入るため、`self.path` を直接比較すると入口の `/` が素通りして 404 になる。
        path = urlsplit(self.path).path
        if path in ("/", "/index.html", "/ui.html"):
            self._send(200, UI_HTML, "text/html; charset=utf-8")
        elif path == "/lib/leader_geom.cjs":
            self._send(200, LEADER_GEOM, "text/javascript; charset=utf-8")
        elif path == "/favicon.ico":
            self._send(204)
        else:
            self._serve_static(self.path)

    def _serve_static(self, path):
        """同梱の追加静的アセット (`styles.css` / `js/*.js`) を配信する。
        防御: 拡張子ホワイトリスト (`STATIC_TYPES`) に一致し、かつ解決後パスが
        `RESOURCE_BASE` 配下に収まるものだけを返す (パストラバーサル防止)。それ以外は 404。"""
        rel = path.split("?", 1)[0].split("#", 1)[0].lstrip("/")
        ctype = STATIC_TYPES.get(os.path.splitext(rel)[1].lower())
        if not rel or ctype is None:
            self._send(404, b"not found")
            return
        full = os.path.normpath(os.path.join(RESOURCE_BASE, rel))
        if full != RESOURCE_BASE and not full.startswith(RESOURCE_BASE + os.sep):
            self._send(404, b"not found")
            return
        try:
            with open(full, "rb") as f:
                body = f.read()
        except OSError:
            self._send(404, b"not found")
            return
        self._send(200, body, ctype)

    def do_POST(self):
        # セッショントークンの検査は基底の `parse_request()` (G6) が済ませている。ここへ
        # 経路ごとの `if` を書き足さないこと — 書き足した分岐は必ずどれかを取りこぼす。
        # クエリ (`?token=...`) を外してから分岐する点は `do_GET` と同じ。
        path = urlsplit(self.path).path
        if path == "/quit":
            self._send(204)
            self.server.quit_event.set()
        elif path == "/ping":  # 生存ハートビート (`/ping`。フォールバック経路の watchdog 用)
            self._send(204)
        else:
            self._send(404, b"not found")


# ── Edge 探索 / プロセス監視 / 終了 watchdog ──


def _find_edge():
    """`msedge.exe` のパスを探す (App Paths レジストリ → 既知のインストール先)。無ければ `None`。"""
    if winreg is not None:
        for hive in (winreg.HKEY_LOCAL_MACHINE, winreg.HKEY_CURRENT_USER):
            try:
                with winreg.OpenKey(hive, EDGE_APP_PATHS_KEY) as k:
                    path, _ = winreg.QueryValueEx(k, None)
                    if path and os.path.exists(path):
                        return path
            except OSError:
                pass
    for env in EDGE_INSTALL_ENV_DIRS:
        base = os.environ.get(env)
        if base:
            cand = os.path.join(base, "Microsoft", "Edge", "Application", EDGE_EXE)
            if os.path.exists(cand):
                return cand
    return None


def _idle_watchdog(server):
    """ハートビート途絶を見張り、最終アクセスから `IDLE_TIMEOUT` 秒で self-shutdown する。
    Edge 経路・フォールバック経路の共通の終了バックストップ。窓を閉じた時の `/quit` ビーコンが
    本来の終了契機で、これはビーコン不達/タブクラッシュ時の保険。
    `quit_event` が立つまで `IDLE_TIMEOUT/4` ごとに起きて経過を確認する。"""
    while not server.quit_event.wait(IDLE_TIMEOUT / 4):
        if time.monotonic() - server.last_seen > IDLE_TIMEOUT:
            server.quit_event.set()
            return


# ── データ/ログのフォルダ解決とロギング ──


def _data_dir():
    """データ・診断ログを置く基準フォルダ (exe と同じ場所の `data/`、ポータブル)。
    frozen 時は実行ファイルのある永続フォルダ、ソース実行時は本ファイルの場所を基準にする。"""
    base = (os.path.dirname(os.path.abspath(sys.executable))
            if getattr(sys, "frozen", False)
            else os.path.dirname(os.path.abspath(__file__)))
    d = os.path.join(base, "data")
    os.makedirs(d, exist_ok=True)
    return d


def _log_dir():
    """診断ログ (`startup.log` / `edge.log`) を置くフォルダ (`data/logs/`、ポータブル)。
    `data/` 直下に散らさず階層化し、アプリ終了後も残してポストモーテムに使える状態を保つ。"""
    d = os.path.join(_data_dir(), "logs")
    os.makedirs(d, exist_ok=True)
    return d


def _setup_logging():
    """起動診断ログを `data/logs/startup.log` へ出す。

    exe は `console=False` (`LabelEditor.spec` / `scripts\build.bat` の --windowed) で stderr が無く、
    起動失敗が一切見えないため、ポータブルな `data/logs/` にファイル出力して可観測性を確保する。
    ログの用意に失敗しても起動は止めない (`NullHandler` へフォールバック)。"""
    log = logging.getLogger("labeleditor")
    log.setLevel(logging.INFO)
    log.propagate = False
    if log.handlers:  # 二重起動防止 (テスト等で複数回呼ばれても重複させない)
        return log
    try:
        handler = logging.FileHandler(os.path.join(_log_dir(), "startup.log"), encoding="utf-8")
        handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
        log.addHandler(handler)
    except OSError:
        log.addHandler(logging.NullHandler())
    return log


def _watch_proc(proc, log):
    """起動した `msedge.exe` の終了を観測してログするだけ (サーバ終了の引き金にはしない)。

    Edge はコールド時、新規 user-data-dir のプロファイル生成過程で自身を別プロセスへ
    再起動し、最初に起動したプロセスだけが早期終了することがある。これに `proc.wait()` で
    引きずられてサーバを畳むと、生き残った Edge 窓が読みに来た時にはポートが死んでいて
    初回起動が空白になる。終了は `/quit` ビーコン + ハートビート watchdog に任せ、ここでは
    早期終了を記録するだけにすることで初回から成功させる。"""
    started = time.monotonic()
    code = proc.wait()
    log.info("spawned edge proc exited code=%s after %.1fs (server kept alive)",
             code, time.monotonic() - started)


# ── エントリポイント ──


def create_server(port=0, token=None):
    """127.0.0.1 で待ち受けるサーバを構築する (まだ serve はしない)。既定の `port=0` は空きポート。

    `ThreadingHTTPServer` を手組みせず**必ずこの関数を通す**こと: `configure_guard` を忘れた
    サーバは `unconfigured` の全拒否になる (fail closed なので黙って穴が開くことはないが、
    構築経路が複数あると設定漏れを作れる)。許可リストは bind 後の実ポートから作る。

    `token` はセッショントークン。既定 (`None`) では起動ごとに新しい値を作る。固定値を
    渡してよいのはテストの使い捨てサーバだけで、本番経路 (`main()`) は既定に任せること。
    発行後の値は `server.guard_token` から読める (`--app=` の URL へ載せる用)。"""
    server = http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler)
    server.quit_event = threading.Event()  # `/quit` ビーコン or watchdog で立てる
    server.last_seen = time.monotonic()    # 最終リクエスト時刻 (watchdog 用)
    configure_guard(server, server.server_address[1], token or _new_session_token())
    return server


def main():
    log = _setup_logging()
    # 127.0.0.1 の空きポートで待受 (外部公開しない)。
    server = create_server()
    port = server.server_address[1]
    # UI へはセッショントークン付き URL を渡す。トークンを知る文脈だけが `/quit` `/ping` を
    # 撃てる (G6)。**ログには素の URL を書く** — `data/logs/startup.log` はポータブル配布物の
    # 隣に残り、ポートを知りたい攻撃者が最初に読む場所なので、そこへトークンを置いたら
    # 認可を自分で無効化することになる。
    url = f"http://127.0.0.1:{port}/?token={quote(server.guard_token, safe='')}"
    log.info("server listening on http://127.0.0.1:%s/ (frozen=%s)",
             port, getattr(sys, "frozen", False))

    threading.Thread(target=server.serve_forever, daemon=True).start()

    edge = _find_edge()
    log.info("edge: %s", edge or "(not found, falling back to default browser)")
    proc = None
    if edge:
        # 端末標準の「管理された」既定プロファイルでアプリ窓を開く。以前は隔離 user-data-dir +
        # `--disable-gpu` (ソフトウェア描画固定) で起動していたが、VDI ではこの非標準構成だと
        # レンダラが不安定で窓ごとクラッシュした (`edge.log`: "GetGpuDriverOverlayInfo failed to
        # retrieve video device"。通常の Edge ブラウジングは安定)。そこで余計なフラグを付けず、
        # 安定動作している既定 Edge と同じ構成で開く。`--enable-logging` で `edge.log` に診断を残す。
        try:
            proc = subprocess.Popen(
                [
                    edge,
                    f"--app={url}",
                    "--no-first-run",
                    "--no-default-browser-check",
                    "--enable-logging",
                    f"--log-file={os.path.join(_log_dir(), 'edge.log')}",
                    "--v=1",
                ],
            )
            log.info("edge launched pid=%s", proc.pid)
        except OSError as exc:
            log.warning("edge launch failed: %s", exc)
            proc = None

    # サーバの寿命は起動した `msedge.exe` プロセスの終了に縛らない。終了契機は窓を閉じた時の
    # `/quit` ビーコンと、ハートビート途絶を見張る watchdog に一本化する (Edge・既定ブラウザ
    # 共通)。これにより Edge のコールド再起動で起動プロセスが早期終了してもサーバが落ちず、
    # 初回起動から成功する。`proc` は終了時に Edge を片付けるためのハンドルとしてのみ保持する。
    try:
        if proc is None:
            webbrowser.open(url)
        else:
            # 早期終了を観測ログに残すだけ (終了の引き金にはしない)。
            threading.Thread(target=_watch_proc, args=(proc, log), daemon=True).start()
        threading.Thread(target=_idle_watchdog, args=(server,), daemon=True).start()
        server.quit_event.wait()
        # `/quit` ビーコン (窓閉鎖) か watchdog (ハートビート途絶) かを `last_seen` から推定。
        idle = time.monotonic() - server.last_seen
        log.info("shutting down (reason=%s, idle=%.1fs)",
                 "idle-timeout" if idle > IDLE_TIMEOUT else "quit-beacon", idle)
    finally:
        server.shutdown()
        server.server_close()
        if proc is not None and proc.poll() is None:
            proc.terminate()


if __name__ == "__main__":
    main()
