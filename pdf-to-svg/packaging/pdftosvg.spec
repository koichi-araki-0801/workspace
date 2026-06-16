# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec。

ビルド:  pyinstaller packaging/pdftosvg.spec
出力:    dist/PdfToSvg/PdfToSvg.exe   (onedir)

方針:
- onedir (起動が速く AV 誤検知が少ない)。配布は dist/PdfToSvg/ フォルダごとコピー。
- 未使用の重い Qt モジュールを除外してサイズを抑える。
"""
import os
from PyInstaller.utils.hooks import collect_dynamic_libs

block_cipher = None

# SPECPATH は PyInstaller が注入する spec ファイルのあるディレクトリ。
# これを基準にすることで、どこから pyinstaller を起動しても同じ結果になる。
ROOT = os.path.abspath(os.path.join(SPECPATH, ".."))
RESOURCES = os.path.join(ROOT, "resources")

# 任意リソース (存在すれば同梱)
datas = []
if os.path.isdir(RESOURCES):
    datas.append((RESOURCES, "resources"))

# PyMuPDF のネイティブライブラリを確実に同梱
binaries = collect_dynamic_libs("fitz")

# 不要な重量級 Qt モジュール (使っていない)
# 注意: QtWebEngine* / QtWebChannel / QtNetwork / QtQuick / QtQml は UI を
# QWebEngineView で描画するために実行時必須なので除外しない (除外すると白画面)。
# PyInstaller の PySide6 フックが QtWebEngineProcess.exe / *.pak / locales / ICU を
# 取り込む。dist にこれらが揃うことをビルド後に必ず確認すること。
excludes = [
    "PySide6.QtMultimedia",
    "PySide6.QtMultimediaWidgets",
    "PySide6.Qt3DCore",
    "PySide6.QtCharts",
    "PySide6.QtDataVisualization",
    "tkinter",
]

a = Analysis(
    [os.path.join(ROOT, "run.py")],
    pathex=[os.path.join(ROOT, "src")],
    binaries=binaries,
    datas=datas,
    hiddenimports=[],
    hookspath=[],
    runtime_hooks=[],
    excludes=excludes,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="PdfToSvg",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=False,  # GUI アプリなのでコンソール非表示
    icon=os.path.join(RESOURCES, "icons", "app.ico")
    if os.path.exists(os.path.join(RESOURCES, "icons", "app.ico"))
    else None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name="PdfToSvg",
)
