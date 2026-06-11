"""アプリのエントリポイント。"""
from __future__ import annotations

import sys

from PySide6.QtGui import QFontDatabase
from PySide6.QtWidgets import QApplication

import config
from model import fonts
from ui.main_window import MainWindow


def _register_bundled_fonts() -> None:
    """同梱フォント (BIZ UD / Noto Serif JP) を Qt へ登録し、エディタ表示でも使えるようにする。"""
    filenames = set(fonts.BUNDLED_FONTS.values()) | set(fonts.BUNDLED_VARIABLE.values())
    for filename in sorted(filenames):
        path = config.resource_path("fonts", filename)
        if path.exists():
            QFontDatabase.addApplicationFont(str(path))


def main() -> int:
    app = QApplication(sys.argv)
    app.setApplicationName("PdfToSvg")
    _register_bundled_fonts()
    win = MainWindow()
    win.show()
    return app.exec()


if __name__ == "__main__":
    sys.exit(main())
