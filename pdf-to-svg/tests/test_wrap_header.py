"""折返し (複数行に分割された) ヘッダセルを 1 語として辞書照合する。

連結照合は連結由来 (`joined=True`) エントリのみに一致する: 連結取り込みで登録した
語だけが 2 行畳み込みの対象で、単独行で登録した語は偶然連結形と一致しても畳まない。
"""
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
    store.add("商品名称", "Product", joined=True)

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
    store.add("Product Name", "製品名", joined=True)

    plans = dict_apply.plan_replacements(_detect(pg), store)

    assert len(plans) == 1
    rep = plans[0]
    assert rep.element is top and rep.target == "製品名"
    assert rep.extras == [bottom]
    # 折返しは合成領域 new_bbox を持つ (SVG 出力で縦横中央へ据え直す)。
    assert rep.new_bbox is not None
    assert (rep.new_bbox.x, rep.new_bbox.y, rep.new_bbox.w, rep.new_bbox.h) == (50.0, 28.0, 20.0, 24.0)
    store.close()


def test_non_joined_entry_not_wrap_matched(tmp_path):
    """単独行として登録した語 (joined=False) は連結形と一致しても 2 行を畳まない。"""
    top = _text("商品", x=50, oy=40)
    bottom = _text("名称", x=50, oy=52)  # 幾何的には折返しグループになる並び
    pg = _page([top, bottom])
    store = DictionaryStore(tmp_path / "d.json")
    store.add("商品名称", "Product")  # joined 指定なし = 手入力相当

    n = dict_apply.auto_apply(pg, store, only_headers=False)

    assert n == 0
    assert top.text == "商品" and bottom.deleted is False
    store.close()


def test_wide_gap_stack_not_joined(tmp_path):
    """縦間隔が広い (font*1.6) 同列セルは折返しとみなさず連結しない (誤判定の回帰防止)。"""
    # gap = 12*1.6 = 19.2 → LINE_GAP_RATIO(1.3) 超過。別々の単独行として扱う。
    top = _text("商品", x=50, oy=40)
    bottom = _text("名称", x=50, oy=40 + 12 * 1.6)  # 直下だが行間が広い
    pg = _page([top, bottom])
    store = DictionaryStore(tmp_path / "d.json")
    store.add("商品名称", "Product", joined=True)

    # 連結由来エントリでも幾何条件を満たさなければ当たらない。各行は元のまま。
    n = dict_apply.auto_apply(pg, store, only_headers=False)

    assert n == 0
    assert top.text == "商品" and not bottom.deleted
    # 束ねられていないので候補は連結文字列でなく単独テキストを返す。
    assert dict_apply.joined_candidate(pg, top, join_wrapped=True) == ("商品", False)
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
    """ヘッダでない本文の縦並びは (既定の only_headers=True では) 連結照合しない。"""
    # top band (200*0.25=50) より下に置き、太字でもないのでヘッダにならない
    a = _text("商品", x=50, oy=120)
    b = _text("名称", x=50, oy=132)
    pg = _page([a, b])
    store = DictionaryStore(tmp_path / "d.json")
    store.add("商品名称", "Product", joined=True)

    n = dict_apply.auto_apply(pg, store, only_headers=True)

    assert n == 0
    assert a.text == "商品" and not b.deleted
    store.close()


def test_non_header_stack_joined_when_not_only_headers(tmp_path):
    """only_headers=False では本文セルの複数行 (1 文の折返し) も連結照合する。"""
    # 同じく top band より下・非太字 → ヘッダにはならないが、トグル OFF で連結対象。
    a = _text("商品", x=50, oy=120)
    b = _text("名称", x=50, oy=132)
    pg = _page([a, b])
    store = DictionaryStore(tmp_path / "d.json")
    store.add("商品名称", "Product", joined=True)

    n = dict_apply.auto_apply(pg, store, only_headers=False)

    assert n == 1
    assert a.text == "Product"
    assert a.dict_match is not None and a.dict_match.source == "商品名称"
    assert b.deleted is True  # 2 行目は描画から除外
    store.close()


def test_joined_candidate_wrapped_no_separator():
    """連結 ON の折返し和文セルは、どの行をクリックしても連結 "商品名称" を候補に返す。"""
    top = _text("商品", x=50, oy=40)
    bottom = _text("名称", x=50, oy=52)
    pg = _page([top, bottom])

    assert dict_apply.joined_candidate(pg, top, join_wrapped=True) == ("商品名称", True)
    assert dict_apply.joined_candidate(pg, bottom, join_wrapped=True) == ("商品名称", True)


def test_joined_candidate_wrapped_with_space():
    """連結 ON の折返し欧文セルは空白連結 "Product Name" を候補に返す。"""
    top = _text("Product", x=50, oy=40)
    bottom = _text("Name", x=50, oy=52)
    pg = _page([top, bottom])

    assert dict_apply.joined_candidate(pg, top, join_wrapped=True) == ("Product Name", True)


def test_joined_candidate_off_returns_clicked_line():
    """連結 OFF (既定) では折返しセルでもクリック行の文字列をそのまま候補に返す。"""
    top = _text("商品", x=50, oy=40)
    bottom = _text("名称", x=50, oy=52)
    pg = _page([top, bottom])

    assert dict_apply.joined_candidate(pg, top) == ("商品", False)
    assert dict_apply.joined_candidate(pg, bottom) == ("名称", False)


def test_joined_candidate_single_line():
    """単独行は連結 ON でもその行の文字列をそのまま候補に返す (連結しない)。"""
    head = _text("Qty", x=50, oy=40)
    pg = _page([head])

    assert dict_apply.joined_candidate(pg, head, join_wrapped=True) == ("Qty", False)


def _detect(pg):
    dict_apply.detect_headers(pg)
    return pg
