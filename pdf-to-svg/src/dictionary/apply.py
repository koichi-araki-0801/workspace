"""ヘッダ検出と辞書の適用。

PDF には意味的な「表ヘッダ」が無いため、ヒューリスティックで is_header を推定する
(太字、または最上段の行バンド)。取りこぼしは UI から手動トグルで救済する。
適用は「置換案 (Replacement) のリスト」を返し、UndoStack 経由で反映できるようにする。
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import List

from model.document import Page
from model.elements import DictMatch, TextElement
from dictionary.store import DictionaryStore

TOP_BAND_RATIO = 0.25  # ページ上端からこの割合内の最初の行をヘッダ候補とする
ROW_TOLERANCE = 3.0    # 同一行とみなす baseline の許容差(pt)


@dataclass
class Replacement:
    element: TextElement
    source: str
    target: str


def _text_elements(page: Page) -> List[TextElement]:
    return [e for e in page.elements if isinstance(e, TextElement) and not e.deleted]


def detect_headers(page: Page) -> None:
    """is_header を推定して各 TextElement に設定する。"""
    texts = _text_elements(page)
    if not texts:
        return

    # 最上段の行バンド (top band 内で最小 y のクラスタ)
    band_limit = page.height_pt * TOP_BAND_RATIO
    top_candidates = [t for t in texts if t.origin_y <= band_limit]
    top_row_ys: List[float] = []
    if top_candidates:
        min_y = min(t.origin_y for t in top_candidates)
        top_row_ys = [
            t.origin_y for t in top_candidates if abs(t.origin_y - min_y) <= ROW_TOLERANCE
        ]

    for t in texts:
        in_top_row = any(abs(t.origin_y - y) <= ROW_TOLERANCE for y in top_row_ys)
        t.is_header = bool(t.bold or in_top_row)


def plan_replacements(
    page: Page, store: DictionaryStore, only_headers: bool = True
) -> List[Replacement]:
    """辞書に一致する置換案を列挙する (実際の書き換えはしない)。"""
    plans: List[Replacement] = []
    for el in _text_elements(page):
        if only_headers and not el.is_header:
            continue
        target = store.lookup(el.text)
        if target is not None and target != el.text:
            plans.append(Replacement(el, el.text, target))
    return plans


def apply_replacement(rep: Replacement) -> None:
    """置換案をモデルへ反映 (初期自動適用用。Undo が要る場面では Command を使う)。"""
    rep.element.text = rep.target
    rep.element.dict_match = DictMatch(source=rep.source, target=rep.target)


def auto_apply(page: Page, store: DictionaryStore, only_headers: bool = True) -> int:
    """ヘッダ検出 → 一致を直接適用。適用件数を返す (文書オープン時用)。"""
    detect_headers(page)
    plans = plan_replacements(page, store, only_headers=only_headers)
    for rep in plans:
        apply_replacement(rep)
    return len(plans)
