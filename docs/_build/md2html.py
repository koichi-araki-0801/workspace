# -*- coding: utf-8 -*-
"""Markdown / xlsx.yaml 原稿 → 閲覧用 HTML 集約レンダラ。

docs ビルドの唯一の成果物系統（旧 `md2docx`=Word / `md2xlsx`=Excel を統合・廃止）。原稿を
**読者別に 1 プロジェクト = 2 枚**のライトモード HTML へ集約する:

  - `<proj>_手引き.html`（audience=guide、読者=オペレータ/利用者）… 操作手順書
  - `<proj>_設計.html`  （audience=spec、読者=エンジニア）… 設計正典 → 設計書 →
    デプロイ運用手順書 → 仕様一覧（表）

振り分けは front-matter `audience: guide|spec` を正とし、無指定は名前推定（「操作手順書」
「利用手引き」→ guide、それ以外と `*.xlsx.yaml` → spec）。見た目の `style:` とは独立。

設計方針（CLAUDE.md「ドキュメント」節・オフライン依存回避と整合）:
  - 外部 Markdown ライブラリを使わず、行指向の自前パーサ（旧 `md2docx.py` の実績ロジックを移植）。
  - 表文書（`*.xlsx.yaml`）は `yamlmini.parse_yaml`（YAML サブセット自前パーサ）で読み HTML table 化。
  - 画像は `docs/<project>/images/*.png` を base64 data-URI でインライン（1 枚で自己完結）。
  - **ライトモード固定**（`prefers-color-scheme` は使わない）。配色トークンは旧 Word 版デザイン
    システム（ACCENT #1F5C99 / INK #20242C / MUTED #606874 ほか）と 1:1。
  - Mermaid: `docs/_build/vendor/mermaid.min.js` を HTML へインラインしクライアント描画
    （ライトテーマ固定・`securityLevel` は既定 strict）。vendor 未配置時は `<pre class="mermaid">`
    を整形コードとして表示し警告を積む。

各原稿は `<section>` で包み、front-matter `title` を h1、本文 `#`〜`###` を +1 シフト（h2〜h4）して
1 HTML 内の階層衝突を防ぐ。左固定サイドバーに「原稿 > 見出し」の 2 段 TOC を生成する。

`build_all.py` から `build_project()` を 1 プロジェクト 1 回呼ぶ。新規 .ps1/.bat は増やさない。
"""
from __future__ import annotations

import base64
import html
import pathlib
import re

from yamlmini import parse_yaml

# ── デザイントークン（旧 Word 版 md2docx / md2xlsx と共通・ライト固定）──
CSS_TOKENS = {
    "accent": "#1F5C99",   # 見出しバー・表ヘッダ・番号バッジ・縦バー
    "ink": "#20242C",      # 本文・見出し文字
    "muted": "#606874",    # サブタイトル・キャプション
    "bg": "#FFFFFF",
    "zebra": "#F5F8FB",    # 表の偶数行
    "hair": "#DCE3EA",     # 細罫線・画像枠
    "card": "#FAFBFC",     # カード地
    "code_bg": "#F4F6F8",  # コード網掛け
    "code_bd": "#C4CCD4",  # コード左罫線
    "rule2": "#CDD5DD",    # 見出し下罫線
    "ok_txt": "#1F8A5B", "ok_fill": "#E8F5EE",   # 合格
    "ng_txt": "#B3403F", "ng_fill": "#FDECEC",   # 不合格・必須
    "todo_txt": "#6B727B", "todo_fill": "#EEF1F4",  # 未
}
# callout の `[!TAG]` → 地色 / 枠色（旧 md2docx CALLOUT_FILL/BORDER と 1:1）。
CALLOUT_STYLE = {
    "WARN": ("#FDECEC", "#E4A9A9"),
    "INFO": ("#EAF2FB", "#B9D3EE"),
    "NOTE": ("#EAF2FB", "#B9D3EE"),
    "TIP": ("#FFF6E5", "#F0D9A0"),
}
CALLOUT_DEFAULT = "INFO"

JP = '"BIZ UDPGothic", "Yu Gothic UI", sans-serif'
MONO = '"BIZ UDGothic", "Consolas", monospace'

VENDOR_MERMAID = pathlib.Path(__file__).resolve().parent / "vendor" / "mermaid.min.js"

# 読者別の冊子定義: (audience キー, 出力名サフィックス, 冊子タイトルサフィックス)。
BOOKS = (("guide", "手引き"), ("spec", "設計"))

# 冊子内の連結順（ファイル名キーワード → 優先度）。小さいほど先。既定 40、xlsx.yaml は 50。
# spec 冊子は 設計正典 → 設計書 → デプロイ運用手順書 → 仕様一覧 の導線になる。
_ORDER = [("操作手順書", 10), ("利用手引き", 10), ("設計正典", 15), ("設計書", 20),
          ("デプロイ運用手順書", 30)]


# ── front-matter / インライン（旧 md2docx から移植）──
def parse_frontmatter(text: str):
    """先頭 `---` ブロックを `key: value` の辞書として取り出し、本文を返す。`rev` のみ list 蓄積。"""
    meta = {}
    lines = text.splitlines()
    if lines and lines[0].strip() == "---":
        i = 1
        while i < len(lines) and lines[i].strip() != "---":
            line = lines[i]
            if ":" in line:
                k, _, v = line.partition(":")
                k = k.strip()
                v = v.strip().strip('"').strip("'")
                if k == "rev":
                    meta.setdefault("rev", []).append(v)
                else:
                    meta[k] = v
            i += 1
        body = "\n".join(lines[i + 1:]) if i < len(lines) else ""
        return meta, body
    return meta, text


def audience_of(src: pathlib.Path, meta: dict | None) -> str:
    """原稿の読者区分を返す（'guide' | 'spec'）。front-matter `audience` 優先、無指定は名前推定。"""
    aud = ((meta or {}).get("audience") or "").strip().lower()
    if aud in ("guide", "spec"):
        return aud
    if src.name.endswith(".xlsx.yaml"):
        return "spec"
    return "guide" if ("操作手順書" in src.name or "利用手引き" in src.name) else "spec"


def esc(s: str) -> str:
    return html.escape(str(s), quote=False)


_INLINE_RE = re.compile(r"`([^`]+)`|\*\*([^*]+?)\*\*")


def inline_html(text: str) -> str:
    """段落・セル内のインライン装飾。`` `code` `` と `**bold**` のみ対応（他は HTML エスケープ）。"""
    out, pos = [], 0
    for m in _INLINE_RE.finditer(text):
        if m.start() > pos:
            out.append(esc(text[pos:m.start()]))
        if m.group(1) is not None:
            out.append(f"<code>{esc(m.group(1))}</code>")
        else:
            out.append(f"<strong>{esc(m.group(2))}</strong>")
        pos = m.end()
    out.append(esc(text[pos:]))
    return "".join(out)


_TABLE_SEP = re.compile(r"^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$")
_IMG = re.compile(r"^!\[(?P<cap>.*?)\]\((?P<src>.*?)\)\s*$")
_CALLOUT = re.compile(r"^>\s?(?:\[!(?P<tag>[A-Z]+)\]\s*)?(?P<body>.*)$")
_LIST = re.compile(r"^(?P<indent>\s*)(?P<marker>[-*]|\d+\.)\s+(?P<text>.*)$")


def _split_row(line: str):
    return [c.strip() for c in line.strip().strip("|").split("|")]


def _mermaid_escape(src: str) -> str:
    """Mermaid ソースの HTML 埋込用エスケープ。`-->` を壊さぬよう `>` は素のまま、`&`/`<` のみ変換。"""
    return src.replace("&", "&amp;").replace("<", "&lt;")


def _render_list(items):
    """(level, ordered, text) の連なりをネスト `<ul>`/`<ol>` へ。level は 2 スペース = 1 段。"""
    out = []
    stack = []  # 各要素 ('ul'|'ol', level)
    for level, ordered, text in items:
        tag = "ol" if ordered else "ul"
        while stack and (stack[-1][1] > level or (stack[-1][1] == level and stack[-1][0] != tag)):
            out.append(f"</{stack.pop()[0]}>")
        if not stack or stack[-1][1] < level:
            out.append(f"<{tag}>")
            stack.append((tag, level))
        out.append(f"<li>{inline_html(text)}</li>")
    while stack:
        out.append(f"</{stack.pop()[0]}>")
    return "".join(out)


def _image_data_uri(img_dir: pathlib.Path, name: str):
    """`img_dir/name` の画像を data-URI 化して返す。無ければ None。"""
    path = img_dir / name
    if not path.exists():
        return None
    ext = path.suffix.lower().lstrip(".")
    mime = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg",
            "gif": "image/gif", "svg": "image/svg+xml"}.get(ext, "application/octet-stream")
    data = base64.b64encode(path.read_bytes()).decode("ascii")
    return f"data:{mime};base64,{data}"


def render_markdown(body: str, doc_idx: int, img_dir: pathlib.Path, warnings, src_name: str):
    """Markdown 本文 → (html 断片, toc エントリ list)。見出しは +1 シフトし id を付与。"""
    lines = body.splitlines()
    i, n = 0, len(lines)
    parts, toc = [], []
    hseq = 0
    while i < n:
        line = lines[i]
        stripped = line.strip()

        if not stripped:
            i += 1
            continue

        # HTML コメント（pagebreak 指示・原稿内メモ）は出力しない。複数行コメントは終端まで消費
        if stripped.startswith("<!--"):
            while i < n and "-->" not in lines[i]:
                i += 1
            i += 1
            continue

        # コードフェンス（mermaid は専用ブロック）
        if stripped.startswith("```"):
            lang = stripped[3:].strip() or None
            buf = []
            i += 1
            while i < n and not lines[i].strip().startswith("```"):
                buf.append(lines[i])
                i += 1
            i += 1
            src = "\n".join(buf)
            if (lang or "").lower() == "mermaid":
                parts.append(f'<pre class="mermaid">{_mermaid_escape(src)}</pre>')
            else:
                label = f'<span class="code-lang">{esc(lang)}</span>' if lang else ""
                parts.append(f'<div class="code">{label}<pre><code>{esc(src)}</code></pre></div>')
            continue

        # 見出し（`#`〜`###` を h2〜h4 へ +1 シフト）
        m = re.match(r"^(#{1,6})\s+(.*)$", stripped)
        if m:
            lv = min(len(m.group(1)), 3)
            hseq += 1
            hid = f"d{doc_idx}-h{hseq}"
            text = m.group(2).strip()
            parts.append(f'<h{lv + 1} id="{hid}">{inline_html(text)}</h{lv + 1}>')
            toc.append((lv, hid, text))
            i += 1
            continue

        # 画像（単独行）→ base64 data-URI
        mi = _IMG.match(stripped)
        if mi:
            name = pathlib.Path(mi.group("src")).name
            cap = mi.group("cap") or ""
            uri = _image_data_uri(img_dir, name)
            if uri:
                caphtml = f"<figcaption>{inline_html(cap)}</figcaption>" if cap else ""
                parts.append(f'<figure><img alt="{esc(cap)}" src="{uri}">{caphtml}</figure>')
            else:
                warnings.append(f"{src_name}: 画像未取得 {name}")
                parts.append(f'<div class="img-missing">画像未取得: {esc(name)}</div>')
            i += 1
            continue

        # callout（連続 `>`）
        if stripped.startswith(">"):
            mc = _CALLOUT.match(stripped)
            tag = (mc.group("tag") if mc else None)
            parts_body = [mc.group("body") if mc else stripped[1:].strip()]
            i += 1
            while i < n and lines[i].strip().startswith(">"):
                mc2 = _CALLOUT.match(lines[i].strip())
                parts_body.append(mc2.group("body") if mc2 else lines[i].strip()[1:].strip())
                i += 1
            tagkey = tag if tag in CALLOUT_STYLE else CALLOUT_DEFAULT
            text = " ".join(p for p in parts_body if p)
            badge = f'<span class="callout-tag">{esc(tagkey)}</span>' if tag else ""
            parts.append(f'<div class="callout callout-{tagkey}">{badge}{inline_html(text)}</div>')
            continue

        # テーブル（ヘッダ行 + 区切り行）
        if stripped.startswith("|") and i + 1 < n and _TABLE_SEP.match(lines[i + 1]):
            header = _split_row(stripped)
            i += 2
            rows = []
            while i < n and lines[i].strip().startswith("|"):
                rows.append(_split_row(lines[i]))
                i += 1
            th = "".join(f"<th>{inline_html(c)}</th>" for c in header)
            trs = []
            for r in rows:
                tds = "".join(f"<td>{inline_html(r[j] if j < len(r) else '')}</td>"
                              for j in range(len(header)))
                trs.append(f"<tr>{tds}</tr>")
            parts.append(f'<table><thead><tr>{th}</tr></thead><tbody>{"".join(trs)}</tbody></table>')
            continue

        # 箇条書き / 番号付き（連続分をまとめてネスト化）
        if _LIST.match(line):
            items = []
            while i < n and _LIST.match(lines[i]):
                lm = _LIST.match(lines[i])
                level = len(lm.group("indent")) // 2
                marker = lm.group("marker")
                items.append((level, marker.endswith("."), lm.group("text").strip()))
                i += 1
            parts.append(_render_list(items))
            continue

        # 段落（空行 / 別ブロック開始まで集約）
        buf = [stripped]
        i += 1
        while i < n:
            nxt = lines[i].strip()
            if (not nxt or nxt.startswith("#") or nxt.startswith(">")
                    or nxt.startswith("```") or nxt.startswith("|")
                    or _IMG.match(nxt) or nxt.startswith("<!--")
                    or _LIST.match(lines[i])):
                break
            buf.append(nxt)
            i += 1
        parts.append(f"<p>{inline_html(' '.join(buf))}</p>")

    return "".join(parts), toc


def render_xlsx_yaml(spec: dict, doc_idx: int):
    """xlsx.yaml spec → (html 断片, toc エントリ)。各 sheet を ACCENT ヘッダ + zebra の HTML table に。"""
    parts, toc = [], []
    hseq = 0
    for sheet in spec.get("sheets") or []:
        hseq += 1
        hid = f"d{doc_idx}-s{hseq}"
        sname = sheet.get("name") or f"シート{hseq}"
        parts.append(f'<h2 id="{hid}">{esc(sname)}</h2>')
        toc.append((1, hid, sname))
        stitle = sheet.get("title") or spec.get("title") or ""
        smeta = sheet.get("meta") or spec.get("meta") or ""
        if stitle:
            parts.append(f'<p class="sheet-title">{esc(stitle)}</p>')
        if smeta:
            parts.append(f'<p class="sheet-meta">{esc(smeta)}</p>')
        columns = sheet.get("columns") or []
        rows = sheet.get("rows") or []
        th = "".join(f"<th>{esc(c.get('label', c.get('key', '')))}</th>" for c in columns)
        trs = []
        for ri, row in enumerate(rows):
            zebra = ' class="zebra"' if (ri + 1) % 2 == 0 else ""
            tds = []
            for ci, col in enumerate(columns):
                val = row[ci] if ci < len(row) else ""
                cls = []
                if col.get("mono"):
                    cls.append("mono")
                align = col.get("align")
                if align:
                    cls.append(f"al-{align}")
                kind = col.get("kind")
                sval = str(val).strip()
                if kind == "required" and sval == "○":
                    cls.append("req")
                if kind == "result":
                    cls.append({"合格": "res-ok", "不合格": "res-ng"}.get(sval, "res-todo"))
                cattr = f' class="{" ".join(cls)}"' if cls else ""
                tds.append(f"<td{cattr}>{esc(val)}</td>")
            trs.append(f"<tr{zebra}>{''.join(tds)}</tr>")
        parts.append(f'<table class="spec"><thead><tr>{th}</tr></thead>'
                     f'<tbody>{"".join(trs)}</tbody></table>')
    return "".join(parts), toc


def _css() -> str:
    t = CSS_TOKENS
    return f"""
:root {{
  --accent:{t['accent']}; --ink:{t['ink']}; --muted:{t['muted']}; --bg:{t['bg']};
  --zebra:{t['zebra']}; --hair:{t['hair']}; --card:{t['card']};
  --code-bg:{t['code_bg']}; --code-bd:{t['code_bd']}; --rule2:{t['rule2']};
}}
* {{ box-sizing:border-box; }}
html,body {{ margin:0; background:var(--bg); color:var(--ink);
  font-family:{JP}; font-size:15px; line-height:1.75; }}
a {{ color:var(--accent); text-decoration:none; }}
a:hover {{ text-decoration:underline; }}
code, pre {{ font-family:{MONO}; }}
.layout {{ display:flex; align-items:flex-start; }}
/* 左固定 TOC */
nav.toc {{ position:sticky; top:0; align-self:flex-start; width:290px; min-width:290px;
  height:100vh; overflow-y:auto; padding:22px 16px; border-right:1px solid var(--hair);
  background:var(--card); font-size:13px; }}
nav.toc .doc {{ font-weight:700; color:var(--accent); margin:14px 0 4px;
  border-left:4px solid var(--accent); padding-left:8px; }}
nav.toc a {{ display:block; color:var(--muted); padding:2px 0 2px 6px; }}
nav.toc a.h1 {{ padding-left:10px; }}
nav.toc a.h2 {{ padding-left:22px; }}
nav.toc a.h3 {{ padding-left:34px; font-size:12px; }}
main {{ flex:1; min-width:0; max-width:1000px; padding:28px 44px 120px; }}
section.doc {{ margin-bottom:56px; }}
section.doc + section.doc {{ border-top:2px solid var(--hair); padding-top:28px; }}
h1 {{ font-size:26px; border-left:8px solid var(--accent); padding-left:14px; margin:8px 0 6px; }}
.subtitle {{ color:var(--muted); margin:0 0 4px; }}
.version {{ color:var(--muted); font-size:13px; margin:0 0 18px; }}
h2 {{ font-size:21px; margin:30px 0 10px; padding-bottom:6px; border-bottom:2px solid var(--rule2); }}
h3 {{ font-size:17px; margin:22px 0 8px; color:var(--accent); }}
h4 {{ font-size:15px; margin:18px 0 6px; }}
p {{ margin:10px 0; }}
p code, li code, td code {{ background:var(--code-bg); border:1px solid var(--hair);
  border-radius:3px; padding:0 4px; font-size:0.92em; }}
ul, ol {{ margin:8px 0; padding-left:26px; }}
li {{ margin:3px 0; }}
/* コード */
.code {{ position:relative; margin:14px 0; }}
.code pre {{ background:var(--code-bg); border-left:4px solid var(--accent);
  border-radius:0 4px 4px 0; padding:12px 14px; overflow-x:auto; margin:0; font-size:13px;
  line-height:1.6; }}
.code-lang {{ position:absolute; top:0; right:0; background:var(--accent); color:#fff;
  font-size:11px; padding:1px 8px; border-radius:0 4px 0 6px; font-family:{MONO}; }}
/* テーブル */
table {{ border-collapse:collapse; width:100%; margin:14px 0; font-size:13.5px;
  display:block; overflow-x:auto; }}
th, td {{ border:1px solid var(--hair); padding:6px 10px; text-align:left; vertical-align:top; }}
thead th {{ background:var(--accent); color:#fff; font-weight:700; white-space:nowrap; }}
tbody tr.zebra {{ background:var(--zebra); }}
td.mono {{ font-family:{MONO}; }}
td.al-center {{ text-align:center; }}
td.al-right {{ text-align:right; }}
td.req {{ color:{t['ng_txt']}; font-weight:700; text-align:center; }}
td.res-ok {{ color:{t['ok_txt']}; background:{t['ok_fill']}; font-weight:700; text-align:center; }}
td.res-ng {{ color:{t['ng_txt']}; background:{t['ng_fill']}; font-weight:700; text-align:center; }}
td.res-todo {{ color:{t['todo_txt']}; background:{t['todo_fill']}; text-align:center; }}
.sheet-title {{ font-weight:700; margin:6px 0 0; }}
.sheet-meta {{ color:var(--muted); font-size:13px; margin:2px 0 6px; }}
/* 画像 */
figure {{ margin:16px 0; text-align:center; }}
figure img {{ max-width:100%; height:auto; border:1px solid var(--hair); border-radius:4px; }}
figcaption {{ color:var(--muted); font-size:12.5px; margin-top:6px; }}
.img-missing {{ color:{t['ng_txt']}; background:{t['ng_fill']}; border:1px dashed {t['ng_txt']};
  padding:10px; border-radius:4px; }}
/* callout */
.callout {{ margin:14px 0; padding:10px 14px; border:1px solid; border-radius:5px; }}
.callout-tag {{ display:inline-block; font-weight:700; font-size:11px; color:#fff;
  background:var(--accent); border-radius:3px; padding:0 7px; margin-right:8px;
  vertical-align:1px; }}
.callout-WARN {{ background:{CALLOUT_STYLE['WARN'][0]}; border-color:{CALLOUT_STYLE['WARN'][1]}; }}
.callout-INFO {{ background:{CALLOUT_STYLE['INFO'][0]}; border-color:{CALLOUT_STYLE['INFO'][1]}; }}
.callout-NOTE {{ background:{CALLOUT_STYLE['NOTE'][0]}; border-color:{CALLOUT_STYLE['NOTE'][1]}; }}
.callout-TIP {{ background:{CALLOUT_STYLE['TIP'][0]}; border-color:{CALLOUT_STYLE['TIP'][1]}; }}
.callout-WARN .callout-tag {{ background:{t['ng_txt']}; }}
.callout-TIP .callout-tag {{ background:#B8860B; }}
/* mermaid（未描画時は整形コードとして見せる） */
pre.mermaid {{ background:var(--card); border:1px solid var(--hair); border-radius:6px;
  padding:16px; text-align:center; overflow-x:auto; line-height:1.4; }}
@media (max-width:820px) {{
  .layout {{ flex-direction:column; }}
  nav.toc {{ position:static; width:100%; min-width:0; height:auto; border-right:none;
    border-bottom:1px solid var(--hair); }}
  main {{ padding:18px; }}
}}
"""


def _mermaid_script(has_mermaid: bool) -> str:
    """vendor の mermaid.min.js があればインラインしライトテーマで初期化。無ければ空。

    インライン時は `</script` を `<\\/script` へ置換する（JS 文字列/正規表現内で `\\/` は `/` と
    等価なので挙動不変のまま、HTML パーサによる script 早期終端を防ぐ）。
    """
    if not has_mermaid or not VENDOR_MERMAID.exists():
        return ""
    js = VENDOR_MERMAID.read_text(encoding="utf-8").replace("</script", "<\\/script")
    init = (
        "mermaid.initialize({startOnLoad:true,theme:'base',"
        "themeVariables:{primaryColor:'#EAF2FB',primaryBorderColor:'#1F5C99',"
        "primaryTextColor:'#20242C',lineColor:'#606874',secondaryColor:'#F5F8FB',"
        "tertiaryColor:'#FFFFFF',fontFamily:'BIZ UDPGothic,sans-serif'}});"
    )
    return f"<script>{js}</script>\n<script>{init}</script>"


def _order_key(path: pathlib.Path):
    name = path.name
    for kw, pri in _ORDER:
        if kw in name:
            return (pri, name)
    if name.endswith(".xlsx.yaml"):
        return (50, name)
    return (40, name)


def discover_srcs(proj_dir: pathlib.Path):
    """`docs/<project>/src/` の原稿（.md / .xlsx.yaml）を冊子内の導線順に列挙する。"""
    src = proj_dir / "src"
    if not src.is_dir():
        return []
    srcs = list(src.glob("*.md")) + list(src.glob("*.xlsx.yaml"))
    return sorted(srcs, key=_order_key)


def _build_book(book_title: str, srcs, img_dir: pathlib.Path, out_path: pathlib.Path, warnings):
    """原稿リスト `srcs` を 1 冊の HTML に集約して `out_path` へ保存する。"""
    sections, nav = [], []
    has_mermaid = False
    for di, (src, meta, body_or_spec, is_yaml) in enumerate(srcs):
        if is_yaml:
            spec = body_or_spec or {}
            title = spec.get("title") or src.stem
            subtitle, version = spec.get("meta"), None
            frag, toc = render_xlsx_yaml(spec, di)
        else:
            title = meta.get("title") or src.stem
            subtitle, version = meta.get("subtitle"), meta.get("version")
            if "```mermaid" in body_or_spec:
                has_mermaid = True
            frag, toc = render_markdown(body_or_spec, di, img_dir, warnings, src.name)

        sub = f'<p class="subtitle">{esc(subtitle)}</p>' if subtitle else ""
        ver = f'<p class="version">version {esc(version)}</p>' if version else ""
        sections.append(
            f'<section class="doc" id="doc{di}"><h1>{esc(title)}</h1>{sub}{ver}{frag}</section>')

        nav.append(f'<div class="doc"><a href="#doc{di}">{esc(title)}</a></div>')
        for lv, hid, text in toc:
            nav.append(f'<a class="h{lv}" href="#{hid}">{esc(text)}</a>')

    doc = (
        "<!doctype html>\n"
        '<html lang="ja"><head><meta charset="utf-8">\n'
        '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
        f"<title>{esc(book_title)}</title>\n"
        f"<style>{_css()}</style>\n</head><body>\n"
        '<div class="layout">\n'
        f'<nav class="toc"><div class="doc" style="border:none;color:var(--ink)">'
        f'{esc(book_title)}</div>{"".join(nav)}</nav>\n'
        f'<main>{"".join(sections)}</main>\n'
        "</div>\n"
        f"{_mermaid_script(has_mermaid)}\n"
        "</body></html>\n"
    )
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(doc, encoding="utf-8")
    if has_mermaid and not VENDOR_MERMAID.exists():
        warnings.append(f"{out_path.name}: mermaid 図があるが vendor/mermaid.min.js 未配置"
                        "（整形表示のみ・描画は未有効）")
    return out_path


def build_project(proj_dir: pathlib.Path, warnings=None):
    """プロジェクトの原稿を読者別（guide/spec）に 2 冊へ集約する。生成したパスの list を返す。"""
    proj_dir = pathlib.Path(proj_dir)
    warnings = warnings if warnings is not None else []
    img_dir = proj_dir / "images"

    # 原稿を一度だけ読み、audience で振り分ける（.md は front-matter、.yaml は spec 固定）。
    grouped = {"guide": [], "spec": []}
    for src in discover_srcs(proj_dir):
        text = src.read_text(encoding="utf-8")
        if src.name.endswith(".xlsx.yaml"):
            spec = parse_yaml(text)
            grouped["spec"].append((src, {}, spec, True))
        else:
            meta, body = parse_frontmatter(text)
            grouped[audience_of(src, meta)].append((src, meta, body, False))

    built = []
    for aud, suffix in BOOKS:
        srcs = grouped[aud]
        if not srcs:
            continue   # 片群が空のプロジェクトはその冊子を出さない
        out_path = proj_dir / f"{proj_dir.name}_{suffix}.html"
        built.append(_build_book(f"{proj_dir.name} {suffix}", srcs, img_dir, out_path, warnings))
    return built
