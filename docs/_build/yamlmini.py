# -*- coding: utf-8 -*-
"""YAML サブセット・パーサ（docs ビルド共通・依存ゼロ）。

`docs/<project>/src/*.xlsx.yaml`（表が主役の原稿）を読むための最小 YAML 実装。**PyYAML は
オフラインバンドルに無いため使わず**、原稿が使う構文だけを自前で解釈する（「外部ライブラリを
足さない」docs ビルドの方針）。旧 `md2xlsx.py`（Excel 生成器・廃止）から切出し、現在は
`md2html.py` が唯一の利用者。

対応する範囲（原稿が使う構文のみ）:
  - ブロックマッピング `key: value` / `key:`（直下にネスト）
  - ブロックシーケンス `- ...`（スカラ / フローコレクション / `- key: ...` のマップ項目）
  - フローシーケンス `[a, "b c", 3]` / フローマッピング `{ k: v, k2: "v2" }`（ネスト・クォート対応）
  - スカラ: int / float / true|false / null|~ / "..."・'...'（クォート）/ 素の文字列
"""
from __future__ import annotations

import re


def parse_yaml(text: str):
    """YAML サブセット文字列を Python の dict/list/スカラへ変換する。"""
    raw = []
    for ln in text.splitlines():
        if not ln.strip() or _is_comment(ln):
            continue
        indent = len(ln) - len(ln.lstrip(" "))
        raw.append((indent, ln.strip()))
    value, _ = _parse_node(raw, 0, raw[0][0]) if raw else (None, 0)
    return value


def _is_comment(line: str) -> bool:
    s = line.lstrip()
    return s.startswith("#")


def _parse_node(lines, idx, indent):
    """`indent` 桁のブロック（マップ or シーケンス）を 1 つ読む。(value, next_idx) を返す。"""
    _, text = lines[idx]
    if text == "-" or text.startswith("- "):
        return _parse_seq(lines, idx, indent)
    return _parse_map(lines, idx, indent)


def _parse_seq(lines, idx, indent):
    seq = []
    while idx < len(lines):
        ind, text = lines[idx]
        if ind != indent or not (text == "-" or text.startswith("- ")):
            break
        item = text[1:].strip()
        if item == "":
            # 次行以降のより深いブロックが要素本体
            child = lines[idx + 1][0]
            val, idx = _parse_node(lines, idx + 1, child)
            seq.append(val)
        elif item[0] in "[{":
            seq.append(_parse_flow(item))
            idx += 1
        elif _looks_like_pair(item):
            # `- key: ...` 形式のマップ項目。先頭ペアはインライン、残りは indent+2 に揃う。
            val, idx = _parse_map(lines, idx, indent + 2, first=item)
            seq.append(val)
        else:
            seq.append(_parse_scalar(item))
            idx += 1
    return seq, idx


def _parse_map(lines, idx, indent, first=None):
    m = {}
    if first is not None:
        key, rest = _split_kv(first)
        idx += 1   # `- key: ...` の行を消費
        idx = _assign(lines, idx, indent, m, key, rest)
    while idx < len(lines):
        ind, text = lines[idx]
        if ind != indent or text.startswith("- "):
            break
        key, rest = _split_kv(text)
        idx += 1
        idx = _assign(lines, idx, indent, m, key, rest)
    return m, idx


def _assign(lines, idx, indent, m, key, rest):
    """`key: rest` の値を解決して `m[key]` に入れる。ネストブロックなら子を読み進める。"""
    if rest == "":
        if idx < len(lines) and lines[idx][0] > indent:
            child = lines[idx][0]
            val, idx = _parse_node(lines, idx, child)
        else:
            val = None
    elif rest[0] in "[{":
        val = _parse_flow(rest)
    else:
        val = _parse_scalar(rest)
    m[key] = val
    return idx


def _looks_like_pair(s: str) -> bool:
    return bool(re.match(r'^[^:\s"\'\[{][^:]*:(\s|$)', s))


def _split_kv(text: str):
    k, _, v = text.partition(":")
    return k.strip(), v.strip()


# ── フローコレクション（`[...]` / `{...}`）の再帰スキャナ ──
def _parse_flow(s: str):
    val, _ = _flow(s, 0)
    return val


def _skip_ws(s, i):
    while i < len(s) and s[i] in " \t":
        i += 1
    return i


def _flow(s, i):
    i = _skip_ws(s, i)
    if i >= len(s):
        return None, i
    if s[i] == "[":
        arr = []
        i = _skip_ws(s, i + 1)
        if s[i] == "]":
            return arr, i + 1
        while True:
            v, i = _flow(s, i)
            arr.append(v)
            i = _skip_ws(s, i)
            if i < len(s) and s[i] == ",":
                i = _skip_ws(s, i + 1)
                continue
            return arr, i + 1  # ']' を飛ばす
    if s[i] == "{":
        obj = {}
        i = _skip_ws(s, i + 1)
        if s[i] == "}":
            return obj, i + 1
        while True:
            key, i = _read_token(s, i, ":")
            i = _skip_ws(s, i)
            i += 1  # ':' を飛ばす
            v, i = _flow(s, i)
            obj[str(key).strip()] = v
            i = _skip_ws(s, i)
            if i < len(s) and s[i] == ",":
                i = _skip_ws(s, i + 1)
                continue
            return obj, i + 1  # '}' を飛ばす
    return _read_token(s, i, ",]}")


def _read_token(s, i, stops):
    """クォート文字列、または `stops` のいずれかまでの素トークンを 1 つ読み、型変換して返す。"""
    i = _skip_ws(s, i)
    if i < len(s) and s[i] in "\"'":
        quote = s[i]
        j = i + 1
        buf = []
        while j < len(s) and s[j] != quote:
            buf.append(s[j])
            j += 1
        return "".join(buf), j + 1
    j = i
    while j < len(s) and s[j] not in stops:
        j += 1
    return _parse_scalar(s[i:j].strip()), j


def _parse_scalar(token: str):
    t = token.strip()
    if len(t) >= 2 and t[0] in "\"'" and t[-1] == t[0]:
        return t[1:-1]
    low = t.lower()
    if low in ("true", "false"):
        return low == "true"
    if low in ("null", "~", ""):
        return None
    if re.fullmatch(r"[+-]?\d+", t):
        return int(t)
    if re.fullmatch(r"[+-]?\d*\.\d+", t):
        return float(t)
    return t
