"""PyMuPDF を用いて PDF を中間ドキュメントモデルへ抽出する。

ライセンス注意: PyMuPDF は AGPL。社内配布前提のため採用しているが、外部配布が
必要になった場合はこのモジュールだけを BSD エンジン (pypdfium2) 等へ差し替える。
"""
from __future__ import annotations

from typing import List, Optional

import fitz  # PyMuPDF

from model.document import Document, Page, RasterBackground
from model.elements import (
    Element,
    ImageElement,
    LineElement,
    PathElement,
    Rect,
    RectElement,
    TextElement,
)
from engine import classify
from engine.colors import int_to_hex, rgbf_to_hex

# span flags ビット
FLAG_ITALIC = 1 << 1
FLAG_BOLD = 1 << 4

SCAN_RENDER_SCALE = 2.0  # スキャンページのラスタ化倍率


def _fmt(v: float) -> str:
    return f"{v:.3f}".rstrip("0").rstrip(".")


def _pt(p) -> str:
    return f"{_fmt(p.x)},{_fmt(p.y)}"


def load_document(path: str) -> Document:
    """PDF を開き Document を構築する。"""
    doc = Document(source_path=path)
    with fitz.open(path) as pdf:
        for i, page in enumerate(pdf):
            doc.pages.append(_extract_page(page, i))
    return doc


def _extract_page(page: "fitz.Page", index: int) -> Page:
    rect = page.rect
    scanned = classify.is_scanned_page(page)
    p = Page(
        index=index,
        width_pt=rect.width,
        height_pt=rect.height,
        rotation=page.rotation,
        is_scanned=scanned,
    )

    if scanned:
        p.background = _render_background(page)
        return p

    z = 0
    text_dict = page.get_text("dict")
    for block in text_dict.get("blocks", []):
        if block.get("type") == 1:  # 画像ブロック
            img = _image_element(block, z)
            if img is not None:
                p.elements.append(img)
                z += 1
        else:  # テキストブロック
            for line in block.get("lines", []):
                for span in line.get("spans", []):
                    el = _text_element(span, z)
                    if el is not None:
                        p.elements.append(el)
                        z += 1

    for drawing in page.get_drawings():
        for el in _drawing_elements(drawing, z):
            p.elements.append(el)
            z += 1

    return p


def _render_background(page: "fitz.Page") -> RasterBackground:
    mat = fitz.Matrix(SCAN_RENDER_SCALE, SCAN_RENDER_SCALE)
    pix = page.get_pixmap(matrix=mat, alpha=False)
    png = pix.tobytes("png")
    r = page.rect
    return RasterBackground(png_bytes=png, rect=Rect(0, 0, r.width, r.height))


def _text_element(span: dict, z: int) -> Optional[TextElement]:
    text = span.get("text", "")
    if text == "" or text.isspace():
        return None
    bbox = span["bbox"]
    origin = span.get("origin", (bbox[0], bbox[3]))
    flags = span.get("flags", 0)
    return TextElement(
        bbox=Rect.from_xyxy(*bbox),
        z=z,
        text=text,
        font_family=_clean_font(span.get("font", "sans-serif")),
        font_size=float(span.get("size", 12.0)),
        bold=bool(flags & FLAG_BOLD),
        italic=bool(flags & FLAG_ITALIC),
        color=int_to_hex(span.get("color", 0)),
        origin_x=origin[0],
        origin_y=origin[1],
    )


def _clean_font(font: str) -> str:
    """埋め込みフォント名 ("ABCDEF+NotoSansJP") からサブセット接頭辞を除去。"""
    if "+" in font and len(font.split("+", 1)[0]) == 6:
        font = font.split("+", 1)[1]
    return font


def _image_element(block: dict, z: int) -> Optional[ImageElement]:
    data = block.get("image")
    if not data:
        return None
    bbox = block["bbox"]
    return ImageElement(
        bbox=Rect.from_xyxy(*bbox),
        z=z,
        rect=Rect.from_xyxy(*bbox),
        img_bytes=data,
        ext=block.get("ext", "png"),
    )


def _drawing_elements(drawing: dict, z: int) -> List[Element]:
    dtype = drawing.get("type", "s")  # "s" stroke / "f" fill / "fs" both
    stroke = rgbf_to_hex(drawing.get("color")) if dtype in ("s", "fs") else None
    fill = rgbf_to_hex(drawing.get("fill")) if dtype in ("f", "fs") else None
    width = float(drawing.get("width", 1.0) or 1.0)
    items = drawing.get("items", [])
    rect_b = drawing.get("rect")
    bbox = Rect.from_xyxy(rect_b.x0, rect_b.y0, rect_b.x1, rect_b.y1) if rect_b else Rect(0, 0, 0, 0)

    # 単純形状は専用要素に (選択・編集しやすい)
    if len(items) == 1:
        it = items[0]
        if it[0] == "l":
            p0, p1 = it[1], it[2]
            return [
                LineElement(
                    bbox=bbox, z=z, x0=p0.x, y0=p0.y, x1=p1.x, y1=p1.y,
                    width=width, color=stroke or "#000000",
                )
            ]
        if it[0] == "re":
            r = it[1]
            return [
                RectElement(
                    bbox=bbox, z=z,
                    rect=Rect.from_xyxy(r.x0, r.y0, r.x1, r.y1),
                    stroke=stroke, fill=fill, stroke_width=width,
                )
            ]

    d = _items_to_path_d(items, bool(drawing.get("closePath")))
    if not d:
        return []
    return [
        PathElement(
            bbox=bbox, z=z, d=d, stroke=stroke, fill=fill, stroke_width=width,
        )
    ]


def _items_to_path_d(items: list, close: bool) -> str:
    parts: List[str] = []
    last = None

    def moveto(p):
        nonlocal last
        parts.append(f"M{_pt(p)}")
        last = p

    for it in items:
        op = it[0]
        if op == "l":
            p0, p1 = it[1], it[2]
            if last is None or (last.x, last.y) != (p0.x, p0.y):
                moveto(p0)
            parts.append(f"L{_pt(p1)}")
            last = p1
        elif op == "c":
            p0, c1, c2, p1 = it[1], it[2], it[3], it[4]
            if last is None or (last.x, last.y) != (p0.x, p0.y):
                moveto(p0)
            parts.append(f"C{_pt(c1)} {_pt(c2)} {_pt(p1)}")
            last = p1
        elif op == "re":
            r = it[1]
            parts.append(
                f"M{_fmt(r.x0)},{_fmt(r.y0)}"
                f"H{_fmt(r.x1)}V{_fmt(r.y1)}H{_fmt(r.x0)}Z"
            )
            last = None
        elif op == "qu":
            q = it[1]
            parts.append(
                f"M{_pt(q.ul)}L{_pt(q.ur)}L{_pt(q.lr)}L{_pt(q.ll)}Z"
            )
            last = None

    d = " ".join(parts)
    if close and d:
        d += " Z"
    return d
