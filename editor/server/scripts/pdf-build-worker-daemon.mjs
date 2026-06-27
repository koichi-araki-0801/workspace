// =============================================================================
// pdf-build-worker-daemon.mjs — 常駐 PDF ビルドワーカー(IPC ループ)
// =============================================================================
// `pdf-build-worker.mjs`(1 ジョブ毎に spawn する版)の常駐版。`@vivliostyle/cli` の import は
// 計測で ~11s かかり、従来はビルドのたびに払っていた。本 worker は import を *起動時に 1 回だけ*
// 行って常駐し、親(`buildWorkerPool.ts`)から IPC で届くジョブを 1 件ずつ処理してプロセス
// (= 読込済みモジュール)を使い回す。in-process ハング回避のための「別プロセス分離」は維持し、
// ハングは親側の timeout → SIGKILL で隔離する(本 worker は素直に build を待つだけ)。
//
// 契約(IPC): 親 → 子 `{ id:number, opts:object }`(`opts` は `@vivliostyle/cli` の `build()` 引数)。
//            子 → 親 `{ id, ok:true }` 成功 / `{ id, ok:false, error:string }` 失敗。
// `build()` は 1 度に 1 件のみ(単一プロセス/ブラウザで並行実行しない前提。親が直列化する)。
import { existsSync } from 'node:fs';

// 起動時に 1 度だけ import する(ここが従来「毎回」払っていた重コスト)。
const { build } = await import('@vivliostyle/cli');

process.on('message', async (msg) => {
  const { id, opts } = msg ?? {};
  try {
    await build(opts);
    // build() が解決しても出力が無いケースは失敗扱い(親が PDF を read する前に検出する)。
    const outPath = opts?.output?.[0]?.path;
    if (outPath && !existsSync(outPath)) {
      process.send?.({ id, ok: false, error: 'PDF が生成されませんでした' });
      return;
    }
    process.send?.({ id, ok: true });
  } catch (e) {
    process.send?.({ id, ok: false, error: String(e?.stack || e) });
  }
});

// 親が IPC チャネルを閉じた(プール破棄/サーバ終了)ら素直に終了する。
process.on('disconnect', () => process.exit(0));
