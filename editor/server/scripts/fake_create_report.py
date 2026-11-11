#!/usr/bin/env python3
"""テスト・e2e 用の偽の create_report.py。本番は REPORT_SCRIPT で本物を指す。

呼び出し元は editor/server/src/generate/createReport.ts。本物と同じ約束で動く。
- 引数: <委託会社コード> <ファンド> <基準日 yyyy-mm-dd> <版種> <フラグ...>
  委託会社コードは受け取るだけで使わない。フラグは次の 4 つの形だけ。ほかは exit 64。
  --from-editor は「入出力と git の記録を editor が受け持つ」の意味。
- dataRoot は環境変数 TEMPLATES_DIR の親フォルダとする。本物は dataRoot を自分の設定で持ち、
  editor からは渡されない。親を取るのはこのフェイクだけの都合。
- 会社略称は dataRoot の templates/ にある `*_<ファンド>_<版種>.html` から取る。無ければ exit 2。

4 つの形:
- --html-only --fund-only --from-editor: templates/ のスケルトンを
  filled/<略称>_<ファンド>_<yyyymmdd>_<版種>.html へ写す(一時ファイル経由)。git に触らない。
- --html-only --fund-only(単独): 同じ内容を一時ファイルに組み、dataRoot に .git が無ければ警告して
  書くだけ。有れば filled/<id>.html に記録されていない変更がある場合は書かずに exit 4。無ければ名前を
  変えて、そのファイル 1 つだけを `<名前>@create_report.local` の作者でコミットする。
  コミットの失敗は exit 5(HTML は書いたまま)。git の場所は環境変数 GIT_BIN(無ければ git)。
- --pdf-only --fund-only(単独): filled/<id>.html が無ければ exit 3。あれば `%PDF-1.4` で始まる
  最小の PDF を pdf/<id>.pdf に一時ファイル経由で書く。
- --pdf-only --fund-only --from-editor: 標準入力の HTML を読み(空なら exit 3)、最小の PDF を
  標準出力へ書く。dataRoot には何も書かない。

- 起動のたびに、dataRoot の親フォルダの `report-calls.log` へ引数を 1 行足す(e2e が「走らなかった」
  ことを確かめる用。dataRoot の中に置くと git の記録に混ざる)。

テスト用の特別なファンドコード:
- 999101: exit 1(失敗)。
- 999102: 30 秒眠る(時間切れの確認用)。
- 999103: 何も書かず exit 0(出力が無い場合の確認用)。
- 999104: --pdf-only --from-editor で、PDF でない `not a pdf` を標準出力へ書いて exit 0。
"""
import getpass
import glob
import os
import subprocess
import sys
import tempfile
import time

FAIL_FUND = "999101"
SLEEP_FUND = "999102"
NO_OUTPUT_FUND = "999103"
NOT_PDF_FUND = "999104"
SLEEP_SECONDS = 30
EXIT_USAGE = 64
EXIT_NO_INPUT = 3
EXIT_UNRECORDED_CHANGE = 4
EXIT_COMMIT_FAILED = 5
LOCK_RETRIES = 5
LOCK_WAIT_SECONDS = 0.3

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


_USAGE = (
    "usage: fake_create_report.py REP1 FUND YYYY-MM-DD EDITION"
    " (--html-only|--pdf-only) --fund-only [--from-editor]"
)
_FLAG_SETS = (
    ["--html-only", "--fund-only"],
    ["--html-only", "--fund-only", "--from-editor"],
    ["--pdf-only", "--fund-only"],
    ["--pdf-only", "--fund-only", "--from-editor"],
)


def _git(args: list[str], cwd: str, hooks_dir: str, user: str) -> subprocess.CompletedProcess:
    """リポジトリ側から子プロセスを起こす口を切って git を呼ぶ。"""
    env = dict(os.environ)
    env.update(
        GIT_AUTHOR_NAME=user,
        GIT_AUTHOR_EMAIL=f"{user}@create_report.local",
        GIT_COMMITTER_NAME=user,
        GIT_COMMITTER_EMAIL=f"{user}@create_report.local",
    )
    cmd = [
        os.environ.get("GIT_BIN") or "git",
        "-c", f"user.name={user}",
        "-c", f"user.email={user}@create_report.local",
        "-c", f"core.hooksPath={hooks_dir}",
        "-c", "core.fsmonitor=false",
        "-c", "commit.gpgSign=false",
        "-c", "core.quotepath=false",
        *args,
    ]
    try:
        return subprocess.run(
            cmd, cwd=cwd, env=env, capture_output=True, text=True, encoding="utf-8"
        )
    except OSError as e:
        return subprocess.CompletedProcess(cmd, 127, "", str(e))


def _record_standalone(data_root: str, report_id: str, body: bytes) -> int:
    rel = f"filled/{report_id}.html"
    target = os.path.join(data_root, "filled", f"{report_id}.html")
    os.makedirs(os.path.dirname(target), exist_ok=True)
    tmp = f"{target}.tmp-{os.getpid()}"
    with open(tmp, "wb") as f:
        f.write(body)

    if not os.path.exists(os.path.join(data_root, ".git")):
        print("警告: dataRoot に .git が無いため、git に記録しません", file=sys.stderr)
        os.replace(tmp, target)
        return 0

    user = getpass.getuser()
    with tempfile.TemporaryDirectory() as hooks_dir:
        status = _git(["status", "--porcelain", "--", rel], data_root, hooks_dir, user)
        if status.returncode != 0 or status.stdout.strip():
            os.remove(tmp)
            print("editor の承認の途中か、記録されていない変更があります", file=sys.stderr)
            return EXIT_UNRECORDED_CHANGE if status.returncode == 0 else EXIT_COMMIT_FAILED
        os.replace(tmp, target)
        message = f"create_report（単独）で {report_id} を生成"
        last = ""
        for attempt in range(LOCK_RETRIES):
            if attempt:
                time.sleep(LOCK_WAIT_SECONDS)
            added = _git(["add", "--", rel], data_root, hooks_dir, user)
            if added.returncode != 0:
                last = added.stderr
                if "index.lock" not in last:
                    break
                continue
            # 内容が HEAD と同じなら記録するものが無い(成功)
            same = _git(["diff", "--cached", "--quiet", "--", rel], data_root, hooks_dir, user)
            if same.returncode == 0:
                return 0
            done = _git(
                ["commit", "--no-verify", "--only", "-m", message, "--", rel],
                data_root, hooks_dir, user,
            )
            if done.returncode == 0:
                return 0
            last = done.stderr or done.stdout
            if "index.lock" not in last:
                break
        print(f"git のコミットに失敗しました: {last.strip()}", file=sys.stderr)
        return EXIT_COMMIT_FAILED


def main(argv: list[str]) -> int:
    if len(argv) < 4 or argv[4:] not in _FLAG_SETS:
        print(_USAGE, file=sys.stderr)
        return EXIT_USAGE
    _rep1, fund, iso, edition = argv[:4]
    html_only = argv[4] == "--html-only"
    from_editor = "--from-editor" in argv[4:]
    _log_call(argv)
    if fund == FAIL_FUND:
        print("fake create_report: 失敗を模擬します", file=sys.stderr)
        return 1
    if fund == SLEEP_FUND:
        time.sleep(SLEEP_SECONDS)
        return 0
    if fund == NO_OUTPUT_FUND:
        return 0

    if not html_only and from_editor:
        if fund == NOT_PDF_FUND:
            sys.stdout.buffer.write(b"not a pdf")
            return 0
        if not sys.stdin.buffer.read().strip():
            print("標準入力が空です", file=sys.stderr)
            return EXIT_NO_INPUT
        sys.stdout.buffer.write(MIN_PDF)
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

    if html_only:
        with open(os.path.join(templates, f"{abbreviation}_{fund}_{edition}.html"), "rb") as f:
            body = f.read()
        if from_editor:
            _write_atomic(os.path.join(data_root, "filled", f"{report_id}.html"), body)
            return 0
        return _record_standalone(data_root, report_id, body)

    if not os.path.isfile(os.path.join(data_root, "filled", f"{report_id}.html")):
        print(f"filled/{report_id}.html がありません", file=sys.stderr)
        return EXIT_NO_INPUT
    _write_atomic(os.path.join(data_root, "pdf", f"{report_id}.pdf"), MIN_PDF)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
