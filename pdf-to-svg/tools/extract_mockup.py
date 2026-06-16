#!/usr/bin/env python3
"""dev 専用: オフライン版 HTML モックから実アプリ用 Web 資産を取り出す。

入力: ``PdfToSvg オフライン版.html`` (bundler 形式。内側アプリは JSON 化された
``<script type="__bundler/template">`` に格納されている)。

出力:
  - resources/web/styles.css : デザイン CSS (約 700 行・配布対象)。@font-face は
        全削除し、フォントトークン (--font-ui / --font-round) を Windows 標準フォントへ。
  - tools/_mockup/markup.html : <body> 内マークアップ (index.html 編集時の参照・非配布)。
  - tools/_mockup/app.mock.js : モック元の状態機械 (app.js 編集時の参照・非配布)。

index.html / app.js / rpc.js はリポジトリ側で管理する (手書き)。
本スクリプトは「モックを取り込み直す」とき以外は実行不要。

使い方:
    python tools/extract_mockup.py "C:/Users/caads/Downloads/PdfToSvg オフライン版.html"
"""
from __future__ import annotations

import io
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "resources" / "web"           # 配布対象 (styles.css)
REF = ROOT / "tools" / "_mockup"           # 開発参照 (markup / mock js)。非配布

# UI クローム用フォント (Windows 標準で近いもの)。本文 SVG の埋め込みフォントとは無関係。
FONT_UI = '"Yu Gothic UI", "Meiryo", system-ui, sans-serif'
FONT_ROUND = '"BIZ UDPGothic", "BIZ UDGothic", "Yu Gothic UI", "Meiryo", system-ui, sans-serif'


def _decode_template(html_path: Path) -> str:
    """bundler HTML から内側アプリ HTML (decoded template) を取り出す。"""
    tmpl_line = None
    with io.open(html_path, encoding="utf-8") as fh:
        capture = False
        buf = []
        for line in fh:
            s = line.strip()
            if s.startswith('<script type="__bundler/template">'):
                capture = True
                rest = line.split(">", 1)[1]
                if rest.strip():
                    buf.append(rest)
                continue
            if capture:
                if s.startswith("</script>"):
                    break
                buf.append(line)
        tmpl_line = "".join(buf).strip()
    if not tmpl_line:
        raise SystemExit("template script not found")
    return json.loads(tmpl_line)


def _section(html: str, open_tag_re: str, close_tag: str) -> tuple[int, int]:
    m = re.search(open_tag_re, html)
    if not m:
        raise SystemExit(f"section not found: {open_tag_re}")
    start = m.end()
    end = html.index(close_tag, start)
    return start, end


def _strip_font_faces(css: str) -> str:
    # @font-face { ... } はネストしないので非貪欲で安全に除去
    css = re.sub(r"@font-face\s*\{[^}]*\}\s*", "", css)
    css = css.replace('"Zen Kaku Gothic New", system-ui, sans-serif', FONT_UI)
    css = css.replace('"M PLUS Rounded 1c", system-ui, sans-serif', FONT_ROUND)
    return css.strip()


def main() -> int:
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    html_path = Path(sys.argv[1])
    html = _decode_template(html_path)
    OUT.mkdir(parents=True, exist_ok=True)

    # CSS: 最初の <style>...</style> を採用し、@font-face を除去
    cs, ce = _section(html, r"<style>", "</style>")
    css_main = html[cs:ce]
    # 2 つ目の <style> (小さい補助スタイル) も結合
    try:
        cs2, ce2 = _section(html[ce:], r"<style>", "</style>")
        css_main += "\n" + html[ce + cs2 : ce + ce2]
    except SystemExit:
        pass
    css = _strip_font_faces(css_main)
    OUT.mkdir(parents=True, exist_ok=True)
    REF.mkdir(parents=True, exist_ok=True)
    (OUT / "styles.css").write_text(css, encoding="utf-8")

    # body 内マークアップ (#app ... </div> までの塊) — 参照用に丸ごと保存
    bs, be = _section(html, r"<body>", "</body>")
    body = html[bs:be].strip()
    # 末尾の <script>...</script> を切り出して app.js へ
    sm = re.search(r"<script>", body)
    markup = body[: sm.start()].strip() if sm else body
    script = ""
    if sm:
        se = body.index("</script>", sm.end())
        script = body[sm.end() : se].strip()
    (REF / "markup.html").write_text(markup, encoding="utf-8")
    (REF / "app.mock.js").write_text(script, encoding="utf-8")

    print("wrote:")
    for p in (OUT / "styles.css", REF / "markup.html", REF / "app.mock.js"):
        print(f"  {p}  ({p.stat().st_size:,} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
