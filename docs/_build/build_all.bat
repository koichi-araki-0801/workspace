@echo off
chcp 65001 >nul
rem 同梱の build_all.py を実行（引数はそのまま転送）。全原稿 -> 閲覧用 HTML（手引き/設計）一括生成。
python "%~dp0build_all.py" %*
exit /b %ERRORLEVEL%
