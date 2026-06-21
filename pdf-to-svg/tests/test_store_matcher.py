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
