# -*- coding: utf-8 -*-
"""PdfToSvg 操作手順書向けの実機スクリーンショット自動取得ハーネス。

`pdf-to-svg/src/web/server.py` の `create_server()` を直接起動し（`app.py` の Edge 起動・
60 秒アイドル watchdog を経由しないので撮影中にサーバが落ちない）、Playwright(chromium) で
4 ステップの実画面を撮影して `docs/pdf-to-svg/images/` に PNG 出力する。

- 入力 PDF: `tests/fixtures/vector_sample.pdf`（"Header A" / "Value 123"）
- 辞書は一時ファイルに作り「Header A → 見出し A」を投入（本番 data/dictionary.json は汚さない）
- ファイル選択は File System Access API を無効化し、隠し <input type=file> 経由で set_files
"""
from __future__ import annotations

import pathlib
import sys
import tempfile
import threading
import time

# リポジトリルートからの相対解決 (このファイルは <repo>/docs/pdf-to-svg/_build/ にある)。
REPO = pathlib.Path(__file__).resolve().parents[3]
ROOT = REPO / "pdf-to-svg"
sys.path.insert(0, str(ROOT / "src"))

from dictionary.store import DictionaryStore  # noqa: E402
from web.rpc_methods import WebSession  # noqa: E402
from web.server import create_server  # noqa: E402
from web.undo_stack import UndoStack  # noqa: E402

OUT = REPO / "docs" / "pdf-to-svg" / "images"
OUT.mkdir(parents=True, exist_ok=True)
SAMPLE = ROOT / "tests" / "fixtures" / "vector_sample.pdf"


def start_server():
    """一時辞書を仕込んだ WebSession でローカルサーバを起動し (server, url) を返す。"""
    tmpdir = tempfile.mkdtemp(prefix="pdftosvg-shots-")
    store = DictionaryStore(pathlib.Path(tmpdir) / "dictionary.json")
    store.add("Header A", "見出し A")  # ステップ2で実際の置換を見せるための種
    session = WebSession(store, UndoStack())
    session.only_headers = True  # 既定どおりヘッダのみ（"Header A" は見出し検出される）
    server = create_server(str(ROOT / "resources" / "web"), session)
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://127.0.0.1:{port}/"


def shot(page, name):
    path = OUT / name
    page.screenshot(path=str(path))
    print("  saved", path.name)


def skip_guard_if_present(page):
    """未確認ガードバーが出ていたら「未確認をすべてスキップして進む」を押す。"""
    try:
        if page.is_visible("#guard"):
            page.click("#guard-skip")
            return True
    except Exception:
        pass
    return False


def main():
    from playwright.sync_api import sync_playwright

    server, url = start_server()
    print("server:", url)
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()
            ctx = browser.new_context(
                viewport={"width": 1280, "height": 880},
                device_scale_factor=2,
            )
            page = ctx.new_page()
            # File System Access API を消し、隠し <input type=file> フォールバックへ。
            page.add_init_script(
                "delete window.showOpenFilePicker;"
                "delete window.showSaveFilePicker;"
                "delete window.showDirectoryPicker;"
            )
            page.goto(url)
            page.wait_for_selector("#btn-pick")

            # ---- ステップ1: PDF を選ぶ ----
            with page.expect_file_chooser() as fc:
                page.click("#btn-pick")
            fc.value.set_files(str(SAMPLE))
            page.wait_for_selector("#file-cards .file-card", timeout=15000)
            time.sleep(0.6)
            shot(page, "step1_select.png")

            # ---- ステップ2: 用語を置換（確認タブ）----
            page.click("#btn-next")
            page.wait_for_selector('.screen[data-screen="2"].on', timeout=10000)
            page.wait_for_selector("#doc-master svg", timeout=15000)
            time.sleep(1.0)
            shot(page, "step2_replace.png")

            # ---- ステップ2(辞書タブ) ----
            page.click('[data-tab="dict"]')
            page.wait_for_selector('[data-pane="dict"].on', timeout=5000)
            time.sleep(0.5)
            shot(page, "step2b_dict.png")
            page.click('[data-tab="confirm"]')  # 確認タブに戻す

            # ---- ステップ3: 削除・枠線の編集 ----
            page.click("#btn-next")
            skip_guard_if_present(page)
            page.wait_for_selector('.screen[data-screen="3"].on', timeout=10000)
            page.wait_for_selector("#trim-stage svg", timeout=15000)
            time.sleep(1.0)
            shot(page, "step3_edit.png")

            # ---- ステップ4: SVG に書き出す ----
            page.click("#btn-next")
            skip_guard_if_present(page)
            page.wait_for_selector('.screen[data-screen="4"].on', timeout=10000)
            time.sleep(0.6)
            shot(page, "step4_export.png")

            browser.close()
    finally:
        server.shutdown()
        server.server_close()
    print("done.")


if __name__ == "__main__":
    main()
