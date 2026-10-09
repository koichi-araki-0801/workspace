# -*- coding: utf-8 -*-
"""md2html.py の HTML コメント除去・script 終端エスケープの単体テスト。

実行: `python -m pytest docs/_build/test_md2html.py`。
"""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import md2html  # noqa: E402


def test_strip_comments_removes_midline_outside_fence():
    # 行頭に限らず行中のコメントも除去する（従来は行頭開始のみが対象だった）。
    body = "before <!-- drop me --> after"
    assert md2html._strip_comments(body) == "before  after"


def test_strip_comments_keeps_backtick_fence_content():
    body = "```\nkept <!-- inside --> as is\n```"
    assert md2html._strip_comments(body) == body


def test_strip_comments_keeps_tilde_fence_content():
    # ~~~ フェンスも ``` と同様に保護対象（従来は ``` のみで誤除去していた）。
    body = "~~~\nkept <!-- inside --> as is\n~~~"
    assert md2html._strip_comments(body) == body


def test_strip_comments_spans_multiple_lines():
    body = "head <!-- line1\nline2 --> tail"
    assert md2html._strip_comments(body) == "head  tail"


def test_strip_comments_leaves_unclosed_comment_visible():
    # 閉じていないコメントは除去しない（読者にリテラル表示される現行挙動を維持）。
    body = "tail <!-- unclosed to eof\nnext line"
    assert md2html._strip_comments(body) == body


def test_script_close_re_is_case_insensitive():
    js = 'document.write("</SCRIPT>"); document.write("</script>");'
    out = md2html._SCRIPT_CLOSE_RE.sub("<\\/", js)
    assert "</SCRIPT>" not in out
    assert "</script>" not in out
    assert out == 'document.write("<\\/SCRIPT>"); document.write("<\\/script>");'


def test_parse_frontmatter_names_the_source_on_invalid_yaml():
    import pytest
    bad = "---\ntitle: [unclosed\n---\nbody\n"
    with pytest.raises(ValueError, match=r"^設計書\.md: front-matter"):
        md2html.parse_frontmatter(bad, src_name="設計書.md")


def test_audience_of_tolerates_yaml_bool_value(tmp_path):
    src = tmp_path / "設計書.md"
    # YAML は `yes` を bool にする。文字列として扱えず落ちるのではなく名前推定へ倒す
    assert md2html.audience_of(src, {"audience": True}) == "spec"
    assert md2html.audience_of(tmp_path / "操作手順書.md", {"audience": True}) == "guide"


def _render(md: str) -> str:
    html_out, _toc = md2html.render_markdown(md, 0, pathlib.Path("."), [], "t.md")
    return html_out


def test_callout_keeps_list_inside():
    md = "> [!WARN] 決まりが 2 つあります。\n> - 一つ目\n> - **二つ目**\n"
    out = _render(md)
    assert out.startswith('<div class="callout callout-WARN">')
    assert "<ul><li>一つ目</li><li><strong>二つ目</strong></li></ul>" in out
    assert "決まりが 2 つあります。" in out
    assert out.endswith("</div>")


def test_callout_keeps_code_fence_inside():
    md = "> [!NOTE] 例:\n>\n> ```\n> a < b\n> ```\n"
    out = _render(md)
    assert '<div class="code"><pre><code>a &lt; b</code></pre></div>' in out


def test_callout_paragraph_only_is_unchanged():
    # 段落だけの callout は従来どおり <p> で包まず、複数段落は空白で連結する
    md = "> [!INFO] 一行目\n> 続き\n>\n> 二段落目\n"
    out = _render(md)
    assert out == ('<div class="callout callout-INFO"><span class="callout-tag">INFO</span>'
                   '一行目 続き 二段落目</div>')


def test_render_markdown_shifts_headings_and_collects_toc():
    html_out, toc = md2html.render_markdown("# 見出し\n", 2, pathlib.Path("."), [], "t.md",
                                            shift=1)
    assert html_out == '<h2 id="d2-h1">見出し</h2>'
    assert toc == [(1, "d2-h1", "見出し")]
