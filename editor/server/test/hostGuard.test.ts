// =============================================================================
// hostGuard.test.ts — `Host` ヘッダの検査が入口で効くこと
// =============================================================================
// 塞ぐのは DNS リバインディング。攻撃者ページは自分のドメインの DNS を後から
// `127.0.0.1` へ向け替えられる。ブラウザは「まだ attacker.example と同一オリジン」と
// 考えたまま要求を出すため SameSite も CORS も効かず、唯一食い違うのが `Host` である。
//
// 効きどころは**認証を課さない配備**(既定の local モード)で、そこでは実質「loopback に
// 到達できること」だけが認可条件になっている。したがってここでは認証オフの構成で
// 「素通りしないこと」を主張する — 認証オンで 401 になるのは別の層の効果であり、
// この層の検証にならない。
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

process.env.AUTH_REQUIRED = 'false';

/**
 * `app.ts` の入口フックと同じ形を最小構成で組む。実 `app.ts` は import 時に dataRoot や
 * web dist を触るため、ここでは**検査そのもの**(`allowedHosts` + `isAllowedHost` + 403)を
 * 同じ実装で組み立てて主張する。実装が 1 つなので、置き場所が変わっても追随する。
 */
async function buildApp(): Promise<FastifyInstance> {
  const { allowedHosts, isAllowedHost } = await import('../src/config.js');
  const app = Fastify();
  app.addHook('onRequest', async (request, reply) => {
    if (isAllowedHost(request.headers.host, allowedHosts)) return;
    await reply.code(403).send();
  });
  app.get('/api/health', async () => ({ ok: true, secret: 'internal-marker' }));
  app.post('/api/generate', async () => ({ started: true }));
  await app.ready();
  return app;
}

let app: FastifyInstance | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

describe('Host ヘッダの検査', () => {
  it('loopback 名は通る(既存の運用を壊さない)', async () => {
    app = await buildApp();
    for (const host of ['localhost:24680', '127.0.0.1:24680', '[::1]:24680', 'LOCALHOST']) {
      const res = await app.inject({ method: 'GET', url: '/api/health', headers: { host } });
      expect(res.statusCode, host).toBe(200);
    }
  });

  it('攻撃者ドメインを名乗る要求は 403 で、本文を 1 バイトも返さない', async () => {
    app = await buildApp();
    for (const host of [
      'attacker.example',
      'attacker.example:24680',
      // 前方一致・後方一致で通してしまう実装への回帰網。
      'localhost.attacker.example',
      'attackerlocalhost',
      '127.0.0.1.attacker.example',
    ]) {
      const res = await app.inject({ method: 'GET', url: '/api/health', headers: { host } });
      expect(res.statusCode, host).toBe(403);
      // 存在オラクルにしない(本文で「この経路は在る」と教えない)。
      expect(res.body, host).not.toContain('internal-marker');
    }
  });

  it('変更系ルートも同じ入口で落ちる(検査はルートごとではない)', async () => {
    app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/generate',
      headers: { host: 'attacker.example' },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain('started');
  });
});

// ── 再構築形の限界と、それを埋める配線の検査 ──
//
// 上の describe が主張しているのは「`isAllowedHost` + 403 という**形**が正しく振る舞う」
// ことであって、「実 `app.ts` がその形で配線されている」ことではない。実 `app.ts` を
// そのまま inject へ載せる統合形は**採れない**: このモジュールはトップレベルで
// `app.listen()` まで走らせ、TLS 設定不備や `EADDRINUSE` で `process.exit(1)` を呼び、
// シグナルハンドラと worker pool も掴む(import しただけでテストランナーごと落ちうる)。
// 統合形にするには `app.ts` を `buildApp()` 工場へ割る本体側のリファクタが要るので、
// ここでは代わりに**配線そのものをソースで固定する**。再構築形が見られない
// 「フックの順序」と「本文を返さないこと」は、この検査だけが押さえている。
const APP_SOURCE = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/app.ts'),
  'utf8',
);

/** 最初に登録される `onRequest` フックの**本体だけ**を切り出す(後続フックの doc は含めない)。 */
function firstOnRequestHook(): string {
  const start = APP_SOURCE.indexOf("addHook('onRequest'");
  expect(start).toBeGreaterThan(0);
  const end = APP_SOURCE.indexOf('\n});', start);
  expect(end).toBeGreaterThan(start);
  return APP_SOURCE.slice(start, end);
}

describe('実 app.ts の Host 検査の配線', () => {
  it('同じ判定関数で検査している(再構築形と実体が食い違わない)', () => {
    expect(APP_SOURCE).toContain('isAllowedHost(request.headers.host, allowedHosts)');
  });

  it('Host 検査が最初の onRequest フックである', () => {
    // 「ここを通った後の判定は、要求がこちらのオリジン宛だという前提で書かれている」
    // (`app.ts` のコメント)。後ろへずらすと、認証前ゲート等が攻撃者ドメイン宛の要求を
    // 先に処理してしまう。順序は再構築形では原理的に見えないので、ここで押さえる。
    expect(firstOnRequestHook()).toContain('isAllowedHost');
  });

  it('拒否応答は本文を持たない(存在オラクルにしない)', () => {
    expect(firstOnRequestHook()).toContain('reply.code(403).send()');
  });

  it('`config.requireAuth` で出し分けていない(設定 1 つでガードが消える形にしない)', () => {
    expect(firstOnRequestHook()).not.toContain('requireAuth');
  });
});
