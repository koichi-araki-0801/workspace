#!/usr/bin/env python3
"""テスト・local 検証用の偽の生成器。本番は PY_GENERATE_SCRIPT で本物の build.py を指す。

呼び出し元は editor/server/src/generate/pyTemplate.ts。本番の生成器と同じ約束で動く。
- 引数(位置): Rep1 コード, ファンド, 基準日 [, コピー元ファンド [, 償還 '1']]
  コピー元が空文字('')なら無し。償還は受け取るだけで、出力は変えない。
- 略称は、LocalDB の検証 DB の Rep1 コード(00001→XX01、00002→XX02。web の
  LOCAL_REP1_COMPANY_CODES と同じ組)なら表で引き、無ければ先頭の `R-` を外したもの
  (sproc の偽の `R-<略称>` と対)、それも無ければコードそのまま。
- 書き先は <このスクリプトのフォルダ>/../output/<略称>_<ファンド>_<交付版|全体版>.html。
  一時ファイルに書いてから名前を変え、書きかけを残さない。標準出力には何も出さない。
- 実行ログは <このスクリプトのフォルダ>/../log/build_<Rep1>_<ファンド>_<基準日>.log に
  追記する。最初に `INFO args=<argv[1:] の JSON>`、書いた(と申告する)ファイルごとに
  `INFO [OUTPUT] <名前>` を 1 行ずつ。呼び出し元は、このログの [OUTPUT] 行を生成物の
  申告として読む。
- コピー元があれば、環境変数 TEMPLATES_DIR にある <略称>_<コピー元>_<版種>.html を両版写す
  (会社の大文字小文字は区別しない)。TEMPLATES_DIR が無い・コピー元が欠ければ何も書かず
  exit 2 で終わる。

テスト用の特別なファンドコード(通常の両版に加えて、または代えて):
- 999001: 組入先 999000 の両版も書く。
- 999002: 他社 ZZ99_999002_交付版.html も書く。
- 999003: 交付版しか書かない。
- 999004: 全体版をログに載せるが、ファイルは書かない。
"""
import json
import os
import sys

EDITIONS = ("交付版", "全体版")

# LocalDB の検証 DB の Rep1 コード → 略称。web の LOCAL_REP1_COMPANY_CODES(略称 → コード)の逆。
REP1_ABBREVIATIONS = {"00001": "XX01", "00002": "XX02"}


def _abbreviation(rep1: str) -> str:
    # 表にあればそれ、無ければ sproc の偽の `R-<略称>` から `R-` を外し、それも無ければそのまま。
    if rep1 in REP1_ABBREVIATIONS:
        return REP1_ABBREVIATIONS[rep1]
    return rep1[2:] if rep1.startswith("R-") else rep1


def _token_ok(value: str) -> bool:
    # ファイル名の 1 トークンとして安全か(区切り・パス・.. を含まない)。editor 側の検査と同じ意図。
    safe = value == os.path.basename(value) and ".." not in value and "_" not in value
    return bool(value) and safe


def _skeleton(company: str, fund: str, edition: str) -> str:
    return f"""<!doctype html>
<html lang="ja">
  <head>
    <meta charset="utf-8" />
    <title>{{{{ fund.name }}}} レポート</title>
    <link rel="stylesheet" href="../css/{company}_{fund}_{edition}.css" />
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


def write_output(out_dir: str, file_name: str, html: str) -> None:
    # 一時ファイル(.tmp。呼び出し元は .html しか拾わない)に書いてから名前を変える。
    # 失敗したら一時ファイルを消す(output/ に掃除されない残骸を置かない)。
    os.makedirs(out_dir, exist_ok=True)
    tmp = os.path.join(out_dir, f".{file_name}.{os.getpid()}.tmp")
    try:
        with open(tmp, "w", encoding="utf-8") as fh:
            fh.write(html)
        os.replace(tmp, os.path.join(out_dir, file_name))
    except BaseException:
        if os.path.exists(tmp):
            os.remove(tmp)
        raise


def _find_source(templates_dir: str, company: str, source_fund: str, edition: str):
    # テンプレートは 会社_ファンド_版種.html の 3 つ区切りだけを見る(会社の大小は区別しない)。
    for name in sorted(os.listdir(templates_dir)):
        if not name.endswith(".html"):
            continue
        parts = name[: -len(".html")].split("_")
        if len(parts) != 3:
            continue
        c, f, e = parts
        if c.lower() == company.lower() and f == source_fund and e == edition:
            return os.path.join(templates_dir, name)
    return None


def _plan(company: str, fund: str, source_fund: str, templates_dir: str):
    """書くファイルの一覧 [(名前, 中身)] と、ログに載せるだけの名前の一覧を返す。

    コピー元が欠けていれば None を返し、呼び出し側が何も書かずに終える。
    """
    writes: list[tuple[str, str]] = []
    if source_fund:
        for edition in EDITIONS:
            path = _find_source(templates_dir, company, source_fund, edition)
            if path is None:
                return None
            with open(path, encoding="utf-8") as fh:
                writes.append((f"{company}_{fund}_{edition}.html", fh.read()))
    else:
        editions = ("交付版",) if fund in ("999003", "999004") else EDITIONS
        for edition in editions:
            writes.append((f"{company}_{fund}_{edition}.html", _skeleton(company, fund, edition)))
        if fund == "999001":
            for edition in EDITIONS:
                name = f"{company}_999000_{edition}.html"
                writes.append((name, _skeleton(company, "999000", edition)))
        if fund == "999002":
            writes.append(("ZZ99_999002_交付版.html", _skeleton("ZZ99", fund, "交付版")))
    declared_only = [f"{company}_{fund}_全体版.html"] if fund == "999004" else []
    return writes, declared_only


def main() -> int:
    argv = sys.argv[1:]
    if len(argv) < 3:
        print("usage: <rep1> <fund> <baseDate> [<source> [1]]", file=sys.stderr)
        return 2
    rep1, fund, base_date = argv[0], argv[1], argv[2]
    source_fund = argv[3] if len(argv) > 3 else ""
    company = _abbreviation(rep1)

    tokens = [rep1, company, fund, base_date] + ([source_fund] if source_fund else [])
    if not all(_token_ok(t) for t in tokens):
        print("invalid arguments", file=sys.stderr)
        return 2

    templates_dir = os.environ.get("TEMPLATES_DIR")
    if source_fund and not templates_dir:
        print("TEMPLATES_DIR is required when a source fund is given", file=sys.stderr)
        return 2

    planned = _plan(company, fund, source_fund, templates_dir or "")
    if planned is None:
        print(f"source template not found: {source_fund}", file=sys.stderr)
        return 2
    writes, declared_only = planned

    base = os.path.dirname(os.path.abspath(__file__))
    out_dir = os.path.join(base, "..", "output")
    log_dir = os.path.join(base, "..", "log")
    os.makedirs(log_dir, exist_ok=True)
    log_path = os.path.join(log_dir, f"build_{rep1}_{fund}_{base_date}.log")
    args_json = json.dumps(argv, ensure_ascii=False, separators=(",", ":"))

    with open(log_path, "a", encoding="utf-8", newline="\n") as log:
        log.write(f"INFO args={args_json}\n")
        for name, html in writes:
            write_output(out_dir, name, html)
            log.write(f"INFO [OUTPUT] {name}\n")
        for name in declared_only:
            log.write(f"INFO [OUTPUT] {name}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
