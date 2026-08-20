// =============================================================================
// index.ts — サーバの入口(起動準備・listen・graceful shutdown)
// =============================================================================
// アプリの配線は `app.ts` の `buildApp()` が持ち、本ファイルは**プロセスとしての振る舞い**
// だけを持つ: 置き場の健全性チェック・起動時のセッション失効・listen・シグナル処理・
// 最後の砦のハンドラ。分けているのは、テストが実配線の app を `inject()` で叩けるように
// するため(起動まで走るモジュールは import しただけで待受と `process.exit` を引き起こす)。
//
// 起動スクリプト(`editor/start.bat`)はこのファイルを実体パスで起動し、そのコマンドライン
// で「自分のリポジトリのサーバか」を判定して古いプロセスを片付ける。エントリの綴りを
// 変えるときは start.bat の判定パターンも併せて直すこと。

import fs from 'node:fs';
import { buildApp } from './app.js';
import { invalidateAllSessions, purgeExpiredSessions } from './auth/session.js';
import { config } from './config.js';
import { logger } from './logger.js';
import { buildWorkerPool } from './vivliostyle/buildWorkerServer.js';
import { previewManager } from './vivliostyle/previewServer.js';

// ── 置き場の健全性チェック(ネットワークドライブ) ──
// dataRoot のネットワークドライブ配置(1 サーバ + 共有上のデータ)はサポートするが、
// ログ・一時領域まで共有に乗ると監査ログの欠落(常時オープン + 非同期フラッシュ)や
// ビルドのタイムアウトを招くため、そこは警告で止める。マップドライブは realpath.native
// (GetFinalPathNameByHandle)が UNC へ解決することを利用して判定する(ベストエフォート。
// 判定できないときは黙ってスキップし、起動は妨げない)。
function isNetworkPath(p: string): boolean {
  if (p.startsWith('\\\\')) return true;
  try {
    return fs.realpathSync.native(p).startsWith('\\\\');
  } catch {
    return false;
  }
}

function warnOnNetworkPlacement(): void {
  if (isNetworkPath(config.dataRoot)) {
    logger.info(
      `[server] dataRoot はネットワークドライブ上です: ${config.dataRoot} — ` +
        'このサーバ 1 台だけが書き込むこと。他クライアントの TortoiseGit/Explorer が開いて' +
        'いる間は保存・コミットが待たされることがあります',
    );
  }
  for (const [name, dir] of [
    ['LOG_DIR', config.logging.dir],
    ['TMP_DIR', config.tmpDir],
  ] as const) {
    if (isNetworkPath(dir)) {
      logger.warn(
        `[server] ${name} がネットワークドライブ上にあります: ${dir} — 監査ログの欠落・` +
          'PDF ビルドの遅延を招くため、ローカルディスクへ向けてください(env で変更可能)',
      );
    }
  }
}

// 起動時に全セッションを失効させ、再起動をまたいだ旧セッションでの再ログイン不要化を断つ。
// 認証なし(local)では DB 未接続なので呼ばない。失敗してもプロセスは継続するが、失効漏れ
// は「再起動後もログイン状態が残る」形へ戻る退行なので error で目立たせる。
async function invalidateSessionsOnBoot(): Promise<void> {
  if (!config.requireAuth) return;
  try {
    await invalidateAllSessions();
    logger.info('[server] 全セッションを失効しました(起動時) — 再ログインを強制します');
  } catch (e) {
    logger.error(
      { err: e },
      '[server] 起動時の全セッション失効に失敗 — 旧セッションが残存する恐れ',
    );
  }
  // 失効は論理フラグなので行は消えない。起動時と 6 時間ごとに保持期間切れを物理削除する。
  // `unref` でこのタイマーがプロセスを生かし続けないようにする。
  const purge = async (): Promise<void> => {
    try {
      await purgeExpiredSessions();
    } catch (e) {
      logger.warn({ err: e }, '[server] 期限切れセッションの掃除に失敗しました');
    }
  };
  await purge();
  setInterval(() => void purge(), 6 * 3_600_000).unref();
}

// 組み立ての失敗(HTTPS opt-in なのに PFX が無い等)は設定ミスなので、黙って別構成へ落ちず
// メッセージを出して異常終了する。
let app: ReturnType<typeof buildApp>;
try {
  app = buildApp();
} catch (err) {
  logger.error(`[server] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

warnOnNetworkPlacement();
await invalidateSessionsOnBoot();

// listen。host は既定 127.0.0.1(同一マシン限定)で、社内 LAN へ公開するときだけ
// `HOST=0.0.0.0`(start.bat lan が設定)で全 IF にバインドする。preview サーバは loopback のまま
// ここ経由のプロキシでのみ外へ出るため、公開されるのは本ポートだけで認証も効く。
// listen の失敗(`EADDRINUSE` 等)は reject で届くため、原因を明示してから exit(1) する。
try {
  await app.listen({ port: config.port, host: config.host });
  const scheme = config.tls.enabled ? 'https' : 'http';
  const lanExposed = config.host !== '127.0.0.1' && config.host !== 'localhost';
  logger.info(
    `[server] listening on ${scheme}://localhost:${config.port}` +
      (lanExposed ? ` (LAN 公開中: ${scheme}://<この端末のIP>:${config.port})` : ''),
  );
} catch (err) {
  const e = err as NodeJS.ErrnoException;
  if (e.code === 'EADDRINUSE') {
    logger.error(
      `[server] ポート ${config.port} は既に使用中です — 旧サーバが残っている可能性があります。` +
        ' 既存プロセスを停止してから再実行してください(start.bat は自動停止を試みます)。',
    );
  } else {
    logger.error({ err }, '[server] listen に失敗しました');
  }
  process.exit(1);
}

// Graceful shutdown: プロセス終了前に全 live preview サーバ(各々が Vite サーバ
// + 一時ディレクトリを保持)を停止し、リーク(leak)を残さない。
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`[server] ${signal} received — closing preview sessions`);
  await Promise.allSettled([previewManager.disposeAll(), buildWorkerPool.disposeAll()]);
  await app.close();
  process.exit(0);
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => void shutdown(signal));
}

// 最後の砦(last resort): 想定外の例外/未処理 Promise は、ログを残さず無言で死ぬと
// 原因究明ができない。error で記録してから `exit(1)` し、必ず痕跡を残す。
process.on('uncaughtException', (err) => {
  logger.error({ err }, '[server] 未捕捉の例外で異常終了します');
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, '[server] 未処理の Promise 拒否で異常終了します');
  process.exit(1);
});
