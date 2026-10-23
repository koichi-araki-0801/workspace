# 社内ツールの実出力 SVG の見本

`svgInspect.tools.test.ts` が、ここにある SVG を全部 `inspectSvg` に通し、違反 0 件を要求する。
中身はツールの出力そのままで、手で直していない。

## pie-chart（生成元: workspace `be90401`）

`pie-chart/out/_baseline/` の同名ファイルをそのままコピーした。作り直すときは
`cd pie-chart && npm run batch` で `pie-chart/out/` を作り、同名ファイルを置き換える。

| ファイル | 性質 |
| --- | --- |
| `pie-chart/asset_2slice_split.svg` | スライスが少ない |
| `pie-chart/asset_11_mixed.svg` | スライスが多くラベルが混む。「その他」を含む |
| `pie-chart/asset_many_small_12.svg` | 小さいスライスが多い。「その他」を含む |

## pdf-to-svg（生成元: python-tools `f298d36`）

python-tools のクローン先の `pdf-to-svg` にある `test/fixtures/*.pdf` を、GUI を使わず変換関数
`page_to_svg`（既定の書き出し用設定）で SVG にした。python-tools の作業ツリーは変更しない。

```bash
cd <python-tools のクローン先>/pdf-to-svg
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src py -3.13 -W ignore -c "
import sys, glob, os
from engine.pdf_engine import load_document
from export.svg_exporter import page_to_svg
out = sys.argv[1]
for f in sorted(glob.glob('test/fixtures/*.pdf')):
    d = load_document(f)
    for i, p in enumerate(d.pages):
        n = os.path.splitext(os.path.basename(f))[0] + ('' if len(d.pages) == 1 else '_p%d' % (i + 1)) + '.svg'
        open(os.path.join(out, n), 'w', encoding='utf-8', newline='').write(page_to_svg(p))
" <一時フォルダ>
```

| ファイル | 入力 PDF | 性質 |
| --- | --- | --- |
| `pdf-to-svg/clipped_image_sample.svg` | `clipped_image_sample.pdf` | `clipPath` + 埋め込み画像 |
| `pdf-to-svg/ocr_layer_sample.svg` | `ocr_layer_sample.pdf` | OCR 層の文字 |
| `pdf-to-svg/qr_cells_sample.svg` | `qr_cells_sample.pdf` | QR のセル |
| `pdf-to-svg/scanned_sample.svg` | `scanned_sample.pdf` | スキャン画像 |
| `pdf-to-svg/stewardship_sample_p1.svg` | `stewardship_sample.pdf` 1 ページ目 | 日本語本文 + `data:font/woff2` の `@font-face` |

## 作り直し

ツールの出力が変わったら、上の手順で作り直して置き換え、
`pnpm --filter @editor/shared exec vitest run test/svgInspect.tools.test.ts` を流す。
落ちた場合は、画像が配置されず表示されなくなるので、検査かツールのどちらを直すか判断する。
