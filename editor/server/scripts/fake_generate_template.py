#!/usr/bin/env python3
"""テスト・local 検証用の偽の生成器。本番は PY_GENERATE_SCRIPT で既存の生成器を指す。

入出力の約束(呼び出し元は editor/server/src/generate/pyTemplate.ts):
- argv[1] は JSON: {companyCode, fundCode, editionType, baseDate, sourceFundCode?, isRedemption?}
- 生成した Jinja2 テンプレート HTML を stdout へ出す。

sourceFundCode があれば、環境変数 TEMPLATES_DIR(サーバが config.templatesDir を渡す)にある
同じ会社・版種のコピー元ファンドのうち、基準日が最新のテンプレートを返す(会社コードの大文字小文字は
区別しない)。TEMPLATES_DIR が無ければエラーにする。isRedemption は受け取るだけ。
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
    source_fund = attrs.get("sourceFundCode")

    if source_fund:
        templates_dir = os.environ.get("TEMPLATES_DIR")
        if not templates_dir:
            print("TEMPLATES_DIR is required when sourceFundCode is given", file=sys.stderr)
            return 2
        if source_fund != os.path.basename(source_fund) or ".." in source_fund or "_" in source_fund:
            print("invalid sourceFundCode", file=sys.stderr)
            return 2
        # 会社・版種は作成先と同じ。基準日(ファイル名の 3 番目のトークン)が最新のものを写す。
        best = None
        for name in os.listdir(templates_dir):
            if not name.lower().endswith(".html"):
                continue
            parts = name[: -len(".html")].split("_")
            if len(parts) != 4:
                continue
            c, f, d, e = parts
            if c.lower() == company.lower() and f == source_fund and e == edition:
                if best is None or d > best[0]:
                    best = (d, name)
        if best is None:
            print(f"source template not found: {source_fund}", file=sys.stderr)
            return 2
        with open(os.path.join(templates_dir, best[1]), encoding="utf-8") as fh:
            sys.stdout.write(fh.read())
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
