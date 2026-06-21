"""SVG ラベル位置エディタ — ローカルサーバ版 (依存ゼロ・標準ライブラリのみ)。

graph2 が生成した SVG を読み込み、ラベル (テキスト + leader) をマウスでドラッグ調整して
修正版 SVG を書き出すスタンドアロンのデスクトップ風アプリ。

設計: ブラウザエンジンを同梱せず、OS に標準搭載の Edge を「アプリモード」で開いて UI を表示する。
  - 本ファイル = 小さなローカル HTTP サーバ (127.0.0.1 のみ) で `ui.html` を配信し、Edge を
    起動・常駐管理する。
  - ファイル入出力は `ui.html` 側でブラウザの File System Access API を使う (http://127.0.0.1 は
    secure context なので利用可能)。よって本サーバは静的配信とライフサイクル管理のみを担う。

これにより WebView2 ランタイムや pywebview を同梱せずに済み、配布物は ~10MB の単一 exe で済む。

開発実行:  python app.py
exe ビルド:  build.bat   (PyInstaller --onefile, 同梱の `ui.html` を --add-data)
"""

import http.server
import logging
import os
import subprocess
import sys
import threading
import time
import webbrowser

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

# 同梱ファイルの基準ディレクトリ (PyInstaller 実行時は展開先 `_MEIPASS`、開発実行時は本ファイルの場所)。
RESOURCE_BASE = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))


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


# ── HTTP ハンドラ ──


class Handler(http.server.BaseHTTPRequestHandler):
    """`ui.html` を配信し、ウィンドウ閉鎖時の `/quit` ビーコンでサーバを止めるだけの最小ハンドラ。"""

    # ローカル単一ユーザ用途。アクセスログは出さない。
    def log_message(self, *args):
        pass

    def _send(self, code, body=b"", ctype="text/plain; charset=utf-8"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if body:
            self.wfile.write(body)

    def _touch(self):
        """アイドル watchdog 用に最終リクエスト時刻を更新する。"""
        self.server.last_seen = time.monotonic()

    def do_GET(self):
        self._touch()
        if self.path in ("/", "/index.html", "/ui.html"):
            self._send(200, UI_HTML, "text/html; charset=utf-8")
        elif self.path == "/lib/leader_geom.cjs":
            self._send(200, LEADER_GEOM, "text/javascript; charset=utf-8")
        elif self.path == "/favicon.ico":
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
        self._touch()
        if self.path == "/quit":
            self._send(204)
            self.server.quit_event.set()
        elif self.path == "/ping":  # 生存ハートビート (`/ping`。フォールバック経路の watchdog 用)
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

    exe は `console=False` (`LabelEditor.spec` / `build.bat` の --windowed) で stderr が無く、
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


def main():
    log = _setup_logging()
    # 127.0.0.1 の空きポートで待受 (外部公開しない)。
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.quit_event = threading.Event()  # `/quit` ビーコン or watchdog で立てる
    server.last_seen = time.monotonic()    # 最終リクエスト時刻 (watchdog 用)
    port = server.server_address[1]
    url = f"http://127.0.0.1:{port}/"
    log.info("server listening on %s (frozen=%s)", url, getattr(sys, "frozen", False))

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
