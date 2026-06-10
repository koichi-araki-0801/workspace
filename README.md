# PdfToSvg

PDF を編集可能な **SVG** に変換し、非エンジニアでも

1. **表ヘッダの用語統一・翻訳**（「元の語 → 置換後の語」を辞書登録し、開くたび自動適用）
2. **不要箇所のトリミング**（要素の選択削除＋矩形クロップ）

を行えるデスクトップツール。Windows で **.exe** として社内配布する前提。

---

## 特長

- **ベクター忠実**: PyMuPDF でテキスト/罫線/図形を構造化抽出し、各要素を SVG のまま編集。
- **本物の `<text>`**: 書き出した SVG のテキストはテキストのまま（後から検索・再編集可）。
- **辞書**: JSON ファイルで永続化（exe 隣の `data\dictionary.json`、ポータブル・C 非依存）。NFKC 正規化で全角半角差を吸収。手編集・共有可。
- **スキャン対応**: 画像主体ページはラスタ背景として SVG に埋め込み（ページ単位のクロップ等が可能）。

---

## かんたん操作（バッチ・ダブルクリック）

コマンド不要。リポジトリ直下の .bat をダブルクリックするだけ。

| バッチ | 役割 |
|---|---|
| **`run.bat`** | アプリを起動（exe を作らずソースから手軽に動かす） |
| **`build.bat`** | 依存導入 + `dist\PdfToSvg\PdfToSvg.exe` を生成 |
| **`make_installer.bat`** | 配布用 `Setup.exe` を生成（要 [Inno Setup](https://jrsoftware.org/isdl.php)） |

## 動かし方（開発・コマンド）

```powershell
# 依存インストール
python -m pip install -e .            # もしくは pip install PySide6 PyMuPDF Pillow
# 起動
python run.py
```

## 基本操作

| 操作 | 手順 |
|---|---|
| PDF を開く | ツールバー「開く…」 |
| ヘッダ自動置換 | 開くと辞書が自動適用（右パネルで「ヘッダのみ/全テキスト」切替・再適用） |
| 辞書に追加 | テキストを選択 →「選択を辞書に追加」→ 右パネルで置換後を入力して「追加」 |
| 要素を削除 | 選択ツールでドラッグ選択 → Delete |
| 矩形クロップ | 「クロップ」→ 残す範囲をドラッグ（外側は書き出し時に破棄） |
| クロップ解除 | 「クロップ解除」 |
| 元に戻す/やり直し | Ctrl+Z / Ctrl+Y |
| SVG 書き出し | 「このページを SVG 書出」/「全ページを SVG 書出」 |

---

## アーキテクチャ

```
PDF → engine(PyMuPDF抽出 + vector/scan判定) → model(Document/Page/Element)
   → dictionary(NFKC正規化 + ヘッダ検出 + 自動適用) 
   → editor(QGraphicsScene: 1要素=1Item, 選択/削除/クロップ) ……編集UI
   → export(model→SVG直接シリアライズ) ……出力
```

- **モデルが真実**。編集は scene からモデルへ書き戻し、SVG はモデルから直接書き出す
  （決定的・GUI 非依存でテスト可能・フォント名が崩れない）。
- 主要モジュール: `engine/pdf_engine.py`, `model/elements.py`, `editor/scene.py`,
  `export/svg_exporter.py`, `dictionary/apply.py`。

---

## テスト

```powershell
python -m pip install pytest
$env:QT_QPA_PLATFORM="offscreen"; python -m pytest
```

抽出→辞書適用→クロップ→SVG 書き出し、正規化、ストア照合、スキャン画像埋め込みを網羅。

---

## .exe ビルド

```powershell
python -m pip install pyinstaller
pyinstaller packaging/pdftosvg.spec --noconfirm
# 出力: dist/PdfToSvg/PdfToSvg.exe (onedir)
```

インストーラ（任意・Inno Setup）:

```powershell
& "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" packaging\installer.iss
# 出力: dist_installer/PdfToSvg-Setup-0.1.0.exe
```

---

## ライセンス注意

本ツールは **PyMuPDF (AGPL)** に依存する。**社内/身内限定の配布**を前提に採用している。
外部・商用配布が必要になった場合は、抽出部 `engine/pdf_engine.py`（薄い境界）を
BSD ライセンスの **pypdfium2** 等へ差し替えるか、Artifex の商用ライセンスを取得すること。
PySide6 は LGPL（動的リンクのため .exe 配布可）。
