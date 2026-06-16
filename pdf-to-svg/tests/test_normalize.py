from dictionary.normalize import NormOptions, normalize


def test_nfkc_fullwidth_halfwidth():
    # 全角英数字 → 半角
    assert normalize("ＡＢＣ１２３") == "ABC123"


def test_trim_and_collapse_ws():
    assert normalize("  売上   高 ") == "売上 高"


def test_casefold_option():
    assert normalize("ABC", NormOptions(casefold=True)) == "abc"
    assert normalize("ABC") == "ABC"


def test_kana_fold_option():
    assert normalize("カタカナ", NormOptions(kana_fold=True)) == "かたかな"
