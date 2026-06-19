"""折返し (複数行に分割された) ヘッダセルを 1 語として辞書照合する。"""
from dictionary import apply as dict_apply
from dictionary.store import DictionaryStore
from model.document import Page
from model.elements import Rect, TextElement


def _text(s, x, oy, size=12.0):
    """origin (x, oy)・幅 20pt の TextElement を作る。bbox は列判定用。"""
    return TextElement(
        bbox=Rect(x, oy - size, 20.0, size),
        text=s,
        font_size=size,
        origin_x=x,
        origin_y=oy,
    )


def _page(elements):
    pg = Page(index=0, width_pt=300.0, height_pt=200.0)
    pg.elements.extend(elements)
    return pg


def test_wrapped_header_joined_no_separator(tmp_path):
    """和文「商品」+「名称」(縦 2 行) を連結して "商品名称" で照合する。"""
    top = _text("商品", x=50, oy=40)
    bottom = _text("名称", x=50, oy=52)  # 直下・同列・同サイズ
    pg = _page([top, bottom])
    store = DictionaryStore(tmp_path / "d.json")
    store.add("商品名称", "Product")

    n = dict_apply.auto_apply(pg, store, only_headers=True)

    assert n == 1
    assert top.text == "Product"
    assert top.dict_match is not None and top.dict_match.source == "商品名称"
    assert bottom.deleted is True  # 2 行目は描画から除外
    # 畳み込み後、先頭要素はグループ全体の合成領域へ据え直される (縦の上詰まり防止)。
    # top bbox=(50,28,20,12) / bottom bbox=(50,40,20,12) → 合成 (50,28,20,24)。
    assert (top.bbox.x, top.bbox.y, top.bbox.w, top.bbox.h) == (50.0, 28.0, 20.0, 24.0)
    store.close()


def test_wrapped_header_joined_with_space(tmp_path):
    """欧文「Product」+「Name」は空白連結 "Product Name" で照合する。"""
    top = _text("Product", x=50, oy=40)
    bottom = _text("Name", x=50, oy=52)
    pg = _page([top, bottom])
    store = DictionaryStore(tmp_path / "d.json")
    store.add("Product Name", "製品名")

    plans = dict_apply.plan_replacements(_detect(pg), store)

    assert len(plans) == 1
    rep = plans[0]
    assert rep.element is top and rep.target == "製品名"
    assert rep.extras == [bottom]
    # 折返しは合成領域 new_bbox を持つ (SVG 出力で縦横中央へ据え直す)。
    assert rep.new_bbox is not None
    assert (rep.new_bbox.x, rep.new_bbox.y, rep.new_bbox.w, rep.new_bbox.h) == (50.0, 28.0, 20.0, 24.0)
    store.close()


def test_single_line_header_still_matches(tmp_path):
    """単独行ヘッダは従来どおり要素単位で照合される (折返し化の回帰防止)。"""
    head = _text("Qty", x=50, oy=40)
    pg = _page([head])
    store = DictionaryStore(tmp_path / "d.json")
    store.add("Qty", "数量")

    n = dict_apply.auto_apply(pg, store, only_headers=True)

    assert n == 1
    assert head.text == "数量"
    store.close()


def test_non_header_stack_not_joined(tmp_path):
    """ヘッダでない本文の縦並びは連結照合しない。"""
    # top band (200*0.25=50) より下に置き、太字でもないのでヘッダにならない
    a = _text("商品", x=50, oy=120)
    b = _text("名称", x=50, oy=132)
    pg = _page([a, b])
    store = DictionaryStore(tmp_path / "d.json")
    store.add("商品名称", "Product")

    n = dict_apply.auto_apply(pg, store, only_headers=True)

    assert n == 0
    assert a.text == "商品" and not b.deleted
    store.close()


def _detect(pg):
    dict_apply.detect_headers(pg)
    return pg
