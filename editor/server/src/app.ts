// =============================================================================
// app.ts — Fastify アプリの組み立て(プラグイン/ルート/入口フックの配線)
// =============================================================================
// プラグインと API ルートを配線し、本番ではビルド済み SPA を配信する。組み立てた
// インスタンスを返すところまでが本ファイルの責務で、listen・シグナル処理・
// `process.exit` は入口の `index.ts` が持つ。分けているのは、テストが**実際の配線**を
// `app.inject()` で叩けるようにするため — 起動まで走るモジュールは import しただけで
// 待受とプロセス終了を引き起こし、テストランナーごと落としうる。
//
// 注意: Fastify はインスタンスを一度 ready 化すると以降のルート/プラグイン追加を弾く。
// `app.register(...)` は await せず同期的に並べ、ready 化は `listen()`(テストでは
// `inject()`)に任せる。

import fs from 'node:fs';
import type http from 'node:http';
import type https from 'node:https';
import path from 'node:path';
import { apiPaths, unauthorized } from '@editor/shared';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import staticPlugin from '@fastify/static';
import Fastify, { type FastifyHttpOptions } from 'fastify';
import { createSessionStore } from './auth/session.js';
import {
  allowedHosts,
  buildCspDirectives,
  config,
  inlineScriptCspHashes,
  isAllowedHost,
  isPreAuthBufferedRequest,
  preAuthGateUrl,
} from './config.js';
import { setAuditSink } from './db/audit.js';
import { realSproc, type SprocClient } from './db/sproc.js';
import { createDeps } from './deps.js';
import { logger } from './logger.js';
import { loadUser } from './middleware/auth.js';
import { errorHandler } from './middleware/errorHandler.js';
import { docsRoutes, openapiRoutes } from './openapi/index.js';
import { renderHostRoutes } from './render/renderHost.js';
import { authRoutes } from './routes/auth.routes.js';
import { generateRoutes } from './routes/generate.routes.js';
import { historyRoutes } from './routes/history.routes.js';
import { notesRoutes } from './routes/notes.routes.js';
import { partsRoutes } from './routes/parts.routes.js';
import { reviewsRoutes } from './routes/reviews.routes.js';
import { assertRoutePolicy } from './routes/routeGuards.js';
import { templatesRoutes } from './routes/templates.routes.js';
import { usersRoutes } from './routes/users.routes.js';
import { vivliostyleRoutes } from './routes/vivliostyle.routes.js';
import { previewHostRoutes } from './vivliostyle/previewHost.js';

/**
 * 待受オプションを組む。`HTTPS=true`(start.bat lan が pfx 存在時に設定)のときだけ HTTPS で
 * 待受ける。LAN 公開を平文で行うと Secure cookie が保存されずログイン不能になるため、公開
 * 運用は HTTPS を基本とする。opt-in なのに pfx が無いのは設定ミスなので throw する(黙って
 * HTTP に落とすと cookie 問題が分かりにくく再発する)。プロセスを終わらせる判断は入口
 * (`index.ts` の `main`)が持ち、本ファイルは `process.exit` を呼ばない。
 *
 * `https` を型どおり渡すと Fastify のインスタンス型が `https.Server` に変わり全ルート
 * プラグインの型へ波及するため、型上は HTTP のまま値だけ注入する(Fastify は `opts.https` を
 * 実行時に参照するので挙動は正しく HTTPS になる)。
 */
function buildServerOptions(): FastifyHttpOptions<http.Server> {
  const serverOptions: FastifyHttpOptions<http.Server> = {
    // pino-http の置換。既存の pino インスタンスをそのまま使い request.log/reply.log を提供する。
    loggerInstance: logger,
    // express.json({ limit: '8mb' }) 相当。JSON 既定パーサに適用される本文サイズ上限。
    bodyLimit: 8 * 1024 * 1024,
  };
  if (!config.tls.enabled) return serverOptions;
  if (!fs.existsSync(config.tls.pfxPath)) {
    throw new Error(
      `HTTPS=true ですが PFX がありません: ${config.tls.pfxPath} — ` +
        'editorscriptssetup-lan-https.bat を実行して証明書を生成してください。',
    );
  }
  (serverOptions as { https?: https.ServerOptions }).https = {
    pfx: fs.readFileSync(config.tls.pfxPath),
    passphrase: config.tls.passphrase,
  };
  return serverOptions;
}

export interface BuildAppOptions {
  /** DB 実行面。既定は本番のプール接続で、テストと rest e2e は in-memory フェイクを渡す。 */
  sproc?: SprocClient;
}

/**
 * プラグイン・ルート・入口フックを配線した Fastify インスタンスを返す。ready 化も listen も
 * しないので、呼び出し側が `listen()`(本番)か `inject()`(テスト)でブートする。
 */
export function buildApp({ sproc = realSproc }: BuildAppOptions = {}) {
  const app = Fastify(buildServerOptions());
  // `requireAuth` が解決して埋めるユーザ。型は `middleware/auth.ts` の module augmentation を参照。
  app.decorateRequest('user', undefined);
  // セッションストアはインスタンスへ載せる。ガード関数は参照同一性を保つ必要があるため
  // (`routes/routeGuards.ts` の `levelOf`)、注入はガードの引数でなくここで行う。
  const sessionStore = createSessionStore(sproc);
  app.decorate('sessionStore', sessionStore);
  // 監査ログの DB 複写は logger 経由(グローバル)なので、宛先だけをここで差し込む。
  setAuditSink(sproc);
  // 集約は 1 回だけ組み、ルートへは `register` の options で配る。プラグインを
  // `fastify-plugin` に通していないので、options はそのルート群の中に閉じる。
  const deps = createDeps(sproc, sessionStore);

  // ルートごとの必要ロールの網羅検査。**API ルートの register より前**に張る必要がある
  // (`onRoute` は張った後の登録しか見ないため、後ろに置くと検査漏れが静かに生まれる)。
  // 新しいルートを足したら `routes/routeGuards.ts` の `ROUTE_POLICY` を更新すること。
  // 忘れるとここで起動が落ちる = 付け忘れが本番まで届かない。
  app.addHook('onRoute', assertRoutePolicy);

  // `Host` ヘッダの検査。**すべてのフックより前**に置く(ここを通った後の判定は、要求が
  // こちらのオリジン宛だという前提で書かれている)。
  //
  // 塞ぐのは DNS リバインディング。攻撃者ページは自分のドメインの DNS を後から `127.0.0.1`
  // へ向け替えられ、ブラウザは「まだ attacker.example と同一オリジン」と考えたまま要求を
  // 出すので SameSite も CORS も効かない。唯一食い違うのが `Host` で、ブラウザはこれを
  // 攻撃者ドメインのまま送る。
  //
  // 効きどころは認証を課さない配備(既定の local モード)で、そこでは実質「loopback に到達
  // できること」だけが認可条件になっている。`config.requireAuth` を見て出し分けては**ならない**
  // — 設定 1 つでガードが消える形は認証系ガードで避けている作法と同じ。
  //
  // 分離先 python-tools リポジトリの pdf-to-svg(`src/web/origin_guard.py`)と
  // graph-editor(`app.py`)も同じ理由で Host を完全一致集合で検査している。
  // 判定の実体は `config.isAllowedHost`。
  app.addHook('onRequest', async (request, reply) => {
    if (isAllowedHost(request.headers.host, allowedHosts)) return;
    // 本文は 1 バイトも返さない(存在オラクルにしない)。ログには名乗られた値を残す。
    request.log.warn({ host: request.headers.host }, 'rejected: host-mismatch');
    await reply.code(403).send();
  });

  // 未認証のアップロードを body 解析の前に切る認証ゲート。Fastify のライフサイクルは
  // onRequest → parsing → preHandler の順で、zip パーサ(下)もルート単位の `bodyLimit` 引き上げも
  // preHandler の `requireAuth` より先に効く。つまり `requireAuth` だけでは「認証前に
  // 最大 64MB(zip)/ 32MB(merge JSON)をリクエストごとにメモリへ積む」経路が残り、多重接続で
  // プロセスを枯渇させられる。ここで 401 にすればボディは 1 バイトも積まない。判定条件は
  // `isPreAuthBufferedRequest`(content-type + 上限を上げた path)。対象ルートは元々
  // `requireAuth` 付きなので、正規のクライアントから見た応答は 401 のまま変わらない。認証を
  // 課さないローカルモード(`requireAuth=false`)は素通しする。
  app.addHook('onRequest', async (request) => {
    if (!config.requireAuth) return;
    // 照合は**ルーティング結果の登録パターン**で行う(`request.url` は生の request target で、
    // percent-encoding も dot セグメントも解かれていない)。選び方は `preAuthGateUrl` に閉じる。
    const gateUrl = preAuthGateUrl(request);
    if (!isPreAuthBufferedRequest(request.method, gateUrl, request.headers['content-type'])) return;
    const user = await loadUser(request);
    if (!user || user.disabled) throw unauthorized('ログインが必要です');
  });

  // ⚠ project zip の content-type parser を**ここ(ルートインスタンス)へ戻さないこと。**
  // Fastify の encapsulation では、ルートに登録したパーサは全ルートへ伝播する。関数形式の
  // パーサは `rawBody` を経由しない = `bodyLimit` が一切効かないため、ルートに置くと
  // 「任意の POST/PUT へ `Content-Type: application/zip` を付けるだけで 64MB を積める」
  // 経路になる(しかもパーサは preHandler より前に走るのでロールガードは間に合わない)。
  // 実体は zip を受ける 2 ルートを持つ `vivliostyleRoutes` の中に閉じてある。

  // 中央エラーハンドラ — ルート/preHandler の throw をここで AppError 形へ正規化する。
  app.setErrorHandler(errorHandler);

  // サーバ起動ごとに変わる epoch。配信する index.html に注入し、クライアントは前回値と
  // 突き合わせて「同一サーバ起動中のみログイン有効」を判定する(local モードの再起動検知。
  // REST は DB セッション失効が権威的だが、両モードでシェルを確実に作り直すために共有する)。
  const APP_EPOCH = String(Date.now());

  // SPA シェル: 起動時に epoch を埋め込んだ index.html をメモリ保持する(dev は Vite が
  // 配信するので dist が無く空文字)。読み込みが helmet 登録より前なのは、CSP の
  // script ハッシュを「実際に配信する文字列」から算出する必要があるため。
  const hasWebDist = fs.existsSync(config.webDist);
  const indexHtml = hasWebDist
    ? fs
        .readFileSync(path.join(config.webDist, 'index.html'), 'utf8')
        .replaceAll('%APP_EPOCH%', APP_EPOCH)
    : '';

  app.register(helmet, {
    // CSP は無効化しない。preview のリバースプロキシ(`/api/preview/:id/*`)は利用者が入れた
    // HTML/JS をアプリと同一オリジンで返すため、CSP を切ると被害者のセッションで任意
    // スクリプトが動く(承認 API の代理実行まで届く)。方針の中身は `config.buildCspDirectives`。
    contentSecurityPolicy: {
      useDefaults: true,
      directives: buildCspDirectives(inlineScriptCspHashes(indexHtml)),
    },
  });
  app.register(cookie); // reply.setCookie / reply.clearCookie を提供する

  // health だけは register prefix を介さず直付けなので、`/api` を明示合成する。
  app.get(`/api${apiPaths.health}`, async () => ({ ok: true }));

  app.register(openapiRoutes, { prefix: '/api' });
  app.register(authRoutes, { prefix: '/api', deps });
  app.register(vivliostyleRoutes, { prefix: '/api' });
  app.register(templatesRoutes, { prefix: '/api', deps });
  app.register(generateRoutes, { prefix: '/api', deps });
  app.register(partsRoutes, { prefix: '/api', deps });
  app.register(reviewsRoutes, { prefix: '/api', deps });
  app.register(historyRoutes, { prefix: '/api' });
  app.register(notesRoutes, { prefix: '/api' });
  app.register(usersRoutes, { prefix: '/api', deps });

  // API リファレンス UI(/api/docs)。標準 JS バンドルはプラグインがローカル配信するため
  // オフライン(air-gapped)でも動作する。Scalar のインライン起動 script はグローバル CSP の
  // ハッシュ許可に載らないため、専用 CSP ごと `docsRoutes` に閉じてある。
  app.register(docsRoutes);

  // 画面内プレビューのビューアホストページ。テンプレの inline JS を動かすために全域 CSP より
  // 緩い CSP が要るので、`docsRoutes` と同じく専用コンテキストへ閉じて登録する
  // (fastify-plugin を通さない = onSend がこのルート群だけに掛かる)。全域 CSP は動かさない。
  app.register(previewHostRoutes, { prefix: '/api' });

  // 他人のテンプレを nunjucks でコンパイルするためのレンダーホストページ。nunjucks は
  // コンパイラなので `'unsafe-eval'` が要り、承認者のページオリジンで走らせると申請者の JS が
  // 承認者のセッションを握る。同じく専用コンテキストへ閉じて登録する。
  app.register(renderHostRoutes, { prefix: '/api' });

  // 本番ではビルド済み SPA を配信する(Vite がアプリを配信する dev では no-op)。
  if (hasWebDist) {
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

    // catch-all。未知の `/api/*` は 404 JSON(Express の `^(?!\/api).*` catch-all が /api を除外し
    // 既定 404 を返していたのと同じ)。それ以外は SPA シェル(上でメモリ保持した `indexHtml`)を
    // 返す。認証状態の更新が確実に反映されるよう `no-store`(ブラウザの旧 epoch シェル再利用防止)。
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

  return app;
}
