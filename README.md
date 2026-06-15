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

## 動かし方（開発・コマンド）

```powershell
# 依存インストール
python -m pip install -e .            # もしくは pip install PySide6 PyMuPDF Pillow
# 起動
python run.py
```

## 基本操作（4 ステップ・ウィザード）

UI は QWebEngineView で描画する Web UI（`resources/web/`）。複数 PDF を一括で扱い、
上部のステップバーに沿って 1→4 を進める。各ページは「要確認 / 確認済み / スキップ /
変更なし」の状態を持ち、未確認が残ると「次へ」で確認ガードバーが出る。

| ステップ | 内容 |
|---|---|
| **1. PDFを選ぶ** | ドロップゾーンをクリック→ファイル選択（複数可）。選んだ順に処理。 |
| **2. 用語を置換** | 開くと辞書を自動適用。左レールでページ移動、中央に実ページ、右「確認」タブで置換一覧（クリックで該当箇所をハイライト）。「辞書」タブで用語の追加・削除・「ヘッダのみ」切替・全ファイル再適用。 |
| **3. 不要範囲を削除** | 「選択」で要素をクリック選択→「削除」。「クロップ」で残す範囲をドラッグ（外側は書き出し時に破棄）。「クロップ解除」で取消。 |
| **4. SVGに書き出す** | 表示中ページのみ / 全ページ を選び書き出し（`元ファイル名_pN.svg`）。 |

元に戻す / やり直しは上部アイコンまたは Ctrl+Z / Ctrl+Y。

---

## アーキテクチャ

```
PDF → engine(PyMuPDF抽出 + vector/scan判定) → model(Document/Page/Element)
   → dictionary(NFKC正規化 + ヘッダ検出 + 自動適用)
   → export(model→SVG直接シリアライズ) ……出力 & 画面プレビュー
   ↑↓ web.bridge(QWebChannel) ←→ resources/web(QWebEngineViewのUI) ……編集UI
```

- **モデルが真実**。編集は Web UI から Bridge 経由で `QUndoCommand` を push してモデルを更新し、
  SVG はモデルから直接書き出す（決定的・GUI 非依存でテスト可能・フォント名が崩れない）。
- 画面のページ表示も `export/svg_exporter.py` の SVG を Web DOM に流し込む（書き出しと同一経路）。
- UI（HTML/CSS/JS）は `resources/web/`、Python との橋渡しは `src/web/`（`bridge.py` /
  `rpc_methods.py` / `scheme.py` / `commands.py`）。`app://` カスタムスキームで完全オフライン動作。
- 主要モジュール: `engine/pdf_engine.py`, `model/elements.py`, `export/svg_exporter.py`,
  `dictionary/apply.py`, `web/bridge.py`, `web/rpc_methods.py`。

> UI を `resources/web/` から取り込み直す場合は `python tools/extract_mockup.py <モックHTML>` で
> `styles.css` を再生成する（フォントは UI 用に Windows 標準へ差し替え済み）。
> `index.html` / `app.js` / `rpc.js` / `qwebchannel.js` は手書き管理。

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

配布はこの onedir フォルダ (`dist\PdfToSvg\`) をそのままコピーするポータブル方式。

> UI に **QtWebEngine（Chromium）** を使うため配布サイズは従来より +120〜150MB 程度大きい。
> ビルド後は `dist\PdfToSvg\` に `QtWebEngineProcess.exe` / `*.pak` / `locales\` / ICU が
> 揃っていること（無いと UI が白画面になる）、およびネットワーク遮断下でも起動・書き出しが
> できることを確認する。`packaging/pdftosvg.spec` は QtWebEngine 系を除外していない。

---

## ライセンス注意

本ツールは **PyMuPDF (AGPL)** に依存する。**社内/身内限定の配布**を前提に採用している。
外部・商用配布が必要になった場合は、抽出部 `engine/pdf_engine.py`（薄い境界）を
BSD ライセンスの **pypdfium2** 等へ差し替えるか、Artifex の商用ライセンスを取得すること。
PySide6 は LGPL（動的リンクのため .exe 配布可）。

### 同梱フォント

`resources/fonts/` に **BIZ UDゴシック**（ゴシック代替）と **Noto Serif JP**（明朝代替）を同梱する。
いずれも **SIL OFL 1.1**（`OFL.txt` / `OFL-NotoSerifJP.txt`）で再配布可。SVG 出力時は使用グリフのみ
WOFF2 サブセット埋め込みするため出力は数十 KB に収まる（`export/font_embed.py`）。

元 PDF の **ウェイト（Light/Regular/Medium/Bold）を保持**するため、フォント名から CSS ウェイトを
抽出し（`model/fonts.py`）、`<text>` に数値 `font-weight` を出力する。

- **明朝（Noto Serif JP）**: 可変フォント `NotoSerifJP-VF.ttf` を **wght 軸を保持したまま**サブセット埋め込みし、
  `@font-face` を `font-weight:100 900` で宣言。1 本で Light〜Bold を出し分ける。`C:\Windows\Fonts` の
  Google Noto（OFL）をそのままコピーして同梱。
- **ゴシック（BIZ UDGothic）**: Regular/Bold の 2 ウェイトのみ存在。`@font-face` を範囲指定
  （Regular=`1 599` / Bold=`600 1000`）で宣言し、中間ウェイト要求を faux-bold 無しで最寄りへ解決させる
  （Medium ゴシックは Regular になる）。
