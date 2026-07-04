@echo off
chcp 65001 >nul
rem 同梱の capture_examples.py を実行（引数はそのまま転送）。pie-chart の利用手引き向け図版取得。
python "%~dp0capture_examples.py" %*
exit /b %ERRORLEVEL%
