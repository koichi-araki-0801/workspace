// =============================================================================
// app.ts — Fastify アプリの組み立てと起動(プラグイン/ルート/graceful shutdown)
// =============================================================================
// プラグインと API ルートを配線し、本番ではビルド済み SPA を配信する。listen 後は
// シグナル受信で live preview を片付けてから graceful に終了する。
//
// 注意: Fastify はインスタンスを一度 ready 化すると以降のルート/プラグイン追加を弾く。
// `app.register(...)` は await せず同期的に並べ、起動準備の await(セッション失効)を挟んでから
// 最後に `app.listen()` で一括ブートする。

import fs from 'node:fs';
import path from 'node:path';
import { apiPaths, validation } from '@editor/shared';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import staticPlugin from '@fastify/static';
import ScalarApiReference from '@scalar/fastify-api-reference';
import Fastify from 'fastify';
import { invalidateAllSessions } from './auth/session.js';
import { config } from './config.js';
import { logger } from './logger.js';
import { errorHandler } from './middleware/errorHandler.js';
import { getOpenApiDocument, openapiRoutes } from './openapi/index.js';
import { authRoutes } from './routes/auth.routes.js';
import { generateRoutes } from './routes/generate.routes.js';
import { historyRoutes } from './routes/history.routes.js';
import { notesRoutes } from './routes/notes.routes.js';
import { partsRoutes } from './routes/parts.routes.js';
import { reviewsRoutes } from './routes/reviews.routes.js';
import { templatesRoutes } from './routes/templates.routes.js';
import { usersRoutes } from './routes/users.routes.js';
import { vivliostyleRoutes } from './routes/vivliostyle.routes.js';
import { buildWorkerPool } from './vivliostyle/buildWorkerServer.js';
import { previewManager } from './vivliostyle/previewServer.js';

const app = Fastify({
  // pino-http の置換。既存の pino インスタンスをそのまま使い request.log/reply.log を提供する。
  loggerInstance: logger,
  // express.json({ limit: '8mb' }) 相当。JSON 既定パーサに適用される本文サイズ上限。
  bodyLimit: 8 * 1024 * 1024,
});

// `requireAuth` が解決して埋めるユーザ。型は `middleware/auth.ts` の module augmentation を参照。
app.decorateRequest('user', undefined);

// project zip アップロードのパーサ。グローバル `bodyLimit`(8mb) をバイパスし、自前で
// `maxProjectBytes`(既定 64MB) を強制する。超過時は 413 ではなく現行と同じ `validation`(400)
// を返すため、関数形式(`parseAs` 不使用)で `done(validation(...))` を返す。
app.addContentTypeParser(
  ['application/zip', 'application/octet-stream'],
  (_request, payload, done) => {
    const limit = config.vivliostyle.build.maxProjectBytes;
    const chunks: Buffer[] = [];
    let size = 0;
    payload.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        payload.destroy();
        // `done` は `Error` を期待するが、`AppError`(plain object)を渡しても setErrorHandler が
        // `toAppError`→`statusForKind('validation')`=400 で正規化する。現行の 413 ではなく 400 を維持。
        done(validation('プロジェクトが大きすぎます') as unknown as Error, undefined);
        return;
      }
      chunks.push(c);
    });
    payload.on('end', () => done(null, Buffer.concat(chunks)));
    payload.on('error', (err) => done(err, undefined));
  },
);

// 中央エラーハンドラ — ルート/preHandler の throw をここで AppError 形へ正規化する。
app.setErrorHandler(errorHandler);

app.register(helmet, {
  contentSecurityPolicy: false, // SPA + blob preview のため。本番では締める(tighten)
});
app.register(cookie); // reply.setCookie / reply.clearCookie を提供する

// health だけは register prefix を介さず直付けなので、`/api` を明示合成する。
app.get(`/api${apiPaths.health}`, async () => ({ ok: true }));

app.register(openapiRoutes, { prefix: '/api' });
app.register(authRoutes, { prefix: '/api' });
app.register(vivliostyleRoutes, { prefix: '/api' });
app.register(templatesRoutes, { prefix: '/api' });
app.register(generateRoutes, { prefix: '/api' });
app.register(partsRoutes, { prefix: '/api' });
app.register(reviewsRoutes, { prefix: '/api' });
app.register(historyRoutes, { prefix: '/api' });
app.register(notesRoutes, { prefix: '/api' });
app.register(usersRoutes, { prefix: '/api' });

// API リファレンス UI(/api/docs)。標準 JS バンドルはプラグインがローカル配信するため
// オフライン(air-gapped)でも動作する。spec は生成済みの OpenAPI ドキュメントを直接渡す。
app.register(ScalarApiReference, {
  routePrefix: '/api/docs',
  configuration: { content: getOpenApiDocument() },
});

// サーバ起動ごとに変わる epoch。配信する index.html に注入し、クライアントは前回値と
// 突き合わせて「同一サーバ起動中のみログイン有効」を判定する(local モードの再起動検知。
// REST は DB セッション失効が権威的だが、両モードでシェルを確実に作り直すために共有する)。
const APP_EPOCH = String(Date.now());

// 本番ではビルド済み SPA を配信する(Vite がアプリを配信する dev では no-op)。
if (fs.existsSync(config.webDist)) {
  // ハッシュ付きアセット(`assets/`)は内容ハッシュ済みなので長期 immutable で配る。
  // `wildcard: false` で実在ファイルのみを配信し、非ファイル(SPA ルート)は notFound へ落とす
  // (= 下の setNotFoundHandler が epoch 入り index.html を返す)。`index: false` で `/` も同様。
  app.register(staticPlugin, {
    root: config.webDist,
    prefix: '/',
    index: false,
    wildcard: false,
    setHeaders: (res, filePath) => {
      if (filePath.includes(`${path.sep}assets${path.sep}`)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      }
    },
  });

  // SPA シェル: 起動時に epoch を埋め込んだ index.html をメモリ保持し、認証状態の更新が
  // 確実に反映されるよう `no-store` で返す(ブラウザが旧 epoch のシェルを返すのを防ぐ)。
  const indexHtml = fs
    .readFileSync(path.join(config.webDist, 'index.html'), 'utf8')
    .replaceAll('%APP_EPOCH%', APP_EPOCH);

  // catch-all。未知の `/api/*` は 404 JSON(Express の `^(?!\/api).*` catch-all が /api を除外し
  // 既定 404 を返していたのと同じ)。それ以外は SPA シェルを返す。
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api')) {
      return reply.code(404).send({ kind: 'not_found', message: '対象が見つかりません' });
    }
    return reply
      .header('Cache-Control', 'no-store')
      .type('text/html; charset=utf-8')
      .send(indexHtml);
  });
}

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

// listen。Express の `app.listen(port)` は全 IF にバインドするが、Fastify は host 省略時
// loopback のみ。現行同等(かつ preview host が 127.0.0.1 なのと整合)のため host を明示する。
// listen の失敗(`EADDRINUSE` 等)は reject で届くため、原因を明示してから exit(1) する。
try {
  await app.listen({ port: config.port, host: '127.0.0.1' });
  logger.info(`[server] listening on http://localhost:${config.port}`);
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
