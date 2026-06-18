"""中間モデル (Page) を SVG 文字列へ直接シリアライズする。

scene は編集 UI、モデルが真実。書き出しはモデルから直接行うことで決定的になり、
GUI なしでテスト可能・フォント名の崩れも起きない。
"""
from __future__ import annotations

import base64
from typing import List
from xml.sax.saxutils import escape, quoteattr

from export import font_embed
from model import fonts
from model.document import Page
from model.elements import (
    ImageElement,
    LineElement,
    PathElement,
    Rect,
    RectElement,
    TextElement,
    sanitize_text,
)


def _fmt(v: float) -> str:
    return f"{v:.3f}".rstrip("0").rstrip(".")


def _mime(ext: str) -> str:
    ext = ext.lower()
    if ext in ("jpg", "jpeg"):
        return "image/jpeg"
    return f"image/{ext}"


def page_to_svg(page: Page, *, annotate: bool = False) -> str:
    """Page を SVG 文字列へ。

    annotate=True のとき各要素タグに ``data-el="<id>"`` を付与する (Web UI が
    要素をクリック選択・ハイライトするため)。デフォルト False で従来出力と完全一致
    (テスト・書き出しは不変)。
    """
    rect = page.export_rect()
    lines: List[str] = []
    lines.append('<?xml version="1.0" encoding="UTF-8"?>')
    lines.append(
        f'<svg xmlns="http://www.w3.org/2000/svg" '
        f'xmlns:xlink="http://www.w3.org/1999/xlink" '
        f'width="{_fmt(rect.w)}" height="{_fmt(rect.h)}" '
        f'viewBox="{_fmt(rect.x)} {_fmt(rect.y)} {_fmt(rect.w)} {_fmt(rect.h)}">'
    )

    # スキャン背景
    if page.background is not None:
        b = page.background
        if _intersects_export(b.rect, rect):
            lines.append(_image_tag(b.rect, b.png_bytes, "png"))

    text_els: List[TextElement] = []
    for el in page.live_elements():
        if not _intersects_export(el.bbox, rect):
            continue
        svg = _element_to_svg(el)
        if svg:
            if annotate:
                svg = _with_data_el(svg, el.id)
            lines.append(svg)
            if isinstance(el, TextElement):
                text_els.append(el)

    # 同梱フォント (BIZ UD) を使う場合のみサブセット WOFF2 を埋め込む
    css = font_embed.font_face_css(text_els)
    if css:
        lines.insert(2, f"<style>{css}</style>")

    lines.append("</svg>")
    return "\n".join(lines)


def _with_data_el(svg: str, el_id: int) -> str:
    """単一要素タグの開きタグ直後に data-el 属性を差し込む。"""
    # 先頭は必ず "<tagname" なので、最初の空白の位置に属性を挿入する。
    sp = svg.find(" ")
    if sp < 0:
        return svg
    return f'{svg[:sp]} data-el="{el_id}"{svg[sp:]}'


def _intersects_export(bbox: Rect, export: Rect) -> bool:
    # 幅・高さが 0 の要素 (細い罫線等) も拾えるよう緩めに交差判定
    if bbox.w == 0 and bbox.h == 0:
        return export.x <= bbox.x <= export.x1 and export.y <= bbox.y <= export.y1
    return bbox.intersects(export)


def _element_to_svg(el) -> str:
    if isinstance(el, TextElement):
        return _text_to_svg(el)
    if isinstance(el, LineElement):
        return (
            f'<line x1="{_fmt(el.x0)}" y1="{_fmt(el.y0)}" '
            f'x2="{_fmt(el.x1)}" y2="{_fmt(el.y1)}" '
            f'stroke="{el.color}" stroke-width="{_fmt(el.width)}"/>'
        )
    if isinstance(el, RectElement):
        return (
            f'<rect x="{_fmt(el.rect.x)}" y="{_fmt(el.rect.y)}" '
            f'width="{_fmt(el.rect.w)}" height="{_fmt(el.rect.h)}" '
            f'{_paint("fill", el.fill)} {_paint("stroke", el.stroke)} '
            f'stroke-width="{_fmt(el.stroke_width)}"/>'
        )
    if isinstance(el, PathElement):
        return (
            f'<path d={quoteattr(el.d)} '
            f'{_paint("fill", el.fill)} {_paint("stroke", el.stroke)} '
            f'stroke-width="{_fmt(el.stroke_width)}"/>'
        )
    if isinstance(el, ImageElement):
        return _image_tag(el.rect, el.img_bytes, el.ext)
    return ""


def _paint(attr: str, color) -> str:
    return f'{attr}="{color}"' if color else f'{attr}="none"'


def _text_to_svg(el: TextElement) -> str:
    # 代替フォントでも崩れないよう和文補完 + 汎用名のフォールバックチェーンを付与
    family = fonts.fallback_css(el.font_family, el.text)
    weight = f' font-weight="{el.weight}"' if el.weight != 400 else ""
    style = ' font-style="italic"' if el.italic else ""
    # 未編集テキストは元 PDF 上の幅 (bbox.w) に合わせて伸縮し、代替フォントの
    # 字幅差によるはみ出し・重なりを防ぐ。編集済みは本来の幅が不明なため自然幅。
    stretch = ""
    if el.text == el.original_text and el.bbox.w > 0:
        stretch = f' textLength="{_fmt(el.bbox.w)}" lengthAdjust="spacingAndGlyphs"'
    return (
        f'<text x="{_fmt(el.origin_x)}" y="{_fmt(el.origin_y)}" '
        f'font-family={quoteattr(family)} font-size="{_fmt(el.font_size)}" '
        f'fill="{el.color}"{weight}{style}{stretch}>{escape(sanitize_text(el.text))}</text>'
    )


def _image_tag(rect: Rect, data: bytes, ext: str) -> str:
    b64 = base64.b64encode(data).decode("ascii")
    href = f"data:{_mime(ext)};base64,{b64}"
    return (
        f'<image x="{_fmt(rect.x)}" y="{_fmt(rect.y)}" '
        f'width="{_fmt(rect.w)}" height="{_fmt(rect.h)}" '
        f'xlink:href={quoteattr(href)}/>'
    )
