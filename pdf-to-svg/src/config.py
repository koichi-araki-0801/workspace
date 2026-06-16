"""アプリ全体のパス解決・設定。

PyInstaller でバンドルした場合 (`sys._MEIPASS` / `sys.executable`) と、ソース実行時の
双方でリソース/データのパスを正しく解決する。

データ (辞書・設定) は **exe と同じフォルダの `data/`** に置くポータブル方式。
C ドライブや `%APPDATA%` に依存しないため、フォルダごと別端末/別ドライブへコピーして使える。
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

APP_NAME = "PdfToSvg"


def is_frozen() -> bool:
    """PyInstaller でバンドルされた実行ファイルから起動されているか。"""
    return getattr(sys, "frozen", False)


def app_base_dir() -> Path:
    """アプリの基準フォルダ (データを置く場所の親)。

    - frozen 時: 実行ファイル (`PdfToSvg.exe`) のあるフォルダ
      (onedir はそこに、onefile でも展開先 temp ではなく永続フォルダになる)
    - ソース実行時: リポジトリ直下
    """
    if is_frozen():
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parents[1]


def resource_dir() -> Path:
    """同梱リソース (icons / fonts 等) のルート。

    - frozen 時: ``sys._MEIPASS/resources`` (spec の datas が ``resources`` 配下へ展開)
    - ソース実行時: リポジトリ直下の ``resources/``
    """
    if is_frozen():
        return Path(getattr(sys, "_MEIPASS")) / "resources"
    return Path(__file__).resolve().parents[1] / "resources"


def resource_path(*parts: str) -> Path:
    return resource_dir().joinpath(*parts)


def font_dir() -> Path:
    """同梱フォントのルート (本プロジェクト配下の ``fonts/``)。

    BIZ UDPGothic (TTF) / Noto Serif JP を pdf-to-svg 専用に同梱する置き場
    (graph2 は同ファミリの WOFF2 を自プロジェクト配下に別途持つ)。
    - frozen 時: ``_MEIPASS/fonts`` (spec の datas が ``fonts`` 配下へ展開)
    - ソース実行時: リポジトリ root (pdf-to-svg/) の ``fonts/``
    """
    if is_frozen():
        return Path(getattr(sys, "_MEIPASS")) / "fonts"
    return Path(__file__).resolve().parents[1] / "fonts"


def font_path(*parts: str) -> Path:
    return font_dir().joinpath(*parts)


def data_dir() -> Path:
    """辞書・設定を置くフォルダ (exe と同じ場所の ``data/``、ポータブル)。"""
    d = app_base_dir() / "data"
    d.mkdir(parents=True, exist_ok=True)
    return d


def dictionary_json_path() -> Path:
    return data_dir() / "dictionary.json"


def settings_path() -> Path:
    return data_dir() / "settings.json"


def load_settings() -> dict:
    p = settings_path()
    if p.exists():
        try:
            return json.loads(p.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return {}
    return {}


def save_settings(settings: dict) -> None:
    settings_path().write_text(
        json.dumps(settings, ensure_ascii=False, indent=2), encoding="utf-8"
    )
