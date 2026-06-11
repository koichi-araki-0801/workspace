"""モデル要素 → QGraphicsItem 生成。

各 item は ``setData(0, element.id)`` で対応する要素 ID を保持し、scene 側で
モデルと突き合わせられるようにする。表示はベクターのまま行う。
"""
from __future__ import annotations

from PySide6.QtCore import QByteArray, QPointF, QRectF, Qt
from PySide6.QtGui import (
    QBrush,
    QColor,
    QFont,
    QFontMetricsF,
    QPainterPath,
    QPen,
    QPixmap,
    QTransform,
)
from PySide6.QtWidgets import (
    QGraphicsItem,
    QGraphicsLineItem,
    QGraphicsPathItem,
    QGraphicsPixmapItem,
    QGraphicsRectItem,
    QGraphicsSimpleTextItem,
)

from model import fonts
from model.elements import (
    Element,
    ImageElement,
    LineElement,
    PathElement,
    RectElement,
    TextElement,
)

# エディタ表示の幅調整パラメータ (SVG の textLength 相当)
_STRETCH_TOLERANCE = 0.02  # この比率以内の差は誤差としてスケールしない
_STRETCH_MIN, _STRETCH_MAX = 0.5, 2.0  # 異常なメトリクスからの保護

ELEMENT_ID_KEY = 0


def _color(value, default=Qt.black) -> QColor:
    if not value:
        return QColor(default)
    return QColor(value)


def make_item(el: Element) -> QGraphicsItem | None:
    if isinstance(el, TextElement):
        item = _text_item(el)
    elif isinstance(el, LineElement):
        item = QGraphicsLineItem(el.x0, el.y0, el.x1, el.y1)
        item.setPen(QPen(_color(el.color), el.width))
    elif isinstance(el, RectElement):
        item = QGraphicsRectItem(el.rect.x, el.rect.y, el.rect.w, el.rect.h)
        item.setPen(QPen(_color(el.stroke), el.stroke_width) if el.stroke else QPen(Qt.NoPen))
        item.setBrush(QBrush(_color(el.fill)) if el.fill else QBrush(Qt.NoBrush))
    elif isinstance(el, PathElement):
        item = QGraphicsPathItem(parse_path_d(el.d))
        item.setPen(QPen(_color(el.stroke), el.stroke_width) if el.stroke else QPen(Qt.NoPen))
        item.setBrush(QBrush(_color(el.fill)) if el.fill else QBrush(Qt.NoBrush))
    elif isinstance(el, ImageElement):
        item = _image_item(el)
    else:
        return None

    if item is None:
        return None
    item.setData(ELEMENT_ID_KEY, el.id)
    item.setZValue(el.z)
    item.setFlag(QGraphicsItem.ItemIsSelectable, True)
    return item


def _qt_weight(css_weight: int) -> "QFont.Weight":
    """CSS ウェイト (100-900) を最寄りの QFont.Weight へ対応付ける。"""
    table = [
        (100, QFont.Weight.Thin), (200, QFont.Weight.ExtraLight),
        (300, QFont.Weight.Light), (400, QFont.Weight.Normal),
        (500, QFont.Weight.Medium), (600, QFont.Weight.DemiBold),
        (700, QFont.Weight.Bold), (800, QFont.Weight.ExtraBold),
        (900, QFont.Weight.Black),
    ]
    return min(table, key=lambda t: abs(t[0] - css_weight))[1]


def _text_item(el: TextElement) -> QGraphicsSimpleTextItem:
    item = QGraphicsSimpleTextItem(el.text)
    font = QFont()
    # SVG 出力と同じフォールバックチェーンを Qt にも渡す (汎用名は Qt 非対応のため除外)
    font.setFamilies(
        [f for f in fonts.fallback_chain(el.font_family, el.text)
         if f not in ("serif", "sans-serif", "monospace")]
    )
    font.setPixelSize(max(1, round(el.font_size)))
    font.setWeight(_qt_weight(el.weight))
    font.setItalic(el.italic)
    item.setFont(font)
    item.setBrush(QBrush(_color(el.color)))
    # SVG はベースライン原点。SimpleText は上端原点なので ascent 分だけ上へ。
    metrics = QFontMetricsF(font)
    item.setPos(el.origin_x, el.origin_y - metrics.ascent())
    # 未編集テキストは元 PDF 上の幅 (bbox.w) に合わせて横方向のみ伸縮し、
    # 代替フォントの字幅差によるはみ出し・重なりを防ぐ (SVG の textLength と同じ見た目)。
    if el.text == el.original_text and el.bbox.w > 0:
        natural = metrics.horizontalAdvance(el.text)
        if natural > 0:
            sx = el.bbox.w / natural
            if abs(sx - 1.0) >= _STRETCH_TOLERANCE:
                sx = min(max(sx, _STRETCH_MIN), _STRETCH_MAX)
                item.setTransform(QTransform.fromScale(sx, 1.0))
    return item


def _image_item(el: ImageElement) -> QGraphicsPixmapItem | None:
    pix = QPixmap()
    if not pix.loadFromData(QByteArray(el.img_bytes)):
        return None
    item = QGraphicsPixmapItem(pix)
    item.setPos(el.rect.x, el.rect.y)
    if pix.width() and pix.height():
        item.setScale(min(el.rect.w / pix.width(), el.rect.h / pix.height()))
    return item


def make_background_item(png_bytes: bytes, rect) -> QGraphicsPixmapItem | None:
    pix = QPixmap()
    if not pix.loadFromData(QByteArray(png_bytes)):
        return None
    item = QGraphicsPixmapItem(pix)
    item.setPos(rect.x, rect.y)
    if pix.width() and pix.height():
        item.setScale(rect.w / pix.width())
    item.setZValue(-10000)  # 最背面
    return item


def parse_path_d(d: str) -> QPainterPath:
    """svg_exporter / pdf_engine が出力する d 文字列を QPainterPath に変換。

    対応コマンド: M L C H V Z (すべて絶対座標)。これ以外は emit していない。
    """
    path = QPainterPath()
    tokens = _tokenize(d)
    i = 0
    cur = QPointF(0, 0)
    start = QPointF(0, 0)
    n = len(tokens)
    while i < n:
        cmd = tokens[i]
        i += 1
        if cmd == "M":
            cur = QPointF(float(tokens[i]), float(tokens[i + 1]))
            path.moveTo(cur)
            start = QPointF(cur)
            i += 2
        elif cmd == "L":
            cur = QPointF(float(tokens[i]), float(tokens[i + 1]))
            path.lineTo(cur)
            i += 2
        elif cmd == "H":
            cur = QPointF(float(tokens[i]), cur.y())
            path.lineTo(cur)
            i += 1
        elif cmd == "V":
            cur = QPointF(cur.x(), float(tokens[i]))
            path.lineTo(cur)
            i += 1
        elif cmd == "C":
            c1 = QPointF(float(tokens[i]), float(tokens[i + 1]))
            c2 = QPointF(float(tokens[i + 2]), float(tokens[i + 3]))
            cur = QPointF(float(tokens[i + 4]), float(tokens[i + 5]))
            path.cubicTo(c1, c2, cur)
            i += 6
        elif cmd == "Z":
            path.closeSubpath()
            cur = QPointF(start)
    return path


def _tokenize(d: str) -> list[str]:
    out: list[str] = []
    num = ""
    for ch in d:
        if ch in "MLCHVZ":
            if num:
                out.append(num)
                num = ""
            out.append(ch)
        elif ch in " ,\n\t":
            if num:
                out.append(num)
                num = ""
        else:
            num += ch
    if num:
        out.append(num)
    return out
