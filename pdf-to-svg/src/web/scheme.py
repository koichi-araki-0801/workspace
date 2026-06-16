"""``app://`` カスタムスキーム: resources/web/ を安全なローカル origin として配信。

``file://`` は origin が null 扱いになり fetch / Web フォント / WebChannel で
不都合が出るため、独自スキームを安全コンテキストとして登録する。
``register_scheme()`` は QApplication 構築前に 1 度だけ呼ぶこと。
"""
from __future__ import annotations

from pathlib import Path

from PySide6.QtCore import QBuffer, QByteArray, QIODevice
from PySide6.QtWebEngineCore import (
    QWebEngineUrlScheme,
    QWebEngineUrlSchemeHandler,
)

SCHEME_NAME = b"app"
SCHEME_HOST = "app"

_MIME = {
    ".html": "text/html",
    ".css": "text/css",
    ".js": "application/javascript",
    ".mjs": "application/javascript",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".woff2": "font/woff2",
    ".woff": "font/woff",
    ".ttf": "font/ttf",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
}


def register_scheme() -> None:
    """QApplication 構築前に呼ぶ。``app`` スキームを安全コンテキストとして登録。"""
    scheme = QWebEngineUrlScheme(SCHEME_NAME)
    scheme.setSyntax(QWebEngineUrlScheme.Syntax.Host)
    scheme.setFlags(
        QWebEngineUrlScheme.Flag.SecureScheme
        | QWebEngineUrlScheme.Flag.LocalAccessAllowed
        | QWebEngineUrlScheme.Flag.CorsEnabled
    )
    QWebEngineUrlScheme.registerScheme(scheme)


class WebAssetHandler(QWebEngineUrlSchemeHandler):
    """resources/web/ 配下のファイルを ``app://app/<path>`` で返す。"""

    def __init__(self, root: Path, parent=None):
        super().__init__(parent)
        self._root = Path(root).resolve()

    def requestStarted(self, job) -> None:  # noqa: N802 (Qt override)
        rel = job.requestUrl().path().lstrip("/") or "index.html"
        target = (self._root / rel).resolve()
        # ルート外アクセスを防ぐ
        try:
            target.relative_to(self._root)
        except ValueError:
            job.fail(job.Error.UrlNotFound)
            return
        if not target.is_file():
            job.fail(job.Error.UrlNotFound)
            return

        data = target.read_bytes()
        mime = _MIME.get(target.suffix.lower(), "application/octet-stream")
        buf = QBuffer(job)  # job を親にしてライフタイムを委ねる
        buf.setData(QByteArray(data))
        buf.open(QIODevice.OpenModeFlag.ReadOnly)
        job.reply(mime.encode("ascii"), buf)
