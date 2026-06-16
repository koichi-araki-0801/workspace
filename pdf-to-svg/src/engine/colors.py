"""色変換ヘルパ。

PyMuPDF は span 色を sRGB 整数、drawings 色を 0..1 の float タプルで返す。
SVG 用の "#rrggbb" 文字列に統一する。
"""
from __future__ import annotations

from typing import Optional, Sequence


def int_to_hex(c: int) -> str:
    r = (c >> 16) & 0xFF
    g = (c >> 8) & 0xFF
    b = c & 0xFF
    return f"#{r:02x}{g:02x}{b:02x}"


def rgbf_to_hex(t: Optional[Sequence[float]]) -> Optional[str]:
    if t is None:
        return None
    vals = [max(0, min(255, round(x * 255))) for x in t[:3]]
    return "#{:02x}{:02x}{:02x}".format(*vals)
