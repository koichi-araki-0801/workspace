import os
from pathlib import Path

import fitz
import pytest

# GUI を伴うテストはオフスクリーンで実行
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

FIXTURES = Path(__file__).parent / "fixtures"


@pytest.fixture(scope="session")
def vector_pdf() -> Path:
    FIXTURES.mkdir(exist_ok=True)
    path = FIXTURES / "vector_sample.pdf"
    doc = fitz.open()
    page = doc.new_page(width=300, height=200)
    page.insert_text((50, 50), "Header A", fontsize=14, color=(0, 0, 0))
    page.insert_text((50, 80), "Value 123", fontsize=11, color=(0.2, 0.2, 0.8))
    page.draw_line((40, 100), (260, 100), color=(0, 0, 0), width=1.5)
    page.draw_rect(fitz.Rect(40, 120, 260, 170), color=(0, 0, 0), fill=(0.9, 0.9, 0.9), width=1)
    doc.save(str(path))
    doc.close()
    return path


@pytest.fixture(scope="session")
def scanned_pdf() -> Path:
    """テキストを持たず、ページ全面を画像が覆う擬似スキャン PDF。"""
    FIXTURES.mkdir(exist_ok=True)
    path = FIXTURES / "scanned_sample.pdf"

    # 画像を生成 (別ドキュメントをラスタ化)
    tmp = fitz.open()
    tp = tmp.new_page(width=200, height=200)
    tp.insert_text((30, 60), "SCANNED", fontsize=20)
    pix = tp.get_pixmap(matrix=fitz.Matrix(2, 2))
    img_bytes = pix.tobytes("png")
    tmp.close()

    doc = fitz.open()
    page = doc.new_page(width=200, height=200)
    page.insert_image(fitz.Rect(0, 0, 200, 200), stream=img_bytes)
    doc.save(str(path))
    doc.close()
    return path
