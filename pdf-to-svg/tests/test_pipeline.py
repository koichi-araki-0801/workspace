"""抽出 → 辞書適用 → クロップ → SVG 書き出しのエンドツーエンド。"""
import xml.etree.ElementTree as ET

from dictionary import apply as dict_apply
from dictionary.store import DictionaryStore
from engine.pdf_engine import load_document
from export.svg_exporter import page_to_svg
from model.elements import Rect, TextElement


def test_extract_kinds(vector_pdf):
    doc = load_document(str(vector_pdf))
    pg = doc.pages[0]
    kinds = {e.kind for e in pg.elements}
    assert "text" in kinds and "line" in kinds and "rect" in kinds
    assert not pg.is_scanned


def test_svg_has_text_and_shapes(vector_pdf):
    doc = load_document(str(vector_pdf))
    svg = page_to_svg(doc.pages[0])
    assert "<text" in svg and "Header A" in svg
    assert "<line" in svg and "<rect" in svg
    assert 'viewBox="0 0 300 200"' in svg


def test_paint_order_text_above_banner(banner_pdf):
    """塗り矩形 → 白文字の順で描かれた PDF では、文字が矩形より上に来る。"""
    doc = load_document(str(banner_pdf))
    pg = doc.pages[0]
    text = next(e for e in pg.elements if isinstance(e, TextElement))
    rect = next(e for e in pg.elements if e.kind == "rect")
    assert text.z > rect.z
    svg = page_to_svg(pg)
    assert svg.index("<rect") < svg.index("WHITE TITLE")


def test_crop_drops_outside(vector_pdf):
    doc = load_document(str(vector_pdf))
    pg = doc.pages[0]
    pg.crop_rect = Rect(0, 0, 300, 60)  # 上端のみ残す
    svg = page_to_svg(pg)
    assert "Header A" in svg          # y=50 は残る
    assert "Value 123" not in svg     # y=80 は外れる
    assert 'viewBox="0 0 300 60"' in svg


def test_deleted_element_excluded(vector_pdf):
    doc = load_document(str(vector_pdf))
    pg = doc.pages[0]
    for e in pg.elements:
        if isinstance(e, TextElement) and e.text == "Value 123":
            e.deleted = True
    svg = page_to_svg(pg)
    assert "Value 123" not in svg
    assert "Header A" in svg


def test_dictionary_auto_apply_on_header(vector_pdf, tmp_path):
    doc = load_document(str(vector_pdf))
    pg = doc.pages[0]
    store = DictionaryStore(tmp_path / "d.json")
    store.add("Header A", "見出し A")
    n = dict_apply.auto_apply(pg, store, only_headers=True)
    assert n == 1
    svg = page_to_svg(pg)
    assert "見出し A" in svg
    assert "Header A" not in svg
    store.close()


def test_svg_font_mapped_to_windows_name(vector_pdf):
    """conftest の insert_text は Helvetica → Arial へマッピングされて出力される。"""
    doc = load_document(str(vector_pdf))
    pg = doc.pages[0]
    assert all(e.font_family == "Arial" for e in pg.elements if isinstance(e, TextElement))
    svg = page_to_svg(pg)
    assert "Arial" in svg
    assert "Helvetica" not in svg
    # Windows 標準フォントのみなら @font-face 埋め込みは発生しない
    assert "@font-face" not in svg


def test_svg_textlength_on_unedited_text(vector_pdf):
    """未編集テキストには元 PDF の幅に合わせる textLength が付く。"""
    doc = load_document(str(vector_pdf))
    svg = page_to_svg(doc.pages[0])
    assert "textLength=" in svg
    assert 'lengthAdjust="spacingAndGlyphs"' in svg


def test_svg_strips_xml_invalid_control_chars(vector_pdf):
    """壊れた ToUnicode CMap 由来の制御文字 (0x01 等) が SVG を壊さない。"""
    doc = load_document(str(vector_pdf))
    pg = doc.pages[0]
    el = next(e for e in pg.elements if isinstance(e, TextElement))
    el.text = "\x01以下本書\x08において"
    svg = page_to_svg(pg)
    assert "\x01" not in svg and "\x08" not in svg
    assert "以下本書において" in svg
    ET.fromstring(svg)  # 不正な XML なら ParseError


def test_svg_embeds_bundled_font_for_japanese(vector_pdf, tmp_path):
    """辞書置換で和文になったテキストは BIZ UD をサブセット埋め込みする。"""
    doc = load_document(str(vector_pdf))
    pg = doc.pages[0]
    store = DictionaryStore(tmp_path / "d.json")
    store.add("Header A", "見出し A")
    dict_apply.auto_apply(pg, store, only_headers=True)
    store.close()
    svg = page_to_svg(pg)
    assert "@font-face" in svg
    assert "BIZ UDGothic" in svg
    assert "data:font/woff2;base64," in svg
    # 置換済みテキストは本来の幅が不明なため textLength を付けない
    line = next(ln for ln in svg.splitlines() if "見出し A" in ln)
    assert "textLength" not in line
    # サブセット化により SVG が肥大しない (フォント全体 ~5MB に対し数十 KB)
    assert len(svg) < 200_000
