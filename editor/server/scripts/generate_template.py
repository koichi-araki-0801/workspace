#!/usr/bin/env python3
"""Stub template generator.

Replace this with the existing Python template generator. Contract:
- argv[1] is a JSON object: {companyCode, fundCode, editionType, basedOnTemplateId?}
- prints the generated Jinja2 template HTML to stdout.

This stub resolves attributes to a minimal report template; if basedOnTemplateId
is given it tries to read that template file as the base.
"""
import json
import os
import sys


def main() -> int:
    if len(sys.argv) < 2:
        print("missing attributes JSON", file=sys.stderr)
        return 2
    attrs = json.loads(sys.argv[1])
    company = attrs.get("companyCode", "")
    fund = attrs.get("fundCode", "")
    edition = attrs.get("editionType", "")
    based_on = attrs.get("basedOnTemplateId")

    if based_on:
        templates_dir = os.environ.get(
            "TEMPLATES_DIR",
            os.path.join(os.path.dirname(__file__), "..", "..", "data", "templates"),
        )
        # 呼び出し元(`pyTemplate.ts`)も検査するが、ここでも独立に封じ込める。単独実行や
        # 将来の別呼び出し元でも「templates ディレクトリの外は読まない」を成立させるため。
        # basename でセグメントを 1 つに潰し、realpath で解決先が中にあることを確かめる。
        if based_on != os.path.basename(based_on) or ".." in based_on:
            print("invalid basedOnTemplateId", file=sys.stderr)
            return 2
        root = os.path.realpath(templates_dir)
        path = os.path.realpath(os.path.join(root, based_on + ".html"))
        if os.path.commonpath([root, path]) != root:
            print("invalid basedOnTemplateId", file=sys.stderr)
            return 2
        if os.path.exists(path):
            with open(path, encoding="utf-8") as f:
                sys.stdout.write(f.read())
                return 0

    html = f"""<!doctype html>
<html lang="ja">
  <head>
    <meta charset="utf-8" />
    <title>{{{{ fund.name }}}} レポート</title>
    <link rel="stylesheet" href="css/{{{{ fund.code }}}}.css" />
  </head>
  <body>
    <header class="report-header">
      <h1 class="report-title">{{{{ fund.name }}}}</h1>
      <p class="report-meta">委託会社: {company} / ファンド: {fund} / 版種: {edition}</p>
      <p class="report-meta">基準日: {{{{ report.baseDate }}}}</p>
    </header>
    <section class="holdings">
      <h2>組入上位銘柄</h2>
      <ul>
        {{% for h in holdings %}}<li>{{{{ h.name }}}}: {{{{ h.weight }}}}%</li>{{% endfor %}}
      </ul>
    </section>
  </body>
</html>
"""
    sys.stdout.write(html)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
