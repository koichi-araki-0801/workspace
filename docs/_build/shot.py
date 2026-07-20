# -*- coding: utf-8 -*-
"""Playwright(chromium) ラスタライズ・撮影の共通定型部。

`svg2png.py` / `docs/pie-chart/_build/capture_examples.py` /
`docs/pdf-to-svg/_build/capture_screens.py` が個別に持っていた
「launch → new_context(device_scale_factor=2) → goto → networkidle → screenshot」の作法を
集約する。解像度規約（`DEVICE_SCALE_FACTOR` = 印刷時ににじまない 2 倍）の変更を 1 箇所で
済ませるため。オフライン制約により依存は追加しない（playwright は導入済みのものを遅延
import）。サーバ起動・UI 操作などスクリプト固有の撮影本体は共通化しない。

使い方（`docs/_build` 以外から）: `sys.path.insert(0, str(<repo>/docs/_build))` 後に
`import shot`。同階層の `svg2png.py` はそのまま `import shot` できる。
"""
from __future__ import annotations

import contextlib
import pathlib

# 印刷時ににじまない解像度の規約値。全図版・撮影で共通（変更はここだけ）。
DEVICE_SCALE_FACTOR = 2


@contextlib.contextmanager
def chromium():
    """`sync_playwright()` + `chromium.launch()` の複合コンテキスト。browser を yield する。"""
    from playwright.sync_api import sync_playwright

    with sync_playwright() as p:
        browser = p.chromium.launch()
        try:
            yield browser
        finally:
            browser.close()


@contextlib.contextmanager
def page_context(browser, width: int, height: int):
    """規約解像度の new_context 済み page を yield する（goto は呼び出し側。
    `add_init_script` などナビゲーション前の仕込みを挟めるようにするため）。"""
    ctx = browser.new_context(
        viewport={"width": width, "height": height},
        device_scale_factor=DEVICE_SCALE_FACTOR,
    )
    try:
        yield ctx.new_page()
    finally:
        ctx.close()


def capture(browser, url: str, width: int, height: int,
            out: pathlib.Path, selector: str | None = None) -> None:
    """`url` を開き networkidle まで待って `out` へ PNG 撮影する一発ヘルパ。
    `selector` 指定時は要素単位（SVG 実寸ぴったりに切り出し、viewport の余白が混ざらない）。"""
    with page_context(browser, width, height) as page:
        page.goto(url)
        page.wait_for_load_state("networkidle")
        target = page.locator(selector) if selector else page
        target.screenshot(path=str(out))
