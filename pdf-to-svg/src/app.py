"""アプリのエントリポイント。

QtWebEngine を同梱せず、OS 標準の Edge を「アプリモード」で開いて UI を表示する
(graph-editor と同方式)。本ファイルは小さなローカル HTTP サーバ (web.server) を
起動し、Edge を起動・常駐管理する。ファイル入出力は UI 側 (resources/web) が
File System Access API で行う (http://127.0.0.1 は secure context のため利用可)。

これにより PySide6 / QtWebEngine ランタイムを同梱せずに済み、配布物が大幅に小さくなる。
"""
from __future__ import annotations

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
    """ハートビート途絶を見張り、最終アクセスから IDLE_TIMEOUT 秒で self-shutdown する
    (フォールバック経路用)。quit_event が立つまで IDLE_TIMEOUT/4 ごとに確認する。"""
    while not server.quit_event.wait(IDLE_TIMEOUT / 4):
        if time.monotonic() - server.last_seen > IDLE_TIMEOUT:
            server.quit_event.set()
            return


def main() -> int:
    store = DictionaryStore(config.dictionary_json_path())
    session = WebSession(store, UndoStack())
    server = create_server(str(config.resource_path("web")), session)
    port = server.server_address[1]
    url = f"http://127.0.0.1:{port}/"

    threading.Thread(target=server.serve_forever, daemon=True).start()

    edge = _find_edge()
    profile_dir = None
    proc = None
    if edge:
        # 専用 user-data-dir で「アプリ窓」を独立プロセスとして起動 (閉じたら wait が返る)。
        profile_dir = tempfile.mkdtemp(prefix="pdftosvg-edge-")
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
            # アプリ窓を閉じるか、/quit ビーコンが来たら終了。
            threading.Thread(
                target=lambda: (proc.wait(), server.quit_event.set()), daemon=True
            ).start()
            server.quit_event.wait()
        else:
            # Edge 不在: 既定ブラウザで開く。プロセスハンドルが無いので /quit ビーコン
            # (窓閉鎖) に加え、ハートビート途絶を見張る watchdog で確実に終了させる。
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
        store.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
