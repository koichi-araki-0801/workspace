# -*- coding: utf-8 -*-
"""pie-chart 利用手引き向けの図版（生成 SVG 例・ビューア画面）自動取得ハーネス。

`pie-chart/out/svg_js/` の生成済み SVG から代表 2 件を PNG 化し、`out/compare.html`
ビューアの実画面を撮影して `docs/pie-chart/images/` へ出力する。事前に
`pnpm --filter pie-chart run batch`（または pie-chart/ で `npm run batch`）で
`out/` を生成しておくこと（本スクリプトは pie-chart/ 配下へ一切書き込まない）。

ラスタライズ・撮影の定型部（launch/コンテキスト/解像度規約）は `docs/_build/shot.py` に
集約されたものを使う（導入済み Playwright(chromium) 再利用）。
"""
from __future__ import annotations

import pathlib
import sys

# リポジトリルートからの相対解決 (このファイルは <repo>/docs/pie-chart/_build/ にある)。
REPO = pathlib.Path(__file__).resolve().parents[3]
OUT_DIR = REPO / "pie-chart" / "out"
IMAGES = REPO / "docs" / "pie-chart" / "images"

# 共通撮影ヘルパ (docs/_build/shot.py) を import 可能にする。
sys.path.insert(0, str(REPO / "docs" / "_build"))
import shot  # noqa: E402

# 代表サンプル: シンプル（少数スライス・素直な配置）と高密度（小スライス多数で
# 引出線・長体・flip 等の自動調整が効く）を対で見せる。
SAMPLES = [
    ("asset_4slice_simple.svg", "sample_simple.png"),
    ("asset_many_small_12.svg", "sample_dense.png"),
]


def main() -> int:
    missing = [s for s, _ in SAMPLES if not (OUT_DIR / "svg_js" / s).exists()]
    if missing or not (OUT_DIR / "compare.html").exists():
        print("out/ が未生成です。先に `npm run batch` を実行してください:", missing)
        return 1

    IMAGES.mkdir(parents=True, exist_ok=True)
    with shot.chromium() as browser:
        # ---- 生成 SVG 例 (600x450 の viewBox 実寸で切り出し) ----
        for src, dst in SAMPLES:
            shot.capture(
                browser, (OUT_DIR / "svg_js" / src).resolve().as_uri(),
                600, 450, IMAGES / dst, selector="svg",
            )
            print("  saved", dst)

        # ---- compare.html ビューア (先頭ページが見える範囲を撮影) ----
        shot.capture(
            browser, (OUT_DIR / "compare.html").resolve().as_uri(),
            1280, 880, IMAGES / "viewer.png",
        )
        print("  saved viewer.png")
    print("done.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
