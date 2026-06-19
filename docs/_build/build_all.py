# -*- coding: utf-8 -*-
"""全プロジェクトの Markdown 原稿（`docs/<project>/src/*.md`）を一括で .docx 生成する。

原稿は自動発見する（登録表を別に持たない）。各原稿のフロントマター `out` が出力 .docx 名、
画像基準は既定で `docs/<project>/images/`（原稿側 `images:` で上書き可）。

使い方:
  python docs/_build/build_all.py                 全プロジェクト・全文書
  python docs/_build/build_all.py --project editor 指定プロジェクトのみ
  python docs/_build/build_all.py --only 設計書    ファイル名に該当する原稿のみ
"""
from __future__ import annotations

import argparse
import pathlib
import sys

import md2docx

DOCS = pathlib.Path(__file__).resolve().parents[1]   # <repo>/docs
SKIP_DIRS = {"_build"}


def discover():
    """`docs/<project>/src/*.md` を (project, md_path) で列挙する。"""
    for proj in sorted(DOCS.iterdir()):
        if not proj.is_dir() or proj.name in SKIP_DIRS:
            continue
        src = proj / "src"
        if not src.is_dir():
            continue
        for md in sorted(src.glob("*.md")):
            yield proj, md


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--project", help="対象プロジェクト名（docs 直下のフォルダ名）")
    ap.add_argument("--only", help="原稿ファイル名に含まれる語で絞り込み（例: 設計書）")
    args = ap.parse_args(argv)

    warnings: list[str] = []
    built = 0
    failed = 0
    for proj, md in discover():
        if args.project and proj.name != args.project:
            continue
        if args.only and args.only not in md.name:
            continue
        meta, _ = md2docx._parse_frontmatter(md.read_text(encoding="utf-8"))
        out_name = meta.get("out") or (md.stem + ".docx")
        out_path = proj / out_name
        img_dir = proj / "images"
        try:
            md2docx.render(md, out_path, img_dir, warnings=warnings)
            built += 1
            print(f"  [ok] {proj.name}/{out_name}")
        except Exception as exc:  # noqa: BLE001 - 1 文書の失敗で全体を止めない
            failed += 1
            print(f"  [NG] {proj.name}/{md.name}: {exc}")

    print(f"\n生成 {built} 件" + (f" / 失敗 {failed} 件" if failed else ""))
    if warnings:
        print("警告:")
        for w in warnings:
            print(f"  - {w}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
