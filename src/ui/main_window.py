"""メインウィンドウ。Web UI (resources/web/) を QWebEngineView でホストし、
QWebChannel で Python バックエンド (web.bridge.Bridge) に橋渡しする。
"""
from __future__ import annotations

from PySide6.QtCore import QUrl
from PySide6.QtWebChannel import QWebChannel
from PySide6.QtWebEngineWidgets import QWebEngineView
from PySide6.QtWidgets import QMainWindow

import config
from web.bridge import Bridge
from web.scheme import SCHEME_NAME, WebAssetHandler


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("PdfToSvg — PDF→SVG 変換・編集")
        self.resize(1200, 860)

        self.view = QWebEngineView(self)
        self.setCentralWidget(self.view)

        # resources/web/ を app:// で配信するハンドラを (共有) プロファイルに登録
        self._handler = WebAssetHandler(config.resource_path("web"))
        self.view.page().profile().installUrlSchemeHandler(SCHEME_NAME, self._handler)

        # バックエンドを QWebChannel に公開
        self.bridge = Bridge(self)
        self.channel = QWebChannel(self)
        self.channel.registerObject("backend", self.bridge)
        self.view.page().setWebChannel(self.channel)

        self.view.load(QUrl("app://app/index.html"))

    def closeEvent(self, event) -> None:
        self.bridge.close()
        super().closeEvent(event)
