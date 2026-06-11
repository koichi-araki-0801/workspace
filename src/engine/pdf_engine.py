"""PyMuPDF を用いて PDF を中間ドキュメントモデルへ抽出する。

ライセンス注意: PyMuPDF は AGPL。社内配布前提のため採用しているが、外部配布が
必要になった場合はこのモジュールだけを BSD エンジン (pypdfium2) 等へ差し替える。
"""
from __future__ import annotations

from typing import List, Optional, Tuple

import fitz  # PyMuPDF

from model import fonts
from model.document import Document, Page, RasterBackground
from model.elements import (
    Element,
    ImageElement,
    LineElement,
    PathElement,
    Rect,
    RectElement,
    TextElement,
    sanitize_text,
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

    # z は PDF の実ペイント順 (コンテンツストリームの seqno) を復元して採番する。
    # get_text は読み順・get_drawings はパス順で返すため、抽出順のままだと
    # 「帯の塗り矩形が先・白文字が後」の前後関係が逆転し文字が矩形に隠れる。
    # z = seqno * _Z_TIER + 連番 (連番は同一 seqno 内・全体の安定順序用)。
    text_seqnos = [
        (s["seqno"], Rect.from_xyxy(*s["bbox"])) for s in page.get_texttrace()
    ]
    image_seqnos = [
        (i, Rect.from_xyxy(*r))
        for i, (kind, r) in enumerate(page.get_bboxlog())
        if kind in ("fill-image", "fill-shade")
    ]

    seq = 0
    prev_seqno = 0
    text_dict = page.get_text("dict")
    for block in text_dict.get("blocks", []):
        if block.get("type") == 1:  # 画像ブロック
            bbox = Rect.from_xyxy(*block["bbox"])
            # 照合失敗時は -1 (背景扱い): 画像は下敷きであることが大半
            seqno = _match_seqno(bbox, image_seqnos, -1)
            img = _image_element(block, seqno * _Z_TIER + seq)
            if img is not None:
                p.elements.append(img)
                seq += 1
        else:  # テキストブロック
            for line in block.get("lines", []):
                for span in line.get("spans", []):
                    bbox = Rect.from_xyxy(*span["bbox"])
                    seqno = _match_seqno(bbox, text_seqnos, prev_seqno)
                    el = _text_element(span, seqno * _Z_TIER + seq)
                    if el is not None:
                        prev_seqno = seqno
                        p.elements.append(el)
                        seq += 1

    for drawing in page.get_drawings():
        seqno = int(drawing.get("seqno") or 0)
        for el in _drawing_elements(drawing, seqno * _Z_TIER + seq):
            p.elements.append(el)
            seq += 1

    return p


# 1 ページ内の要素数を超える十分大きな tier 幅 (z = seqno * tier + 連番)
_Z_TIER = 1_000_000


def _overlap_area(a: Rect, b: Rect) -> float:
    w = min(a.x1, b.x1) - max(a.x, b.x)
    h = min(a.y1, b.y1) - max(a.y, b.y)
    return w * h if (w > 0 and h > 0) else 0.0


def _match_seqno(bbox: Rect, candidates: List[Tuple[int, Rect]], default: int) -> int:
    """bbox に最もフィットする候補の seqno を返す (IoU 最大、無ければ default)。

    重なり「面積」最大で照合すると、軸ラベル全体を 1 度の text-show で描いた
    巨大 span が、その内側の小さな凡例ラベル span を吸い込み、誤って早い描画順
    (seqno) を与えてしまう (→ 後から塗られる凡例ボックス背景に隠れて消える)。
    IoU (重なり / 和集合) なら巨大候補は和集合が大きく自然に弾かれ、最もフィット
    する狭い span が選ばれる。fill-shade のような無限大 bbox の候補も IoU≈0 で
    排除されるため、画像照合側の「無限 bbox 吸い込み」対策も兼ねる。
    """
    best = default
    best_iou = 0.0
    qa = bbox.w * bbox.h
    for seqno, r in candidates:
        ov = _overlap_area(bbox, r)
        if ov <= 0:
            continue
        iou = ov / (qa + r.w * r.h - ov)
        if iou > best_iou:
            best_iou = iou
            best = seqno
    return best


def _render_background(page: "fitz.Page") -> RasterBackground:
    mat = fitz.Matrix(SCAN_RENDER_SCALE, SCAN_RENDER_SCALE)
    pix = page.get_pixmap(matrix=mat, alpha=False)
    png = pix.tobytes("png")
    r = page.rect
    return RasterBackground(png_bytes=png, rect=Rect(0, 0, r.width, r.height))


def _text_element(span: dict, z: int) -> Optional[TextElement]:
    text = sanitize_text(span.get("text", ""))
    if text == "" or text.isspace():
        return None
    bbox = span["bbox"]
    origin = span.get("origin", (bbox[0], bbox[3]))
    flags = span.get("flags", 0)
    raw_font = _clean_font(span.get("font", "sans-serif"))
    mapped = fonts.map_font(raw_font, text)
    # ウェイトはフォント名由来 (Light/Regular/Medium/Bold) を尊重し、名前に重み指定が
    # 無く PyMuPDF の bold フラグだけ立つ場合に限り太字へ持ち上げる。
    weight = mapped.weight
    if (flags & FLAG_BOLD) and weight < 600:
        weight = 700
    return TextElement(
        bbox=Rect.from_xyxy(*bbox),
        z=z,
        text=text,
        font_family=mapped.family,
        original_font=raw_font,
        font_size=float(span.get("size", 12.0)),
        weight=weight,
        bold=weight >= 600,
        italic=bool(flags & FLAG_ITALIC) or mapped.italic,
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
