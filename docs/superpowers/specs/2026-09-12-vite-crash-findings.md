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

### 計数（ランチャ導入後）

| 起動方法 | 実行回数 | Vite 死亡 | 備考 |
|---|---|---|---|
| ランチャ（`node editor/e2e/tools/e2e-vite.ts`。Node が `vite/bin/vite.js` を直接起動） | 6 | 0 | procdump あり 5 回・なし 1 回。全回 44/44 |
| 旧コマンド（`pnpm --filter web exec vite`。cmd.exe → pnpm → node） | 3 | 2 | B: 9 passed / 33 failed、C: 37 passed / 5 failed。死亡地点は回ごとに違う |

ランチャ導入前の記録（通算 16 回中 7 回死亡）も旧コマンドで走っていた。合わせると旧コマンドは
19 回中 9 回、ランチャは 6 回中 0 回。

### 死亡時の出力

旧コマンドで死ぬときは、毎回 pnpm の reporter が `undefined` を 1 行出した直後に
`[ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL] Command failed with exit code 3221226505: vite --port 24681`
で終わる。Vite 自身の出力は死ぬ前に 1 行も無い。`3221226505` = `0xC0000409`
（`STATUS_STACK_BUFFER_OVERRUN`。ネイティブコードの `__fastfail` / `abort()` 系の即死）。

ランチャ経由では procdump が node.exe（= Vite 本体）に張り付いた状態で 5 回走らせたが、例外は
1 度も捕捉されず `.dmp` は生成されていない。つまり **Vite 本体の node.exe は落ちていない**。

### 判断

死んでいるのは Vite の node.exe ではなく、`pnpm exec` が挟む中間層（cmd.exe → pnpm 自身の
node プロセス → 子の node）のどこかである。pnpm 側のプロセスが即死すると Playwright からは
「webServer の command が exit 0xC0000409 で終わった」ようにしか見えず、Vite の子プロセスも
道連れになって接続拒否になる。`undefined` が直前に出るのは pnpm の reporter が例外オブジェクトを
持たないまま終了処理へ入っている形で、これも pnpm 側の異常終了と整合する。

メモリの相関: 死亡した B の実行中は空きメモリが 0.8〜1.2 GB、コミット済み 58〜70% で、
生き残った回と同程度。資源枯渇だけでは説明がつかない。

依存の遅延最適化（Vite の deps キャッシュは温まっている）、Worker 初回ロード（warmup を入れても
再現し、死亡地点も移動）、`server.warmup` は既に否定済み。

### 結論と対策

- **対策は Task 1 で入れたランチャそのもの**（Node が `vite/bin/vite.js` を直接起動する）。
  pnpm を経由しないだけで 6 回連続で再現しない。追加の依存変更（Vite 7 系への固定）や
  `test:e2e` のリトライは要らない。
- 残る未解決は「pnpm 11.18 の exec がなぜ 0xC0000409 で落ちるか」。Vite の問題ではないため
  本リポジトリ側で追う価値は低い。再発時は procdump を **pnpm の node プロセス**（ランチャでなく
  `pnpm exec` を包む形）に張れば faulting module が取れる。
- 開発者が手で `pnpm --filter web exec vite` / `pnpm dev` を使う分には Playwright の並列負荷が
  無く、これまで実害の報告も無い。手順は変えない。
