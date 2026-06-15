"""dev 専用スモークテスト: Web UI をオフスクリーンで起動し、QWebChannel 越しに
rpc('state') が往復するか (JS→Python→JS) を確認する。

    QT_QPA_PLATFORM=offscreen python tools/smoke_web.py
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))
os.environ.setdefault("QTWEBENGINE_DISABLE_SANDBOX", "1")
os.environ.setdefault(
    "QTWEBENGINE_CHROMIUM_FLAGS", "--no-sandbox --disable-gpu --disable-software-rasterizer"
)

from PySide6.QtCore import QTimer, QUrl  # noqa: E402
from PySide6.QtWebEngineCore import QWebEnginePage  # noqa: E402
from PySide6.QtWidgets import QApplication  # noqa: E402

from web.scheme import SCHEME_NAME, register_scheme  # noqa: E402

EXIT = {"code": 1}


class LoggingPage(QWebEnginePage):
    def javaScriptConsoleMessage(self, level, msg, line, src):  # noqa: N802
        print(f"JS[{level}] {src}:{line}: {msg}")


def main() -> int:
    register_scheme()
    app = QApplication(sys.argv)
    from ui.main_window import MainWindow

    win = MainWindow()
    # 診断用にコンソールを拾うページへ差し替え
    lp = LoggingPage(win.view)
    lp.profile().installUrlSchemeHandler(SCHEME_NAME, win._handler)
    lp.setWebChannel(win.channel)
    win.view.setPage(lp)
    win.view.load(QUrl("app://app/index.html"))
    win.show()
    page = win.view.page()

    # ダイアログを経由せず、フィクスチャ PDF を直接セッションへ読み込んでデータ経路を検証
    from pathlib import Path
    from dictionary import apply as dict_apply
    from engine.pdf_engine import load_document
    fixture = Path(__file__).resolve().parents[1] / "tests" / "fixtures" / "vector_sample.pdf"
    doc = load_document(str(fixture))
    for pg in doc.pages:
        dict_apply.auto_apply(pg, win.bridge.store, only_headers=win.bridge.session.only_headers)
    win.bridge.session.docs.append(doc)
    print("preloaded:", fixture.name, "pages=", len(doc.pages))

    def on_load(ok):
        print("loadFinished:", ok)
        page.runJavaScript(
            "JSON.stringify({QWebChannel: typeof QWebChannel, qt: typeof window.qt, "
            "transport: !!(window.qt&&window.qt.webChannelTransport), "
            "rpc: typeof window.rpc, backend: !!window.__backend})", diag)

    def diag(val):
        print("DIAG:", val)
        page.runJavaScript(
            "window.__rpcReady.then(function(){return rpc('state');})"
            ".then(function(st){window.__state=st;return rpc('pageSvg',{fileIndex:0,pageInFile:0});})"
            ".then(function(d){window.__probe=JSON.stringify({total:window.__state.total,"
            "changed2:window.__state.changed2,svgLen:d.svg.length,hasText:d.svg.indexOf('<text')>=0,"
            "hasDataEl:d.svg.indexOf('data-el=')>=0});})"
            ".catch(function(e){window.__probe='ERR:'+e;});"
        )
        QTimer.singleShot(2500, check)

    def check():
        page.runJavaScript("window.__probe || 'pending'", got)

    def got(val):
        print("PROBE:", val)
        EXIT["code"] = 0 if (val and val != "pending" and not str(val).startswith("ERR")) else 2
        app.quit()

    win.view.loadFinished.connect(on_load)
    QTimer.singleShot(15000, app.quit)  # ハードタイムアウト
    app.exec()
    return EXIT["code"]


if __name__ == "__main__":
    sys.exit(main())
