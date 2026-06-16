"""スキャン判定・背景画像の SVG 埋め込み (OCR は廃止)。"""
from engine.pdf_engine import load_document
from export.svg_exporter import page_to_svg


def test_scanned_page_detected(scanned_pdf):
    doc = load_document(str(scanned_pdf))
    pg = doc.pages[0]
    assert pg.is_scanned
    assert pg.background is not None
    assert pg.background.png_bytes


def test_scanned_svg_has_image(scanned_pdf):
    doc = load_document(str(scanned_pdf))
    svg = page_to_svg(doc.pages[0])
    assert "<image" in svg and "data:image/png;base64," in svg
