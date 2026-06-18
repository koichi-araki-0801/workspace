# -*- coding: utf-8 -*-
"""Markdown 原稿 → Word(.docx) 共通レンダラ。

`docs/<project>/src/*.md` を正典とし、本書のヘルパ群で .docx を生成する。ヘルパは
`docs/pdf-to-svg/_build/gen_docs.py`（旧・文書ごとに本文を Python 直書きしていた版）から移植し、
本文だけを Markdown へ逃がした。フォント規約（CLAUDE.md「Word ドキュメント」）は踏襲:
本文 `Meiryo UI`（ascii/eastAsia 両設定）、等幅は `ＭＳ ゴシック`。

依存: python-docx（成果物生成のための一時依存。各ツール本体の requirements には足さない）。
外部 Markdown ライブラリは使わず、必要構文だけの行指向パーサを自前実装（オフライン依存追加を避けるため）。

対応構文の対応表は `docs/_build/README` 相当として本書冒頭コメントに集約する:
  - `#` / `##` / `###`            → `h(level)`（文書タイトルはフロントマター `title`/`subtitle`）
  - 空行区切りの段落             → `para`（`**強調**` と `` `等幅` `` のインライン対応）
  - `- ` / `1. `（2スペース字下げ）→ `bullet` / `numbered`（字下げ→level）
  - ```` ``` ```` フェンス        → `code`（網掛けブロック・言語は無視）
  - GFM テーブル `| a | b |`      → `table`（`Light Grid Accent 1`）
  - `![caption](images/foo.png)` → `image`
  - `> [!WARN]/[!INFO]/>` 引用    → `callout`（赤=FDECEC / 青=EAF2FB / 既定=黄）
  - `<!-- pagebreak -->`         → `page_break`

フロントマター（先頭 `---` ブロック・`key: value` のみの簡易 YAML）でメタを持つ:
  title / subtitle / out（出力 .docx 名）/ version / images（画像基準ディレクトリの相対パス）
"""
from __future__ import annotations

import pathlib
import re

from docx import Document
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml.ns import qn
from docx.shared import Cm, Pt, RGBColor

JP = "Meiryo UI"          # 本文用フォント（CLAUDE.md 規約: 本文は Meiryo UI 統一）
MONO = "ＭＳ ゴシック"      # 等幅（ASCII 図 + 日本語）。Meiryo UI は非等幅のため図のけた揃え用に維持
ACCENT = RGBColor(0x1F, 0x5C, 0x99)
INK = RGBColor(0x20, 0x24, 0x2C)
MUTED = RGBColor(0x60, 0x68, 0x74)

# callout の `[!TAG]` → 背景色。既定（タグ無し `>`）は黄系。
CALLOUT_FILL = {"WARN": "FDECEC", "INFO": "EAF2FB", "NOTE": "EAF2FB", "TIP": "FFF6E5"}
CALLOUT_DEFAULT = "FFF6E5"


# ─────────────────────────────────────────────── docx ヘルパ（gen_docs.py から移植）
def _set_run_font(run, name=JP, size=None, bold=False, italic=False, color=None):
    run.font.name = name
    run._element.rPr.rFonts.set(qn("w:eastAsia"), name)
    if size is not None:
        run.font.size = Pt(size)
    run.font.bold = bold
    run.font.italic = italic
    if color is not None:
        run.font.color.rgb = color


def new_doc() -> Document:
    doc = Document()
    normal = doc.styles["Normal"]
    normal.font.name = JP
    normal.font.size = Pt(10.5)
    normal.element.rPr.rFonts.set(qn("w:eastAsia"), JP)
    for sec in doc.sections:
        sec.top_margin = Cm(2.0)
        sec.bottom_margin = Cm(2.0)
        sec.left_margin = Cm(2.2)
        sec.right_margin = Cm(2.2)
    return doc


def title(doc, text, subtitle=None):
    p = doc.add_paragraph()
    r = p.add_run(text)
    _set_run_font(r, size=22, bold=True, color=ACCENT)
    if subtitle:
        ps = doc.add_paragraph()
        rs = ps.add_run(subtitle)
        _set_run_font(rs, size=11, color=MUTED)


def h(doc, text, level=1):
    sizes = {1: 15, 2: 12.5, 3: 11}
    p = doc.add_paragraph()
    p.paragraph_format.space_before = Pt(10 if level == 1 else 7)
    p.paragraph_format.space_after = Pt(3)
    _add_inline(p, text, size=sizes.get(level, 11), base_bold=True,
                base_color=ACCENT if level == 1 else INK)
    return p


def para(doc, text, size=10.5):
    p = doc.add_paragraph()
    p.paragraph_format.space_after = Pt(4)
    _add_inline(p, text, size=size)
    return p


# `**強調**` と `` `等幅` `` を runs へ分解するインラインパーサ。
_INLINE = re.compile(r"(\*\*.+?\*\*|`[^`]+`)")


def _add_inline(p, text, size=10.5, base_bold=False, base_color=None):
    """`text` を解析し、強調/等幅を反映した runs を段落 `p` へ追加する。"""
    parts = _INLINE.split(text)
    for part in parts:
        if not part:
            continue
        if part.startswith("**") and part.endswith("**") and len(part) >= 4:
            r = p.add_run(part[2:-2])
            _set_run_font(r, size=size, bold=True, color=base_color)
        elif part.startswith("`") and part.endswith("`") and len(part) >= 2:
            r = p.add_run(part[1:-1])
            _set_run_font(r, name=MONO, size=size - 0.5, bold=base_bold, color=base_color)
        else:
            r = p.add_run(part)
            _set_run_font(r, size=size, bold=base_bold, color=base_color)


def bullet(doc, text, level=0, size=10.5):
    p = doc.add_paragraph(style="List Bullet")
    p.paragraph_format.left_indent = Cm(0.6 + level * 0.5)
    p.paragraph_format.space_after = Pt(2)
    _add_inline(p, text, size=size)
    return p


def numbered(doc, text, level=0, size=10.5):
    p = doc.add_paragraph(style="List Number")
    p.paragraph_format.left_indent = Cm(0.6 + level * 0.5)
    p.paragraph_format.space_after = Pt(3)
    _add_inline(p, text, size=size)
    return p


def code(doc, text, size=8.8):
    p = doc.add_paragraph()
    p.paragraph_format.space_before = Pt(3)
    p.paragraph_format.space_after = Pt(6)
    p.paragraph_format.left_indent = Cm(0.3)
    shd = p._p.get_or_add_pPr().makeelement(qn("w:shd"), {
        qn("w:val"): "clear", qn("w:color"): "auto", qn("w:fill"): "F2F4F7"})
    p._p.get_or_add_pPr().append(shd)
    r = p.add_run(text)
    _set_run_font(r, name=MONO, size=size)


def table(doc, header, rows, widths=None):
    t = doc.add_table(rows=1, cols=len(header))
    t.style = "Light Grid Accent 1"
    t.alignment = WD_TABLE_ALIGNMENT.LEFT
    hdr = t.rows[0].cells
    for i, htext in enumerate(header):
        hdr[i].text = ""
        _add_inline(hdr[i].paragraphs[0], htext, size=9.5, base_bold=True)
    for row in rows:
        cells = t.add_row().cells
        for i, val in enumerate(row):
            cells[i].text = ""
            _add_inline(cells[i].paragraphs[0], str(val), size=9.5)
    if widths:
        for i, w in enumerate(widths):
            for row in t.rows:
                row.cells[i].width = Cm(w)
    return t


def image(doc, img_dir: pathlib.Path, name, width_cm=16.0, caption=None):
    """`img_dir/name` を中央寄せで挿入。欠落時はプレースホルダ段落を入れて続行（警告は呼び元が集計）。"""
    path = img_dir / name
    if not path.exists():
        p = doc.add_paragraph()
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        r = p.add_run(f"［画像未取得: {name}］")
        _set_run_font(r, size=9.5, italic=True, color=MUTED)
        return False
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p.add_run().add_picture(str(path), width=Cm(width_cm))
    if caption:
        c = doc.add_paragraph()
        c.alignment = WD_ALIGN_PARAGRAPH.CENTER
        r = c.add_run(caption)
        _set_run_font(r, size=9, italic=True, color=MUTED)
        c.paragraph_format.space_after = Pt(8)
    return True


def callout(doc, text, fill=CALLOUT_DEFAULT):
    p = doc.add_paragraph()
    p.paragraph_format.space_before = Pt(4)
    p.paragraph_format.space_after = Pt(6)
    pPr = p._p.get_or_add_pPr()
    shd = pPr.makeelement(qn("w:shd"), {
        qn("w:val"): "clear", qn("w:color"): "auto", qn("w:fill"): fill})
    pPr.append(shd)
    _add_inline(p, text, size=10)


def page_break(doc):
    doc.add_page_break()


# ─────────────────────────────────────────────── フロントマター + Markdown パーサ
def _parse_frontmatter(text: str):
    """先頭 `---` ブロックを `key: value` の辞書として取り出し、本文を返す。"""
    meta = {}
    lines = text.splitlines()
    if lines and lines[0].strip() == "---":
        i = 1
        while i < len(lines) and lines[i].strip() != "---":
            line = lines[i]
            if ":" in line:
                k, _, v = line.partition(":")
                meta[k.strip()] = v.strip().strip('"').strip("'")
            i += 1
        body = "\n".join(lines[i + 1:]) if i < len(lines) else ""
        return meta, body
    return meta, text


_TABLE_SEP = re.compile(r"^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$")
_IMG = re.compile(r"^!\[(?P<cap>.*?)\]\((?P<src>.*?)\)\s*$")
_CALLOUT = re.compile(r"^>\s?(?:\[!(?P<tag>[A-Z]+)\]\s*)?(?P<body>.*)$")


def _split_row(line: str):
    cells = line.strip().strip("|").split("|")
    return [c.strip() for c in cells]


def render(md_path, out_path, img_dir, warnings=None):
    """Markdown 原稿 `md_path` を `out_path` の .docx へ描画する。

    `img_dir` は画像参照の基準ディレクトリ。`warnings` は欠落画像などを積む list（任意）。
    戻り値はフロントマター辞書。
    """
    md_path = pathlib.Path(md_path)
    out_path = pathlib.Path(out_path)
    img_dir = pathlib.Path(img_dir)
    warnings = warnings if warnings is not None else []

    meta, body = _parse_frontmatter(md_path.read_text(encoding="utf-8"))
    images_override = meta.get("images")
    if images_override:
        img_dir = (md_path.parent / images_override).resolve()

    doc = new_doc()
    if meta.get("title"):
        title(doc, meta["title"], meta.get("subtitle"))
    if meta.get("version"):
        para(doc, f"版: {meta['version']}", size=9.5)

    lines = body.splitlines()
    i = 0
    n = len(lines)
    while i < n:
        line = lines[i]
        stripped = line.strip()

        # 空行
        if not stripped:
            i += 1
            continue

        # ページ区切り
        if stripped == "<!-- pagebreak -->":
            page_break(doc)
            i += 1
            continue

        # コードフェンス
        if stripped.startswith("```"):
            buf = []
            i += 1
            while i < n and not lines[i].strip().startswith("```"):
                buf.append(lines[i])
                i += 1
            i += 1  # 終了フェンスを飛ばす
            code(doc, "\n".join(buf))
            continue

        # 見出し
        m = re.match(r"^(#{1,6})\s+(.*)$", stripped)
        if m:
            level = min(len(m.group(1)), 3)
            h(doc, m.group(2).strip(), level=level)
            i += 1
            continue

        # 画像（単独行）
        mi = _IMG.match(stripped)
        if mi:
            name = pathlib.Path(mi.group("src")).name
            ok = image(doc, img_dir, name, caption=(mi.group("cap") or None))
            if not ok:
                warnings.append(f"{md_path.name}: 画像未取得 {name}")
            i += 1
            continue

        # callout（引用）
        if stripped.startswith(">"):
            mc = _CALLOUT.match(stripped)
            tag = (mc.group("tag") if mc else None)
            parts = [mc.group("body") if mc else stripped[1:].strip()]
            i += 1
            while i < n and lines[i].strip().startswith(">"):
                mc2 = _CALLOUT.match(lines[i].strip())
                parts.append(mc2.group("body") if mc2 else lines[i].strip()[1:].strip())
                i += 1
            fill = CALLOUT_FILL.get(tag, CALLOUT_DEFAULT)
            callout(doc, " ".join(p for p in parts if p), fill=fill)
            continue

        # テーブル（ヘッダ行 + 区切り行）
        if stripped.startswith("|") and i + 1 < n and _TABLE_SEP.match(lines[i + 1]):
            header = _split_row(stripped)
            i += 2
            rows = []
            while i < n and lines[i].strip().startswith("|"):
                rows.append(_split_row(lines[i]))
                i += 1
            table(doc, header, rows)
            continue

        # 箇条書き / 番号付き
        mb = re.match(r"^(?P<indent>\s*)(?P<marker>[-*]|\d+\.)\s+(?P<text>.*)$", line)
        if mb:
            level = len(mb.group("indent")) // 2
            txt = mb.group("text").strip()
            if mb.group("marker").endswith("."):
                numbered(doc, txt, level=level)
            else:
                bullet(doc, txt, level=level)
            i += 1
            continue

        # 段落（空行 / 別ブロック開始まで集約）
        buf = [stripped]
        i += 1
        while i < n:
            nxt = lines[i].strip()
            if (not nxt or nxt.startswith("#") or nxt.startswith(">")
                    or nxt.startswith("```") or nxt.startswith("|")
                    or _IMG.match(nxt) or nxt == "<!-- pagebreak -->"
                    or re.match(r"^([-*]|\d+\.)\s+", nxt)):
                break
            buf.append(nxt)
            i += 1
        para(doc, " ".join(buf))

    out_path.parent.mkdir(parents=True, exist_ok=True)
    doc.save(str(out_path))
    return meta
