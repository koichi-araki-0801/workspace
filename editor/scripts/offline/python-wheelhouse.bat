@echo off
chcp 65001 >nul
title Python wheelhouse
rem 同梱の python-wheelhouse.ps1 を実行ポリシー Bypass で実行（引数はそのまま転送）。
rem 単体実行用ランチャ。-Mode download^|install が必須（例: python-wheelhouse.bat -Mode download）。
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0python-wheelhouse.ps1" %*
exit /b %ERRORLEVEL%
