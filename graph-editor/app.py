"""SVG ラベル位置エディタ — ローカルサーバ版 (依存ゼロ・標準ライブラリのみ)

graph2 が生成した SVG を読み込み、ラベル (テキスト + leader) をマウスでドラッグ調整して
修正版 SVG を書き出すスタンドアロンのデスクトップ風アプリ。

設計: ブラウザエンジンを同梱せず、OS に標準搭載の Edge を「アプリモード」で開いて UI を表示する。
  - 本ファイル = 小さなローカル HTTP サーバ (127.0.0.1 のみ) で ui.html を配信し、Edge を起動・常駐管理。
  - ファイル入出力は ui.html 側でブラウザの File System Access API を使う (http://127.0.0.1 は
    secure context なので利用可能)。よって本サーバは静的配信とライフサイクル管理のみを担う。

これにより WebView2 ランタイムや pywebview を同梱せずに済み、配布物は ~10MB の単一 exe で済む。

開発実行:  python app.py
exe ビルド:  build.bat   (PyInstaller --onefile, 同梱の ui.html を --add-data)
"""

import http.server
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import webbrowser

# 既定ブラウザ(フォールバック)経路ではプロセスハンドルが無いため、UI からの定期ハートビート
# (/ping) が途絶してからこの秒数で self-shutdown する。本来の終了契機は窓を閉じたときの /quit
# ビーコンで、これはビーコン不達/タブクラッシュ時にゾンビプロセスを残さないための保険。
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


# 同梱ファイルの基準ディレクトリ (PyInstaller 実行時は展開先 _MEIPASS、開発実行時は本ファイルの場所)。
RESOURCE_BASE = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))


def resource_path(rel: str) -> str:
    """開発実行でも PyInstaller 実行でも同梱ファイルへ解決する。"""
    return os.path.join(RESOURCE_BASE, rel)


# 追加の静的アセット (styles.css / js/*.js) の配信を許す拡張子と MIME。
# ここに無い拡張子は 404。`/` と `/lib/leader_geom.cjs` は do_GET 側で個別配信する。
STATIC_TYPES = {
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
}


with open(resource_path("ui.html"), "rb") as _f:
    UI_HTML = _f.read()

# ui.html が <script src> で読む共有純粋関数。起動時に一度だけ読み込んで配信する。
with open(resource_path(os.path.join("lib", "leader_geom.cjs")), "rb") as _f:
    LEADER_GEOM = _f.read()


class Handler(http.server.BaseHTTPRequestHandler):
    """ui.html を配信し、ウィンドウ閉鎖時の /quit ビーコンでサーバを止めるだけの最小ハンドラ。"""

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
        """同梱の追加静的アセット (styles.css / js/*.js) を配信する。
        防御: 拡張子ホワイトリスト (STATIC_TYPES) に一致し、かつ解決後パスが
        RESOURCE_BASE 配下に収まるものだけを返す (パストラバーサル防止)。それ以外は 404。"""
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
        elif self.path == "/ping":  # 生存ハートビート (フォールバック経路の watchdog 用)
            self._send(204)
        else:
            self._send(404, b"not found")


def _find_edge():
    """msedge.exe のパスを探す (App Paths レジストリ → 既知のインストール先)。無ければ None。"""
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
    """ハートビート途絶を見張り、最終アクセスから IDLE_TIMEOUT 秒で self-shutdown する。
    quit_event が立つまで IDLE_TIMEOUT/4 ごとに起きて経過を確認する (フォールバック経路用)。"""
    while not server.quit_event.wait(IDLE_TIMEOUT / 4):
        if time.monotonic() - server.last_seen > IDLE_TIMEOUT:
            server.quit_event.set()
            return


def main():
    # 127.0.0.1 の空きポートで待受 (外部公開しない)。
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.quit_event = threading.Event()  # /quit ビーコン or プロセス終了で立てる
    server.last_seen = time.monotonic()    # 最終リクエスト時刻 (フォールバック watchdog 用)
    port = server.server_address[1]
    url = f"http://127.0.0.1:{port}/"

    threading.Thread(target=server.serve_forever, daemon=True).start()

    edge = _find_edge()
    profile_dir = None
    proc = None
    if edge:
        # 専用 user-data-dir で「アプリ窓」を独立プロセスとして起動 (閉じたら wait が返る)。
        profile_dir = tempfile.mkdtemp(prefix="labeleditor-edge-")
        try:
            proc = subprocess.Popen([
                edge,
                f"--app={url}",
                f"--user-data-dir={profile_dir}",
                "--no-first-run",
                "--no-default-browser-check",
            ])
        except OSError:
            proc = None

    try:
        if proc is not None:
            # アプリ窓を閉じるか、pagehide ビーコンが来たら終了。
            watcher = threading.Thread(target=lambda: (proc.wait(), server.quit_event.set()), daemon=True)
            watcher.start()
            server.quit_event.wait()
        else:
            # Edge 不在: 既定ブラウザで開く。プロセスハンドルが無いので、/quit ビーコン (窓閉鎖)
            # に加え、ハートビート途絶を見張る watchdog で確実に終了させる (ゾンビ化を防ぐ)。
            webbrowser.open(url)
            threading.Thread(target=_idle_watchdog, args=(server,), daemon=True).start()
            server.quit_event.wait()
    finally:
        server.shutdown()
        server.server_close()
        if proc is not None and proc.poll() is None:
            proc.terminate()
        if profile_dir:
            shutil.rmtree(profile_dir, ignore_errors=True)


if __name__ == "__main__":
    main()
