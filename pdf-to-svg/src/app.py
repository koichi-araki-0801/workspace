"""アプリのエントリポイント。"""
from __future__ import annotations

import sys

from PySide6.QtWidgets import QApplication

from web.scheme import register_scheme


def main() -> int:
    # カスタムスキームは QApplication 構築前に登録する必要がある
    register_scheme()
    app = QApplication(sys.argv)
    app.setApplicationName("PdfToSvg")
    # MainWindow (= QtWebEngine) は QApplication 構築後に import する
    from ui.main_window import MainWindow

    win = MainWindow()
    win.show()
    return app.exec()


if __name__ == "__main__":
    sys.exit(main())
