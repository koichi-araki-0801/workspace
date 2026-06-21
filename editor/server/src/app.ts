// =============================================================================
// app.ts — Express アプリの組み立てと起動(ミドルウェア/ルート/graceful shutdown)
// =============================================================================
// ミドルウェアと API ルートを配線し、本番ではビルド済み SPA を配信する。
// listen 後はシグナル受信で live preview を片付けてから graceful に終了する。

import fs from 'node:fs';
import express from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { config } from './config.js';
import { logger } from './logger.js';
import { errorHandler } from './middleware/errorHandler.js';
import { openapiRouter } from './openapi/index.js';
import { authRouter } from './routes/auth.routes.js';
import { generateRouter } from './routes/generate.routes.js';
import { historyRouter } from './routes/history.routes.js';
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
app.use('/api', usersRouter);

// 本番ではビルド済み SPA を配信する(Vite がアプリを配信する dev では no-op)。
if (fs.existsSync(config.webDist)) {
  app.use(express.static(config.webDist));
  app.get(/^(?!\/api).*/, (_req, res) => {
    res.sendFile('index.html', { root: config.webDist });
  });
}

// 中央エラーハンドラ — 全ルートの後、必ず最後に登録する。
app.use(errorHandler);

const server = app.listen(config.port, () => {
  logger.info(`[server] listening on http://localhost:${config.port}`);
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
