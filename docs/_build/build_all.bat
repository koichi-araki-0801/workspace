@echo off
chcp 65001 >nul
rem 同梱の build_all.py を実行（引数はそのまま転送）。全 Markdown 原稿 -> .docx 一括生成。
python "%~dp0build_all.py" %*
exit /b %ERRORLEVEL%
