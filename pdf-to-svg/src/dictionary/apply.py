"""ヘッダ検出と辞書の適用。

PDF には意味的な「表ヘッダ」が無いため、ヒューリスティックで is_header を推定する
(太字、または最上段の行バンド)。取りこぼしは UI から手動トグルで救済する。
適用は「置換案 (Replacement) のリスト」を返し、UndoStack 経由で反映できるようにする。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import List, Optional, Tuple

from model import fonts
from model.document import Page
from model.elements import DictMatch, Rect, TextElement
from dictionary.store import DictionaryStore

TOP_BAND_RATIO = 0.25  # ページ上端からこの割合内の最初の行をヘッダ候補とする
ROW_TOLERANCE = 3.0    # 同一行とみなす baseline の許容差(pt)

# 折返しヘッダ (複数行に分割されたセル) を 1 語として連結照合するためのしきい値。
# PyMuPDF は折返し各行を別 span = 別 TextElement に分けるため、縦に隣接する
# 同一列・同一サイズの要素を 1 グループに束ねて辞書を引く (照合・置換時のみ連結。
# 描画は従来どおり行ごとの <text> のまま)。
COLUMN_OVERLAP_RATIO = 0.5  # 同一列とみなす bbox 横方向オーバーラップ率 (狭い方基準)
LINE_GAP_RATIO = 1.8        # 縦隣接とみなす baseline 差 (フォントサイズ比)
FONT_SIZE_TOL = 0.5         # 同一スタイルとみなす font_size 許容差(pt)


@dataclass
class Replacement:
    element: TextElement
    source: str
    target: str
    # 折返しヘッダの 2 行目以降。置換時は描画から除外 (deleted) する。
    extras: List[TextElement] = field(default_factory=list)
    # 折返し畳み込み時、結合テキストを据え直す合成領域 (グループ全体の bbox)。
    # SVG 書き出しは置換後テキストをこの箱の縦横中央へ収める (`svg_exporter.py` の
    # `_text_to_svg`)。単独行は None で元 bbox のまま。
    new_bbox: Optional[Rect] = None
    # 置換語の推定幅が収め先の箱幅を超える恐れ ("width_overflow")。レビュー UI / ログ用。
    warning: Optional[str] = None


def _merged_bbox(group: List[TextElement]) -> Rect:
    """折返しグループ全体を包む合成 bbox (置換後テキストの据え直し領域)。"""
    x0 = min(t.bbox.x for t in group)
    y0 = min(t.bbox.y for t in group)
    x1 = max(t.bbox.x1 for t in group)
    y1 = max(t.bbox.y1 for t in group)
    return Rect(x0, y0, x1 - x0, y1 - y0)


def _overflow_warning(target: str, font_size: float, box_w: float) -> Optional[str]:
    """置換語が箱幅を超える恐れなら警告種別を返す (簡易幅推定)。"""
    return "width_overflow" if fonts.is_width_overflow(target, font_size, box_w) else None


def _text_elements(page: Page) -> List[TextElement]:
    return [e for e in page.elements if isinstance(e, TextElement) and not e.deleted]


def _x_overlap_ratio(a: TextElement, b: TextElement) -> float:
    ov = min(a.bbox.x1, b.bbox.x1) - max(a.bbox.x, b.bbox.x)
    narrow = min(a.bbox.w, b.bbox.w)
    return ov / narrow if (ov > 0 and narrow > 0) else 0.0


def _is_wrap_follower(top: TextElement, below: TextElement) -> bool:
    """below が top の直下に折り返された同一セルの続き行とみなせるか。"""
    gap = below.origin_y - top.origin_y
    return (
        0 < gap <= max(top.font_size, below.font_size) * LINE_GAP_RATIO
        and _x_overlap_ratio(top, below) >= COLUMN_OVERLAP_RATIO
        and abs(top.font_size - below.font_size) <= FONT_SIZE_TOL
    )


def _wrap_groups(texts: List[TextElement]) -> List[List[TextElement]]:
    """縦に折り返された同一列・同一スタイルの要素を上→下のグループに束ねる。

    単独行は要素 1 個のグループになる (= 連結対象外)。
    """
    ordered = sorted(texts, key=lambda t: (round(t.origin_y, 1), t.origin_x))
    used: set = set()
    groups: List[List[TextElement]] = []
    for i, t in enumerate(ordered):
        if id(t) in used:
            continue
        group = [t]
        used.add(id(t))
        cur = t
        for u in ordered[i + 1:]:
            if id(u) in used:
                continue
            if _is_wrap_follower(cur, u):
                group.append(u)
                used.add(id(u))
                cur = u
        groups.append(group)
    return groups


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

    # 折返しヘッダ: 先頭行がヘッダのグループは後続行も is_header にする
    # (top band 判定だと 2 行目以降は baseline がずれて取りこぼすため)。
    for group in _wrap_groups(texts):
        if group[0].is_header:
            for t in group:
                t.is_header = True


def _lookup_joined(
    store: DictionaryStore, group: List[TextElement]
) -> Optional[Tuple[str, str]]:
    """折返しグループを連結して辞書を引く (区切り無し→空白の順で最初の一致)。

    一致した連結元文字列 (source) と置換先 (target) の組を返す。
    """
    parts = [t.text.strip() for t in group]
    for sep in ("", " "):  # 和文(区切り無し)・欧文(空白)の双方を拾う
        joined = sep.join(parts)
        target = store.lookup(joined)
        if target is not None:
            return joined, target
    return None


def plan_replacements(
    page: Page, store: DictionaryStore, only_headers: bool = True
) -> List[Replacement]:
    """辞書に一致する置換案を列挙する (実際の書き換えはしない)。"""
    plans: List[Replacement] = []
    texts = _text_elements(page)
    consumed: set = set()

    # 折返しヘッダの連結照合 (要素単位より優先)。連結で一致しなければグループは
    # 解放され、各行が従来どおり単独照合される (後方互換)。
    for group in _wrap_groups(texts):
        if len(group) < 2 or not group[0].is_header:
            continue
        hit = _lookup_joined(store, group)
        if hit is None:
            continue
        source, target = hit
        top = group[0]
        if target != top.text:
            # 折返しは結合テキストをグループ全体の合成領域へ据え直す (縦の畳み込みで
            # 上詰まりするのを防ぎ、水平も合成全幅に収めて圧縮を緩める)。
            box = _merged_bbox(group)
            plans.append(
                Replacement(
                    top, source, target, extras=group[1:], new_bbox=box,
                    warning=_overflow_warning(target, top.font_size, box.w),
                )
            )
        for t in group:
            consumed.add(id(t))

    for el in texts:
        if id(el) in consumed:
            continue
        if only_headers and not el.is_header:
            continue
        target = store.lookup(el.text)
        if target is not None and target != el.text:
            plans.append(
                Replacement(
                    el, el.text, target,
                    warning=_overflow_warning(target, el.font_size, el.bbox.w),
                )
            )
    return plans


def apply_replacement(rep: Replacement) -> None:
    """置換案をモデルへ反映 (初期自動適用用。Undo が要る場面では Command を使う)。"""
    rep.element.text = rep.target
    rep.element.dict_match = DictMatch(source=rep.source, target=rep.target)
    if rep.new_bbox is not None:  # 折返し畳み込み: 合成領域へ据え直す
        rep.element.bbox = rep.new_bbox
    for ex in rep.extras:  # 折返し 2 行目以降は描画から除外
        ex.deleted = True


def auto_apply(page: Page, store: DictionaryStore, only_headers: bool = True) -> int:
    """ヘッダ検出 → 一致を直接適用。適用件数を返す (文書オープン時用)。"""
    detect_headers(page)
    plans = plan_replacements(page, store, only_headers=only_headers)
    for rep in plans:
        apply_replacement(rep)
    return len(plans)
