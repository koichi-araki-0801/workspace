"""`dictionary.store.DictionaryStore` の単体テスト。

追加・引き当て (正規化込みの `lookup`)・`upsert`・無効化・JSON 取り込みの往復と、
**壊れた辞書ファイルで起動不能にならないこと** (旧 P035) を確認する。
"""
from dictionary.store import DictionaryStore


def make_store(tmp_path):
    return DictionaryStore(tmp_path / "d.json")


def test_add_and_lookup(tmp_path):
    s = make_store(tmp_path)
    s.add("Sales", "売上")
    assert s.lookup("Sales") == "売上"
    s.close()


def test_lookup_normalizes_fullwidth(tmp_path):
    s = make_store(tmp_path)
    s.add("ABC", "エービーシー")
    # 全角で引いても一致する
    assert s.lookup("ＡＢＣ") == "エービーシー"
    s.close()


def test_upsert_updates_existing(tmp_path):
    s = make_store(tmp_path)
    s.add("Qty", "数量")
    s.upsert("Qty", "個数")
    assert s.lookup("Qty") == "個数"
    assert len(s.all()) == 1
    s.close()


def test_disabled_not_matched(tmp_path):
    s = make_store(tmp_path)
    s.add("Total", "合計", enabled=False)
    assert s.lookup("Total") is None
    s.close()


def test_json_roundtrip(tmp_path):
    # 実体ファイルは共有 JSON と同形式なので、それを直接 import 元にできる。
    s = make_store(tmp_path)
    s.add("A", "あ")
    s.add("B", "い")
    s2 = DictionaryStore(tmp_path / "d2.json")
    n = s2.import_json(tmp_path / "d.json")
    assert (n.imported, n.skipped) == (2, 0)
    assert s2.lookup("A") == "あ"
    s.close()
    s2.close()


def test_lookup_wrap_matches_joined_entries_only(tmp_path):
    """`lookup_wrap` は連結由来 (joined=True) エントリのみ引く。`lookup` は両方引く。"""
    s = make_store(tmp_path)
    s.add("商品名称", "Product", joined=True)
    s.add("備考", "Note")  # 手入力相当 (非連結)
    assert s.lookup_wrap("商品名称") == "Product"
    assert s.lookup_wrap("備考") is None       # 非連結エントリは連結照合に使わない
    assert s.lookup("備考") == "Note"          # 単独照合では従来どおり引ける
    s.close()


def test_joined_flag_persists_roundtrip(tmp_path):
    """joined フラグは実体ファイルの再読込・import の双方で保持される。"""
    s = make_store(tmp_path)
    s.add("商品名称", "Product", joined=True)
    # 実体ファイルの再読込 (同パスで開き直し)
    s2 = DictionaryStore(tmp_path / "d.json")
    assert s2.lookup_wrap("商品名称") == "Product"
    # 実体ファイル (共有 JSON と同形式) を別ストアへ import しても保持
    s3 = DictionaryStore(tmp_path / "d3.json")
    s3.import_json(tmp_path / "d.json")
    assert s3.lookup_wrap("商品名称") == "Product"
    s.close()
    s2.close()
    s3.close()


def test_legacy_json_without_joined_key(tmp_path):
    """旧形式 (joined キー無し) の JSON は非連結として読める (後方互換)。"""
    legacy = tmp_path / "legacy.json"
    legacy.write_text(
        '[{"source": "Total", "target": "合計", "enabled": true}]', encoding="utf-8"
    )
    s = DictionaryStore(legacy)
    assert s.lookup("Total") == "合計"
    assert s.lookup_wrap("Total") is None  # 連結照合の対象にはならない
    s.close()


# ── 旧 P035: 壊れた辞書ファイルで起動不能にしない ──────────────────────────

def test_broken_entry_is_skipped_instead_of_crashing_startup(tmp_path):
    """リストに dict 以外が混ざっても `__init__` を抜けない (以前は AttributeError)。

    `console=False` の exe では例外が画面に出ないため、辞書 1 要素の型崩れが
    「何も起きず起動しない」恒久 DoS になっていた。辞書はメール・共有フォルダ経由で
    配られる外部由来の入力なので、壊れた要素は捨てて起動を通す。
    """
    path = tmp_path / "d.json"
    path.write_text(
        '["oops", {"source": "A", "target": "\\u3042"}, 42, null,'
        ' {"source": 5, "target": "x"}, {"source": "B", "target": 9}]',
        encoding="utf-8",
    )

    s = DictionaryStore(path)

    assert s.lookup("A") == "あ"
    assert len(s.all()) == 1
    # 黙って消さない: 捨てた件数を利用者へ返す経路 (`rpc_dictList` → `app.js`)。
    assert s.load_skipped == 5
    assert s.load_failed is False
    s.close()


def test_unparsable_file_is_reported_rather_than_silently_empty(tmp_path):
    """壊れた JSON は空辞書で起動しつつ「読めなかった」を伝える (辞書消失に見せない)。"""
    path = tmp_path / "d.json"
    path.write_text("{ this is not json", encoding="utf-8")

    s = DictionaryStore(path)

    assert s.all() == []
    assert s.load_failed is True
    s.close()


def test_missing_file_is_not_reported_as_a_failure(tmp_path):
    """初回起動 (ファイル未作成) は異常ではない (通知を出さない)。"""
    s = DictionaryStore(tmp_path / "not-created-yet.json")
    assert s.load_failed is False and s.load_skipped == 0
    s.close()


def test_import_reports_skipped_broken_entries(tmp_path):
    """取り込みでも壊れた要素は捨てて件数を返す (画面が件数を出す)。"""
    src = tmp_path / "shared.json"
    src.write_text('[{"source": "A", "target": "あ"}, "oops", {"target": "空"}]',
                   encoding="utf-8")
    s = DictionaryStore(tmp_path / "d.json")

    result = s.import_json(src)

    assert (result.imported, result.skipped) == (1, 2)
    s.close()


def test_upsert_updates_joined(tmp_path):
    """連結取り込みで登録し直すと既存エントリの joined も更新される。"""
    s = make_store(tmp_path)
    s.add("商品名称", "Product")  # まず手入力 (非連結)
    assert s.lookup_wrap("商品名称") is None
    s.upsert("商品名称", "Product", joined=True)
    assert s.lookup_wrap("商品名称") == "Product"
    assert len(s.all()) == 1
    s.close()
