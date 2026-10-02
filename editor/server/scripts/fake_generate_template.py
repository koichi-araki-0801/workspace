#!/usr/bin/env python3
"""テスト・local 検証用の偽の生成器。本番は PY_GENERATE_SCRIPT で既存の生成器を指す。

入出力の約束(呼び出し元は editor/server/src/generate/pyTemplate.ts):
- argv[1] は JSON: {companyCode, fundCode, editionType, baseDate, basedOnTemplateId?}
- 生成した Jinja2 テンプレート HTML を stdout へ出す。

basedOnTemplateId があれば、環境変数 TEMPLATES_DIR(サーバが config.templatesDir を渡す)の
<id>.html をそのまま返す。TEMPLATES_DIR が無ければ元テンプレ指定はエラーにする。
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
        templates_dir = os.environ.get("TEMPLATES_DIR")
        if not templates_dir:
            # サーバは必ず TEMPLATES_DIR を渡す。無いのは単独実行か呼び出し元の不備で、既定の
            # 置き場を推測して読むと、別の環境のテンプレを元にした生成物ができてしまう。
            print("TEMPLATES_DIR is required when basedOnTemplateId is given", file=sys.stderr)
            return 2
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
