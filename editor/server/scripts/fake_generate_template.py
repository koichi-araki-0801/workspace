#!/usr/bin/env python3
"""テスト・local 検証用の偽の生成器。本番は PY_GENERATE_SCRIPT で既存の生成器を指す。

入出力の約束(呼び出し元は editor/server/src/generate/pyTemplate.ts):
- argv[1] は JSON: {companyCode, fundCode, editionType, sourceFundCode?, isRedemption?}
  (テンプレートは基準日を持たないので baseDate は来ない)
- 生成した Jinja2 テンプレート HTML を、環境変数 PENDING_DIR(サーバが config.pendingDir を渡す)の
  <会社コード>_<ファンドコード>_<版種>.html へ書く。一時ファイルに書いてから名前を変え、書きかけを
  残さない(失敗したら前のファイルはそのままにし、一時ファイルは消す)。標準出力には何も出さない。PENDING_DIR が無ければ
  エラーにする。

sourceFundCode があれば、環境変数 TEMPLATES_DIR(サーバが config.templatesDir を渡す)にある
コピー元のテンプレート <会社コード>_<sourceFundCode>_<版種>.html を写す(会社コードの大文字小文字は
区別しない。基準日の入った 4 つ区切りの名前は見ない)。TEMPLATES_DIR が無ければエラーにする。
isRedemption は受け取るだけ。
"""
import json
import os
import sys


def _token_ok(value: str) -> bool:
    # ファイル名の 1 トークンとして安全か(区切り・パス・.. を含まない)。editor 側の検査と同じ意図。
    return bool(value) and value == os.path.basename(value) and ".." not in value and "_" not in value


def write_output(pending_dir: str, file_name: str, html: str) -> None:
    # 一時ファイル(.tmp。editor の一覧は .html しか拾わない)に書いてから名前を変える。
    # 失敗したら一時ファイルを消す(pending/ に掃除されない残骸を置かない)。
    os.makedirs(pending_dir, exist_ok=True)
    tmp = os.path.join(pending_dir, f".{file_name}.{os.getpid()}.tmp")
    try:
        with open(tmp, "w", encoding="utf-8") as fh:
            fh.write(html)
        os.replace(tmp, os.path.join(pending_dir, file_name))
    except BaseException:
        if os.path.exists(tmp):
            os.remove(tmp)
        raise


def main() -> int:
    if len(sys.argv) < 2:
        print("missing attributes JSON", file=sys.stderr)
        return 2
    attrs = json.loads(sys.argv[1])
    company = attrs.get("companyCode", "")
    fund = attrs.get("fundCode", "")
    edition = attrs.get("editionType", "")
    source_fund = attrs.get("sourceFundCode")

    pending_dir = os.environ.get("PENDING_DIR")
    if not pending_dir:
        print("PENDING_DIR is required", file=sys.stderr)
        return 2
    if not (_token_ok(company) and _token_ok(fund) and _token_ok(edition)):
        print("invalid attributes", file=sys.stderr)
        return 2
    file_name = f"{company}_{fund}_{edition}.html"

    if source_fund:
        templates_dir = os.environ.get("TEMPLATES_DIR")
        if not templates_dir:
            print("TEMPLATES_DIR is required when sourceFundCode is given", file=sys.stderr)
            return 2
        if not _token_ok(source_fund):
            print("invalid sourceFundCode", file=sys.stderr)
            return 2
        # 会社・版種は作成先と同じ。テンプレートは 会社_ファンド_版種.html の 3 つ区切りだけを見る。
        for name in sorted(os.listdir(templates_dir)):
            if not name.lower().endswith(".html"):
                continue
            parts = name[: -len(".html")].split("_")
            if len(parts) != 3:
                continue
            c, f, e = parts
            if c.lower() == company.lower() and f == source_fund and e == edition:
                with open(os.path.join(templates_dir, name), encoding="utf-8") as fh:
                    write_output(pending_dir, file_name, fh.read())
                return 0
        print(f"source template not found: {source_fund}", file=sys.stderr)
        return 2

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
    write_output(pending_dir, file_name, html)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
