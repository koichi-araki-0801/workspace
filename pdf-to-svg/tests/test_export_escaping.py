"""SVG 出力の属性エスケープと色の許可リスト (P004) の退行ガード。

以前は同じファイルの中で ``PathElement.d`` は ``quoteattr``、テキストは ``escape`` を
通っているのに**色だけ**が素の f-string で、``rpc_addBorder`` の ``color`` へ
``#000"/><script>alert(1)</script><rect stroke="#000`` を渡すと注入が成立した。
書き出した SVG は社内回覧される成果物なので、守るべきは表示面ではなく生成点である。

「迂回入力で失敗すること」を主張する形で書く。
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from export.svg_exporter import page_to_svg
from model.document import Page
from model.elements import (
    LineElement,
    Rect,
    RectElement,
    TextElement,
    sanitize_color,
)

# 実測された PoC。属性を閉じて要素を差し込む形。
BREAKOUT = '#000"/><script>alert(document.domain)</script><rect stroke="#000'


def _page(*elements) -> Page:
    pg = Page(index=0, width_pt=300, height_pt=200)
    for i, el in enumerate(elements):
        el.z = i
        pg.elements.append(el)
    return pg


def test_sanitize_color_accepts_only_the_allowlist():
    for ok in ("#fff", "#ffff", "#112233", "#11223344", "rebeccapurple", "none", "currentColor"):
        assert sanitize_color(ok) == ok
    assert sanitize_color(None) is None
    # rgb()/hsl() は CSS 経路で宣言を増やせ、url() は外部参照と javascript: の入口。
    for bad in (BREAKOUT, "rgb(0,0,0)", "hsl(0,0%,0%)", "url(#x)", "javascript:alert(1)", 1):
        with pytest.raises(ValueError):
            sanitize_color(bad)


def test_rect_stroke_breakout_is_rejected_at_the_exporter():
    """入口 (rpc) を迂回してモデルへ直接入れても、出口の ``_paint`` が止める。"""
    rect = Rect(x=10, y=10, w=50, h=20)
    pg = _page(RectElement(bbox=rect, z=0, rect=rect, stroke=BREAKOUT, fill=None, stroke_width=1))
    with pytest.raises(ValueError):
        page_to_svg(pg)


def test_line_and_text_colors_are_guarded_too():
    line = LineElement(
        bbox=Rect(x=0, y=0, w=10, h=1), z=0, x0=0, y0=0, x1=10, y1=0, color=BREAKOUT, width=1
    )
    with pytest.raises(ValueError):
        page_to_svg(_page(line))

    text = TextElement(
        bbox=Rect(x=0, y=0, w=40, h=10),
        z=0,
        text="x",
        font_family="Helvetica",
        font_size=10,
        color=BREAKOUT,
    )
    with pytest.raises(ValueError):
        page_to_svg(_page(text))


def test_text_content_is_escaped_not_dropped():
    """テキストは注入されないが、消えてもいけない (欠測との取り違えを防ぐ)。"""
    text = TextElement(
        bbox=Rect(x=0, y=0, w=40, h=10),
        z=0,
        text='a"><script>alert(1)</script>',
        font_family="Helvetica",
        font_size=10,
        color="#000000",
    )
    svg = page_to_svg(_page(text))
    assert "<script" not in svg
    assert "&lt;script&gt;" in svg


def test_no_attribute_is_built_with_a_raw_f_string():
    """構造で守っていることの機械検証。

    列挙 (「この属性もエスケープする」) は必ず漏れる。属性を書く手段を ``_attr`` 1 つに
    絞ったので、漏れは「f-string で ``name="{...}"`` と組んでいる箇所」として検出できる。
    """
    src = Path(__file__).resolve().parents[1] / "src" / "export" / "svg_exporter.py"
    text = src.read_text(encoding="utf-8")
    offenders = re.findall(r'=\\"\{[^}]*\}', text) + re.findall(r'=\"\{[^}]*\}', text)
    assert offenders == [], f"f-string で属性を組んでいる箇所が残っている: {offenders}"
