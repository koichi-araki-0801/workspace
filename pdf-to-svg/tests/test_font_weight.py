"""フォントのウェイト粒度: マッピング・埋め込み・SVG 出力の検証。"""
from export.svg_exporter import page_to_svg
from export import font_embed
from model import fonts
from model.document import Page
from model.elements import Rect, TextElement


def _text(text, family, weight, x=10.0, y=20.0):
    return TextElement(
        bbox=Rect(x, y - 10, 80, 12), z=1, text=text, original_text=text,
        font_family=family, original_font=family, font_size=10.0,
        weight=weight, bold=weight >= 600, origin_x=x, origin_y=y,
    )


def test_weight_helpers():
    assert fonts.is_variable_family("Noto Serif JP")
    assert not fonts.is_variable_family("BIZ UDGothic")
    assert fonts.needs_embedding("BIZ UDGothic")
    assert fonts.needs_embedding("Noto Serif JP")
    # 静的ゴシックは 2 バケットへ丸め (1-599→400 / 600-1000→700)
    assert fonts.static_weight_bucket("BIZ UDGothic", 300) == 400
    assert fonts.static_weight_bucket("BIZ UDGothic", 500) == 400
    assert fonts.static_weight_bucket("BIZ UDGothic", 600) == 700
    assert fonts.static_weight_bucket("BIZ UDGothic", 700) == 700


def test_variable_mincho_embedded_once_for_all_weights():
    """明朝 (可変) は全ウェイトを 1 つの @font-face (font-weight:100 900) で埋め込む。"""
    els = [_text("細", "Noto Serif JP", 300), _text("並", "Noto Serif JP", 400),
           _text("太", "Noto Serif JP", 700)]
    css = font_embed.font_face_css(els)
    assert css.count("@font-face") == 1
    assert 'font-family:"Noto Serif JP"' in css
    assert "font-weight:100 900" in css
    assert "data:font/woff2;base64," in css


def test_static_gothic_embedded_per_bucket_with_ranges():
    """ゴシック (静的) は使用バケットごとに範囲指定 @font-face を出す。"""
    els = [_text("並", "BIZ UDGothic", 400), _text("中", "BIZ UDGothic", 500),
           _text("太", "BIZ UDGothic", 700)]
    css = font_embed.font_face_css(els)
    # 400/500 は Regular バケットへ集約、700 は Bold → 計 2 face
    assert css.count("@font-face") == 2
    assert "font-weight:1 599" in css
    assert "font-weight:600 1000" in css


def test_svg_emits_numeric_font_weight():
    page = Page(index=0, width_pt=200, height_pt=100)
    page.elements = [
        _text("ライト", "Noto Serif JP", 300, y=20),
        _text("レギュラー", "Noto Serif JP", 400, y=40),
        _text("ボールド", "BIZ UDGothic", 700, y=60),
    ]
    svg = page_to_svg(page)
    assert 'font-weight="300"' in svg
    assert 'font-weight="700"' in svg
    # weight 400 は既定なので属性を付けない (出力を簡潔に保つ)
    assert 'font-weight="400"' not in svg
