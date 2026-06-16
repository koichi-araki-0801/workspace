"""Document / Page コンテナ。"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import List, Optional

from .elements import Element, Rect


@dataclass
class RasterBackground:
    """スキャンページ等のラスタ背景。"""

    png_bytes: bytes
    rect: Rect


@dataclass
class Page:
    index: int
    width_pt: float
    height_pt: float
    rotation: int = 0
    is_scanned: bool = False
    background: Optional[RasterBackground] = None
    elements: List[Element] = field(default_factory=list)
    crop_rect: Optional[Rect] = None

    def live_elements(self) -> List[Element]:
        """削除されていない・可視の要素 (z 昇順)。"""
        items = [e for e in self.elements if not e.deleted and e.visible]
        return sorted(items, key=lambda e: e.z)

    def export_rect(self) -> Rect:
        """書き出し領域 (クロップがあればそれ、無ければページ全体)。"""
        if self.crop_rect is not None:
            return self.crop_rect
        return Rect(0, 0, self.width_pt, self.height_pt)


@dataclass
class Document:
    source_path: str
    pages: List[Page] = field(default_factory=list)

    @property
    def page_count(self) -> int:
        return len(self.pages)
