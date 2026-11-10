#!/usr/bin/env python3
"""テスト・e2e 用の偽の create_report.py。本番は REPORT_SCRIPT で本物を指す。

呼び出し元は editor/server/src/generate/createReport.ts。本物と同じ約束で動く。
- 引数: <委託会社コード> <ファンド> <基準日 yyyy-mm-dd> <版種> (--html-only | --pdf-only) --fund-only
  位置引数 4 つとフラグ 2 つ。委託会社コードは受け取るだけで使わない。
- dataRoot は環境変数 TEMPLATES_DIR の親フォルダとする。本物は dataRoot を自分の設定で持ち、
  editor からは渡されない。親を取るのはこのフェイクだけの都合。
- 会社略称は dataRoot の templates/ にある `*_<ファンド>_<版種>.html` から取る。無ければ exit 2。
- --html-only: templates/ のスケルトンの本文を、
  filled/<略称>_<ファンド>_<yyyymmdd>_<版種>.html へ写す(一時ファイル経由で名前を変える)。
- --pdf-only: pdf-input/<id>.html があることを確かめ(無ければ exit 3)、`%PDF-1.4` で始まる
  最小の PDF を pdf/<id>.pdf に書く。HTML の中身は読まない。
- 標準出力には何も出さない。
- 起動のたびに、dataRoot の親フォルダの `report-calls.log` へ引数を 1 行足す(e2e が「走らなかった」
  ことを確かめる用。dataRoot の中に置くと git の記録に混ざる)。

テスト用の特別なファンドコード:
- 999101: exit 1(失敗)。
- 999102: 30 秒眠る(時間切れの確認用)。
- 999103: 何も書かず exit 0(出力が無い場合の確認用)。
"""
import glob
import os
import sys
import time

FAIL_FUND = "999101"
SLEEP_FUND = "999102"
NO_OUTPUT_FUND = "999103"
SLEEP_SECONDS = 30

MIN_PDF = b"%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n"


def _write_atomic(path: str, data: bytes) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f"{path}.tmp-{os.getpid()}"
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, path)


def _log_call(argv: list[str]) -> None:
    templates = os.environ.get("TEMPLATES_DIR")
    if not templates:
        return
    data_root = os.path.dirname(os.path.normpath(templates))
    with open(os.path.join(os.path.dirname(data_root), "report-calls.log"), "a", encoding="utf-8") as f:
        f.write(" ".join(argv) + "\n")


def _abbreviation(templates: str, fund: str, edition: str) -> str | None:
    suffix = f"_{fund}_{edition}.html"
    found = next(iter(sorted(glob.glob(os.path.join(templates, f"*{suffix}")))), None)
    if found is None:
        return None
    return os.path.basename(found)[: -len(suffix)]


def main(argv: list[str]) -> int:
    if len(argv) != 6 or argv[4] not in ("--html-only", "--pdf-only") or argv[5] != "--fund-only":
        print("usage: fake_create_report.py REP1 FUND YYYY-MM-DD EDITION (--html-only|--pdf-only) --fund-only", file=sys.stderr)
        return 64
    _rep1, fund, iso, edition, flag, _ = argv
    _log_call(argv)
    if fund == FAIL_FUND:
        print("fake create_report: 失敗を模擬します", file=sys.stderr)
        return 1
    if fund == SLEEP_FUND:
        time.sleep(SLEEP_SECONDS)
        return 0
    if fund == NO_OUTPUT_FUND:
        return 0

    templates = os.environ.get("TEMPLATES_DIR")
    if not templates:
        print("TEMPLATES_DIR が未設定です", file=sys.stderr)
        return 2
    data_root = os.path.dirname(os.path.normpath(templates))
    abbreviation = _abbreviation(templates, fund, edition)
    if abbreviation is None:
        print(f"templates/ に *_{fund}_{edition}.html がありません", file=sys.stderr)
        return 2
    report_id = f"{abbreviation}_{fund}_{iso.replace('-', '')}_{edition}"

    if flag == "--html-only":
        with open(os.path.join(templates, f"{abbreviation}_{fund}_{edition}.html"), "rb") as f:
            body = f.read()
        _write_atomic(os.path.join(data_root, "filled", f"{report_id}.html"), body)
        return 0

    if not os.path.isfile(os.path.join(data_root, "pdf-input", f"{report_id}.html")):
        print(f"pdf-input/{report_id}.html がありません", file=sys.stderr)
        return 3
    _write_atomic(os.path.join(data_root, "pdf", f"{report_id}.pdf"), MIN_PDF)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
