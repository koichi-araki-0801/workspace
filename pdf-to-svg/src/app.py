"""アプリのエントリポイント。

QtWebEngine を同梱せず、OS 標準の Edge を「アプリモード」で開いて UI を表示する
(graph-editor と同方式)。本ファイルは小さなローカル HTTP サーバ (web.server) を
起動し、Edge を起動・常駐管理する。ファイル入出力は UI 側 (resources/web) が
File System Access API で行う (http://127.0.0.1 は secure context のため利用可)。

これにより PySide6 / QtWebEngine ランタイムを同梱せずに済み、配布物が大幅に小さくなる。
"""
from __future__ import annotations

import logging
import os
import shutil
import subprocess
import tempfile
import threading
import time
import webbrowser

import config
from dictionary.store import DictionaryStore
from web.rpc_methods import WebSession
from web.server import create_server
from web.undo_stack import UndoStack

# 既定ブラウザ(フォールバック)経路ではプロセスハンドルが無いため、UI からの定期
# ハートビート (/ping) が途絶してからこの秒数で self-shutdown する。本来の終了契機は
# 窓を閉じたときの /quit ビーコン。これはビーコン不達/タブクラッシュ時の保険。
IDLE_TIMEOUT = 60

try:
    import winreg  # Windows のみ (Edge のパス探索に使用)
except ImportError:  # pragma: no cover - 非 Windows 開発時
    winreg = None

EDGE_EXE = "msedge.exe"
EDGE_APP_PATHS_KEY = r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe"
EDGE_INSTALL_ENV_DIRS = ("ProgramFiles(x86)", "ProgramFiles", "LocalAppData")


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
    Edge 経路・フォールバック経路の共通の終了バックストップ。窓を閉じた時の /quit ビーコンが
    本来の終了契機で、これはビーコン不達/タブクラッシュ時の保険。
    quit_event が立つまで IDLE_TIMEOUT/4 ごとに確認する。"""
    while not server.quit_event.wait(IDLE_TIMEOUT / 4):
        if time.monotonic() - server.last_seen > IDLE_TIMEOUT:
            server.quit_event.set()
            return


def _setup_logging():
    """起動診断ログを ``data/startup.log`` へ出す。

    exe は ``console=False`` (packaging/pdftosvg.spec) で stderr が無く、起動失敗が一切
    見えないため、ポータブルな ``data/`` にファイル出力して可観測性を確保する。ログの
    用意に失敗しても起動は止めない (NullHandler へフォールバック)。"""
    log = logging.getLogger("pdftosvg")
    log.setLevel(logging.INFO)
    log.propagate = False
    if log.handlers:  # 二重起動防止 (テスト等で複数回呼ばれても重複させない)
        return log
    try:
        handler = logging.FileHandler(config.data_dir() / "startup.log", encoding="utf-8")
        handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
        log.addHandler(handler)
    except OSError:
        log.addHandler(logging.NullHandler())
    return log


def _watch_proc(proc, log):
    """起動した msedge.exe の終了を観測してログするだけ (サーバ終了の引き金にはしない)。

    Edge はコールド時、新規 user-data-dir のプロファイル生成過程で自身を別プロセスへ
    再起動し、最初に起動したプロセスだけが早期終了することがある。これに proc.wait() で
    引きずられてサーバを畳むと、生き残った Edge 窓が読みに来た時にはポートが死んでいて
    初回起動が空白になる。終了は /quit ビーコン + ハートビート watchdog に任せ、ここでは
    早期終了を記録するだけにすることで初回から成功させる。"""
    started = time.monotonic()
    code = proc.wait()
    log.info("spawned edge proc exited code=%s after %.1fs (server kept alive)",
             code, time.monotonic() - started)


def main() -> int:
    log = _setup_logging()
    store = DictionaryStore(config.dictionary_json_path())
    session = WebSession(store, UndoStack())
    server = create_server(str(config.resource_path("web")), session)
    port = server.server_address[1]
    url = f"http://127.0.0.1:{port}/"
    log.info("server listening on %s (frozen=%s)", url, config.is_frozen())

    threading.Thread(target=server.serve_forever, daemon=True).start()

    edge = _find_edge()
    log.info("edge: %s", edge or "(not found, falling back to default browser)")
    profile_dir = None
    proc = None
    if edge:
        # 専用 user-data-dir で「アプリ窓」を独立プロセスとして起動する。
        profile_dir = tempfile.mkdtemp(prefix="pdftosvg-edge-")
        try:
            proc = subprocess.Popen([
                edge,
                f"--app={url}",
                f"--user-data-dir={profile_dir}",
                "--no-first-run",
                "--no-default-browser-check",
            ])
            log.info("edge launched pid=%s profile=%s", proc.pid, profile_dir)
        except OSError as exc:
            log.warning("edge launch failed: %s", exc)
            proc = None

    # サーバの寿命は起動した msedge.exe プロセスの終了に縛らない。終了契機は窓を閉じた時の
    # /quit ビーコンと、ハートビート途絶を見張る watchdog に一本化する (Edge・既定ブラウザ
    # 共通)。これにより Edge のコールド再起動で起動プロセスが早期終了してもサーバが落ちず、
    # 初回起動から成功する。proc は終了時に Edge を片付けるためのハンドルとしてのみ保持する。
    try:
        if proc is None:
            webbrowser.open(url)
        else:
            # 早期終了を観測ログに残すだけ (終了の引き金にはしない)。
            threading.Thread(target=_watch_proc, args=(proc, log), daemon=True).start()
        threading.Thread(target=_idle_watchdog, args=(server,), daemon=True).start()
        server.quit_event.wait()
        # /quit ビーコン (窓閉鎖) か watchdog (ハートビート途絶) かを last_seen から推定。
        idle = time.monotonic() - server.last_seen
        log.info("shutting down (reason=%s, idle=%.1fs)",
                 "idle-timeout" if idle > IDLE_TIMEOUT else "quit-beacon", idle)
    finally:
        server.shutdown()
        server.server_close()
        if proc is not None and proc.poll() is None:
            proc.terminate()
        if profile_dir:
            shutil.rmtree(profile_dir, ignore_errors=True)
        store.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
