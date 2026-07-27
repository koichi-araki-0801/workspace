"""`dictionary.store.DictionaryStore` の単体テスト。

追加・引き当て (正規化込みの `lookup`)・`upsert`・無効化・JSON 入出力の往復を確認する。
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
    mid = s.add("Total", "合計")
    s.update(mid, "Total", "合計", enabled=False)
    assert s.lookup("Total") is None
    s.close()


def test_json_roundtrip(tmp_path):
    s = make_store(tmp_path)
    s.add("A", "あ")
    s.add("B", "い")
    out = tmp_path / "dict.json"
    s.export_json(out)
    s2 = DictionaryStore(tmp_path / "d2.json")
    n = s2.import_json(out)
    assert n == 2
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
    """joined フラグは実体ファイル・export/import の双方で保持される。"""
    s = make_store(tmp_path)
    s.add("商品名称", "Product", joined=True)
    # 実体ファイルの再読込 (同パスで開き直し)
    s2 = DictionaryStore(tmp_path / "d.json")
    assert s2.lookup_wrap("商品名称") == "Product"
    # export → 別ストアへ import でも保持
    out = tmp_path / "shared.json"
    s2.export_json(out)
    s3 = DictionaryStore(tmp_path / "d3.json")
    s3.import_json(out)
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


def test_upsert_updates_joined(tmp_path):
    """連結取り込みで登録し直すと既存エントリの joined も更新される。"""
    s = make_store(tmp_path)
    s.add("商品名称", "Product")  # まず手入力 (非連結)
    assert s.lookup_wrap("商品名称") is None
    s.upsert("商品名称", "Product", joined=True)
    assert s.lookup_wrap("商品名称") == "Product"
    assert len(s.all()) == 1
    s.close()
