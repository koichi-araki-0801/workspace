# -*- coding: utf-8 -*-
"""全プロジェクトの原稿（`docs/<project>/src/`）を一括で成果物へ生成する。

2 系統を拡張子で振り分ける（登録表は持たず自動発見）:
  - `*.md`        → `md2docx`（流れる文書: 操作手順書・設計書・配布運用手順書 → Word .docx）
  - `*.xlsx.yaml` → `md2xlsx`（表が主役: 画面項目定義・入出力定義・DB 定義・テスト仕様 → Excel .xlsx）

各原稿のフロントマター / 先頭メタ `out` が出力名。画像基準は既定で `docs/<project>/images/`
（.md は原稿側 `images:` で上書き可）。

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
import md2xlsx

DOCS = pathlib.Path(__file__).resolve().parents[1]   # <repo>/docs
SKIP_DIRS = {"_build"}


def discover():
    """`docs/<project>/src/` の `*.md` と `*.xlsx.yaml` を (project, src_path) で列挙する。"""
    for proj in sorted(DOCS.iterdir()):
        if not proj.is_dir() or proj.name in SKIP_DIRS:
            continue
        src = proj / "src"
        if not src.is_dir():
            continue
        for path in sorted(src.glob("*.md")):
            yield proj, path
        for path in sorted(src.glob("*.xlsx.yaml")):
            yield proj, path


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--project", help="対象プロジェクト名（docs 直下のフォルダ名）")
    ap.add_argument("--only", help="原稿ファイル名に含まれる語で絞り込み（例: 設計書）")
    args = ap.parse_args(argv)

    warnings: list[str] = []
    built = 0
    failed = 0
    for proj, src in discover():
        if args.project and proj.name != args.project:
            continue
        if args.only and args.only not in src.name:
            continue
        img_dir = proj / "images"
        try:
            if src.name.endswith(".xlsx.yaml"):
                spec = md2xlsx.parse_yaml(src.read_text(encoding="utf-8"))
                out_name = spec.get("out") or src.name[: -len(".yaml")]
                md2xlsx.build_workbook(spec, proj / out_name)
            else:
                meta, _ = md2docx._parse_frontmatter(src.read_text(encoding="utf-8"))
                out_name = meta.get("out") or (src.stem + ".docx")
                md2docx.render(src, proj / out_name, img_dir, warnings=warnings)
            built += 1
            print(f"  [ok] {proj.name}/{out_name}")
        except Exception as exc:  # noqa: BLE001 - 1 文書の失敗で全体を止めない
            failed += 1
            print(f"  [NG] {proj.name}/{src.name}: {exc}")

    print(f"\n生成 {built} 件" + (f" / 失敗 {failed} 件" if failed else ""))
    if warnings:
        print("警告:")
        for w in warnings:
            print(f"  - {w}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
