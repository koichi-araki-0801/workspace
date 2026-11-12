#!/usr/bin/env python3
"""テスト・e2e 用の偽の create_report.py。本番は REPORT_SCRIPT で本物を指す。

呼び出し元は editor/server/src/generate/createReport.ts。本物と同じ約束で動く。
- 引数: <委託会社コード> <ファンド> <基準日 yyyy-mm-dd> <版種> <フラグ...>
  委託会社コードは受け取るだけで使わない。フラグは次の 4 つの形だけ。ほかは exit 2。
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
- --pdf-only --fund-only(単独): filled/<id>.html が無ければ exit 3。あれば読んだときの
  `HEAD:filled/<id>.html` の blob を覚え、記録されていない変更の検査(filled だけ)の後にもう一度
  blob を引く。どちらかで止まるなら(変更あり・blob が変わった)何も書かずに exit 4。blob を比べるのは、
  読んだ後に承認が filled をコミットすると作業ツリーは clean のままで、書き戻すと承認した内容が
  消えるため。通れば filled を同じ内容で書き戻し、`%PDF-1.4` で始まる
  最小の PDF を pdf/<id>.pdf に書く(どちらも一時ファイル経由)。.git が無ければ警告して書くだけ。
  有れば pdf/<id>.pdf の `text` 属性が unset でなければ exit 5(コミットしない)。2 つを同じ
  作者・1 コミットで記録する(作業ツリーが HEAD と同じなら何もしない。index では比べない)。
- --pdf-only --fund-only --from-editor: 標準入力の HTML を読み(空なら exit 3)、最小の PDF を
  標準出力へ書く。dataRoot には何も書かない。

- 起動のたびに、dataRoot の親フォルダの `report-calls.log` へ引数を 1 行足す(e2e が「走らなかった」
  ことを確かめる用。dataRoot の中に置くと git の記録に混ざる)。

テスト用の環境変数:
- FAKE_REPORT_COMMIT_BEFORE_WRITE: --pdf-only 単独で、記録されていない変更の検査の直後に、値を
  filled/<id>.html に書いて approver@editor.local の作者でコミットする(読んでから書くまでの間に
  承認が入った場合の再現用。本物には無い)。
- FAKE_REPORT_UNSTAGE_AFTER_ADD: 最初の `git add` の直後に、値のパスを `git reset` でステージから外す
  (editor の承認がコミットの前にステージを外す場合の再現用。本物には無い)。

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
EXIT_USAGE = 2
EXIT_NO_INPUT = 3
EXIT_UNRECORDED_CHANGE = 4
EXIT_COMMIT_FAILED = 5
COMMIT_BEFORE_WRITE_ENV = "FAKE_REPORT_COMMIT_BEFORE_WRITE"
UNSTAGE_AFTER_ADD_ENV = "FAKE_REPORT_UNSTAGE_AFTER_ADD"
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


def _git(
    args: list[str], cwd: str, hooks_dir: str, user: str, email: str | None = None
) -> subprocess.CompletedProcess:
    """リポジトリ側から子プロセスを起こす口を切って git を呼ぶ。email の既定は単独の実行の印。"""
    email = email or f"{user}@create_report.local"
    env = dict(os.environ)
    env.update(
        GIT_AUTHOR_NAME=user,
        GIT_AUTHOR_EMAIL=email,
        GIT_COMMITTER_NAME=user,
        GIT_COMMITTER_EMAIL=email,
    )
    cmd = [
        os.environ.get("GIT_BIN") or "git",
        "-c", f"user.name={user}",
        "-c", f"user.email={email}",
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


def _head_blob(data_root: str, rel: str, hooks_dir: str, user: str) -> str:
    """`HEAD:<rel>` の blob の hash。HEAD かそのパスの記録が無ければ空文字。"""
    got = _git(["rev-parse", "--verify", "-q", f"HEAD:{rel}"], data_root, hooks_dir, user)
    return got.stdout.strip() if got.returncode == 0 else ""


def _read_blob(data_root: str, rel: str) -> str | None:
    """読んだときの `HEAD:<rel>` の blob。.git が無ければ None(記録が無いので比べない)。"""
    if not os.path.exists(os.path.join(data_root, ".git")):
        return None
    with tempfile.TemporaryDirectory() as hooks_dir:
        return _head_blob(data_root, rel, hooks_dir, getpass.getuser())


def _commit_as_approver(data_root: str, rel: str, body: str, hooks_dir: str) -> None:
    """読んでから書くまでの間の承認を再現する(FAKE_REPORT_COMMIT_BEFORE_WRITE のテスト専用)。"""
    _write_atomic(os.path.join(data_root, *rel.split("/")), body.encode("utf-8"))
    approver = ("approver", "approver@editor.local")
    _git(["add", "--", rel], data_root, hooks_dir, *approver)
    _git(
        ["commit", "--no-verify", "-q", "-m", "approve", "--", rel], data_root, hooks_dir, *approver
    )


def _same_as_head(data_root: str, rels: list[str], hooks_dir: str, user: str) -> bool:
    """作業ツリーの rels がすべて HEAD の記録と同じか(記録するものが無いか)。

    index は見ない。editor の承認はコミットの前に許可リストの外のステージを外すので、
    `git diff --cached` で比べると、外された PDF を「同じ」と読んで記録を飛ばしてしまう。
    `git diff HEAD` は HEAD に無いパスを比べないので、HEAD に無いパス(初回の PDF・HEAD が
    まだ無い)は先に「違う」とする。
    """
    for rel in rels:
        if not _head_blob(data_root, rel, hooks_dir, user):
            return False
    diff = _git(["diff", "--quiet", "HEAD", "--", *rels], data_root, hooks_dir, user)
    return diff.returncode == 0


def _all_in_index(data_root: str, rels: list[str], hooks_dir: str, user: str) -> bool:
    """rels がすべて index に載っているか(git に知られたパスか)。"""
    got = _git(["ls-files", "--error-unmatch", "--", *rels], data_root, hooks_dir, user)
    return got.returncode == 0


def _record_standalone(
    data_root: str,
    report_id: str,
    files: list[tuple[str, bytes]],
    binary_rels: list[str],
    read_blob: str | None = None,
) -> int:
    """files(相対パスと中身の並び)を順に書き、1 コミットにする。

    記録されていない変更の検査は files[0] だけに掛ける(後ろは生成物で、未追跡でも止めない)。
    binary_rels は `text` 属性が unset であること(改行変換されないこと)を確かめるパス。
    read_blob は files[0] を読んだときの `HEAD:` の blob。None でなければ、書く直前の blob と
    違うとき何も書かずに exit 4 で止まる。
    """
    rels = [rel for rel, _ in files]

    def write_all() -> None:
        for rel, body in files:
            _write_atomic(os.path.join(data_root, *rel.split("/")), body)

    if not os.path.exists(os.path.join(data_root, ".git")):
        print("警告: dataRoot に .git が無いため、git に記録しません", file=sys.stderr)
        write_all()
        return 0

    user = getpass.getuser()
    with tempfile.TemporaryDirectory() as hooks_dir:
        status = _git(["status", "--porcelain", "--", rels[0]], data_root, hooks_dir, user)
        if status.returncode != 0 or status.stdout.strip():
            print("editor の承認の途中か、記録されていない変更があります", file=sys.stderr)
            return EXIT_UNRECORDED_CHANGE if status.returncode == 0 else EXIT_COMMIT_FAILED
        approved = os.environ.get(COMMIT_BEFORE_WRITE_ENV)
        if approved is not None:
            _commit_as_approver(data_root, rels[0], approved, hooks_dir)
        if read_blob is not None and _head_blob(data_root, rels[0], hooks_dir, user) != read_blob:
            print(f"{rels[0]} が読んだ後にコミットされました(承認が入った)", file=sys.stderr)
            return EXIT_UNRECORDED_CHANGE
        write_all()
        for rel in binary_rels:
            attr = _git(["check-attr", "text", "--", rel], data_root, hooks_dir, user)
            if attr.returncode != 0 or not attr.stdout.strip().endswith(": text: unset"):
                print(
                    f"{rel} が binary 扱いではありません(.gitattributes の *.pdf binary が必要)",
                    file=sys.stderr,
                )
                return EXIT_COMMIT_FAILED
        if _same_as_head(data_root, rels, hooks_dir, user):
            return 0
        message = f"create_report（単独）で {report_id} を生成"
        last = ""
        for attempt in range(LOCK_RETRIES):
            if attempt:
                time.sleep(LOCK_WAIT_SECONDS)
            added = _git(["add", "--", *rels], data_root, hooks_dir, user)
            if added.returncode != 0:
                last = added.stderr
                if "index.lock" not in last:
                    break
                continue
            unstage = os.environ.get(UNSTAGE_AFTER_ADD_ENV)
            if unstage and attempt == 0:
                _git(["reset", "-q", "--", unstage], data_root, hooks_dir, user)
            done = _git(
                ["commit", "--no-verify", "--only", "-m", message, "--", *rels],
                data_root, hooks_dir, user,
            )
            if done.returncode == 0:
                return 0
            last = done.stderr or done.stdout
            # editor の承認が add の後にステージを外すと、新しいファイルは git に知られていない
            # パスになり `commit --only` が失敗する。そのときも add からやり直す。
            if "index.lock" not in last and _all_in_index(data_root, rels, hooks_dir, user):
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
        return _record_standalone(data_root, report_id, [(f"filled/{report_id}.html", body)], [])

    filled = os.path.join(data_root, "filled", f"{report_id}.html")
    if not os.path.isfile(filled):
        print(f"filled/{report_id}.html がありません", file=sys.stderr)
        return EXIT_NO_INPUT
    filled_rel = f"filled/{report_id}.html"
    read_blob = _read_blob(data_root, filled_rel)
    with open(filled, "rb") as f:
        filled_body = f.read()
    # filled を同じ内容で書き戻してから pdf を書く。本物と同じく 2 つを 1 コミットにする
    return _record_standalone(
        data_root,
        report_id,
        [(filled_rel, filled_body), (f"pdf/{report_id}.pdf", MIN_PDF)],
        [f"pdf/{report_id}.pdf"],
        read_blob,
    )


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
