"""照合用の文字列正規化。

非エンジニアにも予測可能なよう、既定は「trim + 連続空白圧縮 + NFKC(全角半角統一)」。
オプションで大文字小文字無視・かな統一を切り替えられる。
"""
from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass

_WS = re.compile(r"\s+")

# カタカナ→ひらがな変換テーブル
_KATA_TO_HIRA = {i: i - 0x60 for i in range(0x30A1, 0x30F7)}


@dataclass(frozen=True)
class NormOptions:
    nfkc: bool = True
    collapse_ws: bool = True
    casefold: bool = False
    kana_fold: bool = False  # カタカナ→ひらがな統一


DEFAULT_OPTIONS = NormOptions()


def normalize(text: str, opts: NormOptions = DEFAULT_OPTIONS) -> str:
    s = text.strip()
    if opts.nfkc:
        s = unicodedata.normalize("NFKC", s)
    if opts.collapse_ws:
        s = _WS.sub(" ", s)
    if opts.casefold:
        s = s.casefold()
    if opts.kana_fold:
        s = s.translate(_KATA_TO_HIRA)
    return s
