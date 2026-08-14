"""並行実装の drift 検出 — pdf-to-svg `src/web/` + `src/app.py` ⇔ graph-editor `app.py`。

2 つのローカル HTTP サーバは同一仕様の並行実装で、両プロジェクトの設計正典に「片方を変えたら
必ず両方」と書いてある。それでも**片側だけの変更は実際に起きた**: 接続の資源上限
(`REQUEST_TIMEOUT` / `MAX_CONNECTIONS` / linger 期限) は pdf-to-svg にだけ入り、Edge の
verbose ログ既定 OFF は graph-editor にだけ入った。申し送りではなく機械で落とすのが本ファイル
の役目である。

主張の形は**「同じ名前の定数が両方にあり、値が一致する」**。片方を変えれば必ず落ちるので、
「揃え忘れ」ではなく「揃えるか、揃えない理由を書いてこの表を直すか」の二択になる。
**新しい共有の決めごとを足したら、この表にも足すこと。**

同じ主張を graph-editor 側 (`test/test_parallel_impl_drift.py`) にも置いてある。CI は
`pnpm run ci:pdf-to-svg` / `ci:graph-editor` のように片側だけ走ることがあり、検査が片側に
しか無いと「変えた側の CI では落ちない」= 今回の drift がそのまま再発するためで、この複製は
意図的である。

graph-editor は実行時依存ゼロ (標準ライブラリのみ) なので、相手側の読み込みに追加の依存は
要らない (同梱資産の読み込みは `main()`/初回 GET の遅延読込で、import に副作用は無い)。
"""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

from web import origin_guard, server

GRAPH_EDITOR_DIR = Path(__file__).resolve().parents[2] / "graph-editor"

# graph-editor 側の `app.py` を読み込むときの別名。こちらにも `src/app.py` があり、素の
# `app` で読むと**どちらか一方が他方を上書きする**ため、必ず別名で読む。
_ALIAS = "labeleditor_app"


def _graph_editor_app():
    """graph-editor の `app.py` を別名で読み込む。同居していない配布形態では skip する。

    `sys.path` への追加は読み込みの間だけに限る (居座らせると以降の `import` が相手側を拾う)。
    """
    if _ALIAS in sys.modules:
        return sys.modules[_ALIAS]
    path = GRAPH_EDITOR_DIR / "app.py"
    if not path.exists():
        pytest.skip("graph-editor のソースが同居していない")
    sys.path.insert(0, str(GRAPH_EDITOR_DIR))
    try:
        spec = importlib.util.spec_from_file_location(_ALIAS, path)
        module = importlib.util.module_from_spec(spec)
        sys.modules[_ALIAS] = module
        try:
            spec.loader.exec_module(module)
        except BaseException:
            sys.modules.pop(_ALIAS, None)  # 半端な module を残さない
            raise
        return module
    finally:
        sys.path.remove(str(GRAPH_EDITOR_DIR))


# ── 認可・防御ヘッダ ──


def test_security_headers_and_token_transport_match():
    """防御ヘッダとセッショントークンの運び方が**逐語で一致**すること。

    `SECURITY_HEADERS` は 1 応答でも欠ければ frame 化の足がかりになる性質のもので、
    片側だけ緩めると「片方のアプリだけ守られていない」状態が黙って成立する。"""
    other = _graph_editor_app()
    assert origin_guard.SECURITY_HEADERS == other.SECURITY_HEADERS
    assert origin_guard.TOKEN_HEADER == other.TOKEN_HEADER
    assert origin_guard.TOKEN_QUERY == other.TOKEN_QUERY


def test_security_headers_are_attached_at_end_headers_on_both_sides():
    """付与の**やり方**まで一致すること (値の一致だけでは足りない)。

    値が同じでも「どこで載せるか」が違えば、片側だけ抜ける応答が生まれる。実際、両側とも
    自分で書いた送信経路 (`_send` / `_reject`) からの明示呼び出しだった頃は、基底クラスが
    直接返す応答 (`HEAD` → 501、長すぎるリクエスト行 → 414、その他 `send_error()`) に
    ヘッダが載っていなかった。**両側に同じ穴があったので値の照合では検出できない** —
    このテストはその形の drift を狙う。

    主張は「`end_headers()` を override して 1 応答 1 回だけ載せる」形であること。
    """
    other = _graph_editor_app()
    # クラス名は両側で揃っていない(pdf-to-svg=`GuardedHTTPRequestHandler` /
    # graph-editor=`GuardedHandler`)。揃えるべきは名前ではなく**付与のやり方**なので、
    # それぞれの基底ハンドラを名指しで取る。
    for mod, handler in (
        (origin_guard, origin_guard.GuardedHTTPRequestHandler),
        (other, other.GuardedHandler),
    ):
        # 基底のままではない = override している。
        assert "end_headers" in vars(handler), mod.__name__
        # 二重付与ガードのために応答の開始点も押さえている。
        assert "send_response_only" in vars(handler), mod.__name__


def test_guard_decision_table_matches():
    """判定表 (許可 Content-Type・Origin 不要メソッド) とログ・読み捨ての上限が一致すること。"""
    other = _graph_editor_app()
    assert origin_guard.ALLOWED_REQUEST_CONTENT_TYPES == other.ALLOWED_REQUEST_CONTENT_TYPES
    assert origin_guard.SAFE_METHODS == other.SAFE_METHODS
    assert origin_guard.REJECT_LOG_LIMIT == other.REJECT_LOG_LIMIT
    assert origin_guard._DRAIN_LIMIT == other._DRAIN_LIMIT


# ── 接続の資源上限 ──


def test_connection_resource_limits_match():
    """接続の資源上限が一致すること (今回の drift の本体)。

    - `REQUEST_TIMEOUT`: 無言の接続はガードに届かないので、ハンドラ側の期限だけが閉じられる。
    - `MAX_CONNECTIONS`: `ThreadingHTTPServer` は接続ごとに無制限にスレッドを起こす。
    - `_LINGER_TIMEOUT`: 拒否後の読み捨ての期限。**接続単位**で持つこと自体が仕様の一部で、
      per-recv に戻すと少しずつ送り続ける相手にスレッドを握られる (値の一致だけでは
      その退行を捕まえられないので、挙動は `test_resource_limits.py` 側が持つ)。
    """
    other = _graph_editor_app()
    assert server.REQUEST_TIMEOUT == other.REQUEST_TIMEOUT
    assert server.MAX_CONNECTIONS == other.MAX_CONNECTIONS
    assert origin_guard._LINGER_TIMEOUT == other._LINGER_TIMEOUT
    # 要求単位の絶対期限。per-recv タイムアウトを接続 (要求) 単位へ引き上げた本体で、
    # 片側だけ緩めると「ドリップに弱いのは片方だけ」の drift が黙って成立する。
    assert origin_guard.MAX_REQUEST_SECONDS == other.MAX_REQUEST_SECONDS
    # 定数を宣言しただけで配線し忘れる形 (`timeout` 未設定) をここで落とす。
    assert server.Handler.timeout == other.Handler.timeout == server.REQUEST_TIMEOUT


# ── Edge の起動引数 ──


def test_edge_launch_args_match_and_carry_no_logging_flags_by_default():
    """Edge 起動引数が一致し、**既定では logging 系フラグが 1 つも載らない**こと。

    verbose ログは `--app=` の URL (= セッショントークン) を書き込みうるうえ、既定プロファイル
    で開く設計上その記録は利用者の Edge セッション全体に及ぶ。既定 OFF が片側だけになると、
    その片側だけがトークンをディスクへ落とす可能性を抱え続ける。
    `--user-data-dir` / `--disable-gpu` は VDI クラッシュの実績があり (両正典の却下集)、
    どちらのプロジェクトでもどの経路でも付かないことを併せて固定する。
    """
    import app as ours

    other = _graph_editor_app()
    url = "http://127.0.0.1:5180/?token=SECRET-TOKEN"

    mine, theirs = ours._edge_launch_args("msedge.exe", url), other._edge_launch_args(
        "msedge.exe", url)
    assert mine == theirs
    for flag in ("--enable-logging", "--log-file", "--v=", "--user-data-dir", "--disable-gpu"):
        assert flag not in " ".join(mine)

    # opt-in 時に足す 3 フラグの並びも揃える (片側だけ `--v=2` 等になると診断の量が食い違う)。
    opted_in = ours._edge_launch_args("msedge.exe", url, "L.log")
    assert opted_in == other._edge_launch_args("msedge.exe", url, "L.log")
    assert opted_in[-3:] == ["--enable-logging", "--log-file=L.log", "--v=1"]

    # ログの保持上限・ファイル名・環境変数の読み方も同一 (環境変数**名**だけがプロジェクト固有)。
    assert ours.EDGE_LOG_MAX_BYTES == other.EDGE_LOG_MAX_BYTES
    assert ours.EDGE_LOG_NAME == other.EDGE_LOG_NAME
    assert ours._FALSY_ENV_VALUES == other._FALSY_ENV_VALUES
    assert ours.EDGE_LOG_ENV != other.EDGE_LOG_ENV


# ── 可変状態の置き場 (F43) ──


def test_mutable_state_stays_out_of_the_program_directory(monkeypatch, tmp_path):
    """可変状態の置き場の決定 (F43) が両実装で揃っていること。

    exe を共有フォルダ・ネットワークドライブへ置く配布で可変状態 (診断ログ等) を exe 隣へ
    書くと、複数人の同時起動が `startup.log` を共同追記して記録が混ざるうえ、プログラム
    フォルダの書き込み可能要件が DLL 差し替え (CWE-427) の温床になる。両実装とも frozen 時は
    ユーザー専用領域 (`%LOCALAPPDATA%/<App>/data`) を最優先し、書けない端末だけ exe 隣へ
    落とす。graph-editor に可搬インストール継続マーカー (pdf-to-svg の `dictionary.json`
    判定) が無いのは、失って困る利用者データを持たない (診断ログのみ) ための**意図した差分**。
    """
    import config

    other = _graph_editor_app()
    local = tmp_path / "LocalAppData"
    exe_dir = tmp_path / "exe"
    exe_dir.mkdir()
    monkeypatch.setenv("LOCALAPPDATA", str(local))
    monkeypatch.delenv("APPDATA", raising=False)
    monkeypatch.delenv(config.ENV_DATA_DIR, raising=False)
    monkeypatch.delenv(other.DATA_DIR_ENV, raising=False)

    monkeypatch.setattr(config, "is_frozen", lambda: True)
    monkeypatch.setattr(config, "app_base_dir", lambda: exe_dir)
    assert config._resolve_data_dir() == local / "PdfToSvg" / "data"

    monkeypatch.setattr(other, "_is_frozen", lambda: True)
    monkeypatch.setattr(other, "_app_base_dir", lambda: str(exe_dir))
    assert Path(other._data_dir()) == local / "LabelEditor" / "data"

    # 明示指定の環境変数は**名前だけ**がプロジェクト固有 (Edge ログ env と同じ運用)。
    assert config.ENV_DATA_DIR != other.DATA_DIR_ENV
    # どちらも exe 隣には何も作っていない (ユーザー領域が使える限り触らない)。
    assert not (exe_dir / "data").exists()
