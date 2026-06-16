# fonts/ — ワークスペース共有フォント

graph2 と pdf-to-svg が共用する同梱フォントの単一の置き場。各プロジェクトが個別に
バンドルせず、ここを参照する（重複と所在の分散を避ける）。すべて **SIL Open Font License 1.1**
で再配布可。

## 収録フォント

| ファイル | ファミリ | 字形/種別 | 形式 | ウェイト | ライセンス | 利用元 |
|---|---|---|---|---|---|---|
| `BIZUDPGothic-Regular.woff2` | BIZ UDPGothic | ゴシック（プロポーショナル） | WOFF2 | 400 | `OFL-BIZUDPGothic.txt` | graph2 / pdf-to-svg |
| `BIZUDPGothic-Bold.woff2` | BIZ UDPGothic | ゴシック（プロポーショナル） | WOFF2 | 700 | `OFL-BIZUDPGothic.txt` | graph2 / pdf-to-svg |
| `NotoSerifJP-VF.ttf` | Noto Serif JP | 明朝（可変フォント・wght 軸） | TTF(VF) | 100–900 | `OFL-NotoSerifJP.txt` | pdf-to-svg |

BIZ ゴシックは **BIZ UDPGothic（プロポーショナル）に統一**した（旧 pdf-to-svg は等幅
BIZ UDGothic TTF を使っていたが、graph2 と同一字形・形式へ寄せた）。

## 参照のしかた

- **graph2**（TypeScript）: `src/config.ts` の `embedFontPath` / `WEIGHT_FONT` が
  `../fonts/BIZUDPGothic-*.woff2`（`PROJECT_ROOT=graph2/` 基準）。`src/svg_export/font.ts` が
  subset-font で WOFF2 サブセット化し SVG に @font-face 埋め込み。グリフ幅オラクル
  `src/glyph_advance.ts` はこの WOFF2 から `scripts/gen_glyph_advance.ts`（`npm run gen:widths`）で生成。
- **pdf-to-svg**（Python）: `src/config.py` の `font_dir()` が解決（ソース時 = リポジトリ親の
  `fonts/`、frozen 時 = `_MEIPASS/fonts`）。`src/export/font_embed.py` が fontTools でサブセット化し
  WOFF2 埋め込み。PyInstaller は `packaging/pdftosvg.spec` の `datas` で `fonts/` を同梱。

## 注意

- graph2 の SVG 出力は byte-diff baseline で保証されるため、WOFF2 のバイトを変更したら
  `npm run gen:widths` 再生成 + `npm run batch` の byte-diff 確認が必須（[[graph2-refactor-verification]] 相当）。
- フォントを差し替え・追加する場合は本表とライセンスファイルも更新すること。
