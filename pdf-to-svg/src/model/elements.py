"""ページを構成するプリミティブ要素。

座標系は PDF/SVG/Qt で共通の「左上原点・y 下向き・単位 pt」。
PyMuPDF から抽出したものをそのまま保持し、SVG 書き出し時もそのまま使える。
"""
from __future__ import annotations

import itertools
import re
from dataclasses import dataclass, field
from typing import Optional

# 要素 ID 採番 (プロセス内で一意であれば十分)
_id_counter = itertools.count(1)


def new_id() -> int:
    return next(_id_counter)


# XML 1.0 で許されない制御文字 (tab/LF/CR を除く C0 制御と DEL)
_XML_INVALID = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


def sanitize_text(text: str) -> str:
    """XML 1.0 で不正な制御文字を除去する (壊れた ToUnicode CMap 対策)。"""
    return _XML_INVALID.sub("", text)


@dataclass
class Rect:
    x: float
    y: float
    w: float
    h: float

    @property
    def x1(self) -> float:
        return self.x + self.w

    @property
    def y1(self) -> float:
        return self.y + self.h

    def intersects(self, other: "Rect") -> bool:
        return not (
            self.x1 <= other.x
            or other.x1 <= self.x
            or self.y1 <= other.y
            or other.y1 <= self.y
        )

    @classmethod
    def from_xyxy(cls, x0: float, y0: float, x1: float, y1: float) -> "Rect":
        return cls(x0, y0, x1 - x0, y1 - y0)


@dataclass
class DictMatch:
    """辞書による置換が当たったことを示す情報 (ハイライト/レビュー用)。"""

    source: str
    target: str


@dataclass
class Element:
    """全要素の基底。"""

    kind: str = "element"
    bbox: Rect = field(default_factory=lambda: Rect(0, 0, 0, 0))
    z: int = 0
    deleted: bool = False
    id: int = field(default_factory=new_id)


@dataclass
class TextElement(Element):
    kind: str = "text"
    text: str = ""
    original_text: str = ""  # 辞書置換前の値 (Undo / レビュー用)
    font_family: str = "sans-serif"
    font_size: float = 12.0
    weight: int = 400  # CSS フォントウェイト (100-900)。元 PDF のウェイトを保持
    italic: bool = False
    color: str = "#000000"
    origin_x: float = 0.0  # ベースライン原点 (SVG <text> の x)
    origin_y: float = 0.0  # ベースライン原点 (SVG <text> の y)
    is_header: bool = False
    dict_match: Optional[DictMatch] = None
    # 折返し畳み込み置換の水平揃え ("left"/"center"/"right")。None = 非連結の通常要素。
    # 設定時は SVG 出力が bbox (折返しグループの合成領域) の左/中央/右へ anchor し、
    # 縦は origin_y (最終行のベースラインへ据え直し済み) の下揃えで描く。
    wrap_align: Optional[str] = None

    def __post_init__(self) -> None:
        if not self.original_text:
            self.original_text = self.text

    @property
    def bold(self) -> bool:
        """太字相当か (weight>=600)。weight を単一ソースとする (辞書ヘッダ判定・エディタ表示の互換用)。"""
        return self.weight >= 600


@dataclass
class LineElement(Element):
    kind: str = "line"
    x0: float = 0.0
    y0: float = 0.0
    x1: float = 0.0
    y1: float = 0.0
    width: float = 1.0
    color: str = "#000000"


@dataclass
class RectElement(Element):
    kind: str = "rect"
    rect: Rect = field(default_factory=lambda: Rect(0, 0, 0, 0))
    stroke: Optional[str] = "#000000"
    fill: Optional[str] = None
    stroke_width: float = 1.0


@dataclass
class PathElement(Element):
    kind: str = "path"
    # SVG path の "d" 文字列。get_drawings の各 item を変換して格納。
    d: str = ""
    stroke: Optional[str] = "#000000"
    fill: Optional[str] = None
    stroke_width: float = 1.0


@dataclass
class ImageElement(Element):
    kind: str = "image"
    rect: Rect = field(default_factory=lambda: Rect(0, 0, 0, 0))
    # raw 画像バイト列を base64 で SVG に埋め込む。ext は "png"/"jpeg" 等。
    img_bytes: bytes = b""
    ext: str = "png"
