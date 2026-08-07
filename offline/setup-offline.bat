@echo off
chcp 65001 >nul
title オフライン環境セットアップ（取得＋構築）
rem 同梱の setup-offline.ps1 を実行ポリシー Bypass で実行（引数はそのまま転送）。
rem ソース＋重量物を Releases から HTTPS 直取得→展開→環境構築→bk 退避まで一括。
rem ダブルクリック／コマンドのどちらでも起動可。
rem 検証（offline\pinned-release.txt の sha256 と offline\bundle-signing.pub.xml による
rem 分離署名）は必須で、材料の欠落・不一致はいずれも中止する。
rem TortoiseGit も導入する場合のみ -InstallTortoiseGit を付ける（昇格 MSI のため既定は導入しない）。
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-offline.ps1" %*
exit /b %ERRORLEVEL%
