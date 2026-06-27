// =============================================================================
// app.ts — Express アプリの組み立てと起動(ミドルウェア/ルート/graceful shutdown)
// =============================================================================
// ミドルウェアと API ルートを配線し、本番ではビルド済み SPA を配信する。
// listen 後はシグナル受信で live preview を片付けてから graceful に終了する。

import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { invalidateAllSessions } from './auth/session.js';
import { config } from './config.js';
import { logger } from './logger.js';
import { errorHandler } from './middleware/errorHandler.js';
import { openapiRouter } from './openapi/index.js';
import { authRouter } from './routes/auth.routes.js';
import { generateRouter } from './routes/generate.routes.js';
import { historyRouter } from './routes/history.routes.js';
import { notesRouter } from './routes/notes.routes.js';
import { partsRouter } from './routes/parts.routes.js';
import { templatesRouter } from './routes/templates.routes.js';
import { usersRouter } from './routes/users.routes.js';
import { vivliostyleRouter } from './routes/vivliostyle.routes.js';
import { previewManager } from './vivliostyle/previewServer.js';

const app = express();

app.use(
  helmet({
    contentSecurityPolicy: false, // SPA + blob preview のため。本番では締める(tighten)
  }),
);
app.use(express.json({ limit: '8mb' }));
app.use(pinoHttp({ logger }));

app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.use('/api', openapiRouter);
app.use('/api', authRouter);
app.use('/api', vivliostyleRouter);
app.use('/api', templatesRouter);
app.use('/api', generateRouter);
app.use('/api', partsRouter);
app.use('/api', historyRouter);
app.use('/api', notesRouter);
app.use('/api', usersRouter);

// サーバ起動ごとに変わる epoch。配信する index.html に注入し、クライアントは前回値と
// 突き合わせて「同一サーバ起動中のみログイン有効」を判定する(local モードの再起動検知。
// REST は DB セッション失効が権威的だが、両モードでシェルを確実に作り直すために共有する)。
const APP_EPOCH = String(Date.now());

// 本番ではビルド済み SPA を配信する(Vite がアプリを配信する dev では no-op)。
if (fs.existsSync(config.webDist)) {
  // ハッシュ付きアセット(`assets/`)は内容ハッシュ済みなので長期 immutable で配る。
  // index.html はキャッシュさせず(下の catch-all)、再起動後に確実に作り直させる。
  app.use(
    express.static(config.webDist, {
      index: false,
      setHeaders: (res, filePath) => {
        if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        }
      },
    }),
  );
  // SPA シェル: 起動時に epoch を埋め込んだ index.html をメモリ保持し、認証状態の更新が
  // 確実に反映されるよう `no-store` で返す(ブラウザが旧 epoch のシェルを返すのを防ぐ)。
  const indexHtml = fs
    .readFileSync(path.join(config.webDist, 'index.html'), 'utf8')
    .replaceAll('%APP_EPOCH%', APP_EPOCH);
  app.get(/^(?!\/api).*/, (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.type('html').send(indexHtml);
  });
}

// 中央エラーハンドラ — 全ルートの後、必ず最後に登録する。
app.use(errorHandler);

// 起動時に全セッションを失効させ、再起動をまたいだ旧セッションでの再ログイン不要化を断つ。
// 認証なし(local)では DB 未接続なので呼ばない。失敗してもプロセスは継続するが、失効漏れ
// は旧バグ(再起動後もログイン状態)の再発なので error で目立たせる。
if (config.requireAuth) {
  try {
    await invalidateAllSessions();
    logger.info('[server] 全セッションを失効しました(起動時) — 再ログインを強制します');
  } catch (e) {
    logger.error(
      { err: e },
      '[server] 起動時の全セッション失効に失敗 — 旧セッションが残存する恐れ',
    );
  }
}

const server = app.listen(config.port, () => {
  logger.info(`[server] listening on http://localhost:${config.port}`);
});

// listen の失敗(`EADDRINUSE` 等)は server の `error` イベントで届く。ハンドラが無いと
// Node が未捕捉例外として即死し、バナー直後に無言で落ちたように見える(旧不具合)。
// ここで原因を明示してから `exit(1)` し、stale な旧サーバが port を掴んでいる場合は
// `start.bat` の事前チェックで自動停止する旨を案内する。
server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    logger.error(
      `[server] ポート ${config.port} は既に使用中です — 旧サーバが残っている可能性があります。` +
        ' 既存プロセスを停止してから再実行してください(start.bat は自動停止を試みます)。',
    );
  } else {
    logger.error({ err }, '[server] listen に失敗しました');
  }
  process.exit(1);
});

// Graceful shutdown: プロセス終了前に全 live preview サーバ(各々が Vite サーバ
// + 一時ディレクトリを保持)を停止し、リーク(leak)を残さない。
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`[server] ${signal} received — closing preview sessions`);
  await previewManager.disposeAll();
  server.close(() => process.exit(0));
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
