# Vite 即死（exit 0xC0000409）の調査記録

## 目的

e2e（`pnpm run test:e2e`）の途中で Vite dev サーバが終了コード `3221226505`（`0xC0000409` =
`STATUS_STACK_BUFFER_OVERRUN`。ネイティブ側の即死）で落ちることがある。Playwright の
`webServer` からは終了コードしか見えず、落ちる直前の出力も残らないため、原因の切り分けに
必要な材料（どのモジュールで落ちたか・そのときのスタック）を採取して記録する。

採取そのものは `editor/e2e/tools/e2e-vite.ts`（Vite を Node 直起動で包むランチャ）が行う。
本書はその出力の採り方と読み方、および読み取った所見を置く場所である。

## 採取手順

呼び出し元のシェルで `E2E_VITE_PROCDUMP` に procdump の実行ファイルを指してから e2e を走らせる。
設定されているときだけ、ランチャは Vite を procdump 経由（`-e -ma`）で起動し、未処理例外の
瞬間にフルダンプを `.tmp/vite-e2e/` へ書き出す。

PowerShell の場合:

```powershell
$env:E2E_VITE_PROCDUMP = 'C:\Users\caads\workspace\.tmp\tools\procdump\procdump64.exe'
pnpm run test:e2e
```

Git Bash の場合:

```bash
E2E_VITE_PROCDUMP=/c/Users/caads/workspace/.tmp/tools/procdump/procdump64.exe pnpm run test:e2e
```

走らせたあと `.tmp/vite-e2e/` に残るもの:

- `vite-<stamp>.log` — Vite の stdout / stderr の写し（毎回）。
- `exit-<stamp>.txt` — 終了コード（10 進と 16 進）と直前 200 行（異常終了時、または procdump 使用時）。
- `node_<pid>_<時刻>.dmp` — クラッシュダンプ（procdump が例外を捕まえたときだけ）。
- `report.<...>.json` — Node の診断レポート（`--report-on-fatalerror` が JS 層の致命的失敗を
  捕まえたときだけ。ネイティブ側の即死では出ないことが多い）。

procdump 経由のときは、ランチャが受け取る終了コードは procdump 自身のものになる。Vite が
即死したかどうかは `.dmp` の有無と procdump の出力（`Exception: C0000409` / `Dump 1 complete`）
で判定する。

## 読み方

Store 版 WinDbg の実行ファイルは `WinDbgX.exe` で、`%LOCALAPPDATA%\Microsoft\WindowsApps\` に
置かれている。ダンプを開く:

```
%LOCALAPPDATA%\Microsoft\WindowsApps\WinDbgX.exe -z <dmp>
```

開いたらコマンドウィンドウで `!analyze -v` を実行し、次の 2 つを控える。

- `FAULTING_MODULE` — どのモジュール（DLL / 実行ファイル）で落ちたか。Rolldown / esbuild の
  ような Rust・Go 製のネイティブ部品か、Node 本体か、その他かの切り分けになる。
- `STACK_TEXT` — 落ちた時点のコールスタック。

コンソールで完結させたいとき（スクリプトから回すときはこちら）は、Windows SDK の Debugging
Tools に含まれる `cdb` を使う:

```
cdb -z <dmp> -c "!analyze -v; q"
```

`cdb` が入っていなければ `WinDbgX.exe` で手動実行する。

## 所見

（未記入。採取したダンプの `FAULTING_MODULE` / `STACK_TEXT` をここへ書く。）
