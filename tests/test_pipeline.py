"""抽出 → 辞書適用 → クロップ → SVG 書き出しのエンドツーエンド。"""
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
