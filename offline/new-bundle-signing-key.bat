@echo off
chcp 65001 >nul
title オフライン重量物 署名鍵の生成
rem 同梱の new-bundle-signing-key.ps1 を実行ポリシー Bypass で実行（引数はそのまま転送）。
rem 公開担当者が 1 回だけ実行する。秘密鍵は %USERPROFILE%\.offline-signing\ へ、
rem 公開鍵は offline\bundle-signing.pub.xml へ出力される。
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0new-bundle-signing-key.ps1" %*
exit /b %ERRORLEVEL%
