// =============================================================================
// egressGuard.test.ts — 組版ブラウザの外向き通信が本当に落ちることの主張
// =============================================================================
// 「遮断した」を設定値の見た目で主張しても意味が無いので、**実際にプロキシへ喋って**
// 許可枠は通り・それ以外は 502 になることを観測する。CONNECT(https トンネル)も同様に
// 実接続で確かめる — ここを通すと中身を見ずに任意ホストへ抜けられる。
//
// ⚠ 遮断の単位は「loopback かどうか」でも「実行中のどれかのビルドの枠か」でもなく、
// 「**この中継を渡されたビルド自身の枠かどうか**」。loopback を全ポート通すと、
// SOP 無効(CLI が `--disable-web-security` を必ず渡す)の組版ブラウザから他利用者の
// プレビュー Vite サーバや editor 自身の API を読める。許可を 1 本の中継で共有すると、
// そこから「同時に走る別ビルドの本文」まで読める(このファイルの最後の describe)。
import { EventEmitter } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import net from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  activeEgressRelayCount,
  type BuildOriginReservation,
  reserveBuildOrigin,
  startEgressGuard,
  stopEgressGuard,
} from '../src/vivliostyle/egressGuard.js';

/** 1 ビルド分の枠。中継 URL と、その枠のポートで待つ「自分の Vite サーバ」役。 */
interface FakeBuild {
  reservation: BuildOriginReservation;
  proxyUrl: URL;
  originPort: number;
  origin: http.Server;
}

/**
 * 枠を取り、その枠のポートで実際に待ち受けるサーバを起こす(組版が自分の Vite サーバを
 * 立てるのと同じ形)。予約はポートを押さえっぱなしにしないので、ここで bind できる。
 */
async function startFakeBuild(body: string): Promise<FakeBuild> {
  const reservation = await reserveBuildOrigin();
  const origin = http.createServer((_req, res) => {
    res.statusCode = 200;
    res.end(body);
  });
  await new Promise<void>((resolve, reject) => {
    origin.once('error', reject);
    origin.listen(reservation.port, '127.0.0.1', () => resolve());
  });
  return {
    reservation,
    proxyUrl: new URL(reservation.proxyServer),
    originPort: (origin.address() as AddressInfo).port,
    origin,
  };
}

async function stopFakeBuild(build: FakeBuild): Promise<void> {
  build.reservation.release();
  await new Promise<void>((resolve) => build.origin.close(() => resolve()));
}

let build: FakeBuild;
let proxyUrl: URL;
let originPort: number;

beforeAll(async () => {
  build = await startFakeBuild('LOOPBACK-OK');
  proxyUrl = build.proxyUrl;
  originPort = build.originPort;
});

afterAll(async () => {
  await stopFakeBuild(build);
  await stopEgressGuard();
});

/** プロキシへ絶対形リクエストラインで投げる(Chromium がプロキシへ喋る形と同じ)。 */
function viaProxy(
  targetUrl: string,
  proxy: URL = proxyUrl,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: proxy.hostname,
        port: Number(proxy.port),
        method: 'GET',
        path: targetUrl,
        headers: { host: new URL(targetUrl).host },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          body += c;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('egressGuard — 自分のビルドのオリジンは通る(組版が成立する条件)', () => {
  it.each(['127.0.0.1', 'localhost'])('%s 宛(予約済みポート)は中継される', async (host) => {
    const res = await viaProxy(`http://${host}:${originPort}/doc.html`);
    expect(res.status).toBe(200);
    expect(res.body).toBe('LOOPBACK-OK');
  });

  // 10 進表記 `2130706433` は WHATWG URL が `127.0.0.1` へ正規化する。ブラウザも同じ
  // 正規化をするので、これを「偽装」として拒むのは誤り(本当に loopback を指している)。
  // 判定を `req.url` の字面ではなく `new URL()` の `hostname` で行っているのはこのため。
  it('10 進表記の loopback も loopback として扱う(URL 正規化がブラウザと一致する)', async () => {
    const decimal = 127 * 2 ** 24 + originPort * 0; // 2130706432 + 1 = 127.0.0.1
    const res = await viaProxy(`http://${decimal + 1}:${originPort}/doc.html`);
    expect(res.status).toBe(200);
    expect(res.body).toBe('LOOPBACK-OK');
  });

  // Vite が `port` の繰り上げをしても組版が落ちないための幅。無確認で配ると無関係な
  // リスナまで到達可能になるので、`pickFreePortSpan` は span の全ポートを bind して確かめる。
  it('枠は連番で、先頭が CLI へ渡す port(全ポートが空き確認済み)', () => {
    const ports = build.reservation.ports;
    expect(ports.length).toBeGreaterThan(1);
    expect(ports[0]).toBe(build.reservation.port);
    expect([...ports]).toEqual(ports.map((_, i) => ports[0] + i));
  });
});

describe('egressGuard — オリジン外は 1 バイトも出さない', () => {
  it.each([
    'http://evil.example/beacon?leak=1',
    'http://192.168.1.10/internal',
    'http://169.254.169.254/latest/meta-data/',
    'http://[2001:db8::1]/x',
    // `127.0.0.1` を字面に含むだけの外部ホスト。前方一致で通してはならない。
    'http://127.0.0.1.evil.example/x',
    'http://evil.example/x?h=127.0.0.1',
  ])('%s は 502 で落ちる', async (target) => {
    const res = await viaProxy(target);
    expect(res.status).toBe(502);
    expect(res.body).toContain('許可されていません');
  });

  // 中継先が予約済みでも繋がらないことはある(組版が終わってポートが閉じた後など)。
  // ここで例外が漏れると中継サーバごと落ち、以後の全 build が道連れになる。
  it('予約済みだが誰も待っていないポートは 502 で返す(中継が落ちない)', async () => {
    const dead = await reserveBuildOrigin();
    try {
      const res = await viaProxy(`http://127.0.0.1:${dead.port}/x`, new URL(dead.proxyServer));
      expect(res.status).toBe(502);
    } finally {
      dead.release();
    }
    // 続けて正常な宛先が中継できる = 中継サーバが生きている。
    expect((await viaProxy(`http://127.0.0.1:${originPort}/x`)).body).toBe('LOOPBACK-OK');
  });

  it('相対形リクエスト(プロキシ用途でない直接アクセス)も中継しない', async () => {
    const res = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        { host: proxyUrl.hostname, port: Number(proxyUrl.port), path: '/x' },
        (r) => resolve(r.statusCode ?? 0),
      );
      req.on('error', reject);
      req.end();
    });
    expect(res).toBe(502);
  });

  // CONNECT を許すと中身を見ないトンネルになる。組版に要るのは予約したオリジンの平文 HTTP
  // だけなので、宛先が loopback でも通さない(実測: 遮断前は Edge 自身が bing.com へ張っていた)。
  it.each(['evil.example:443', '127.0.0.1:443'])('CONNECT %s は張らせない', async (authority) => {
    const line = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(Number(proxyUrl.port), proxyUrl.hostname, () => {
        socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
      });
      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => {
        resolve(chunk.split('\r\n')[0]);
        socket.destroy();
      });
      socket.on('error', reject);
    });
    expect(line).toContain('502');
  });
});

// ── 「loopback だから通す」を捨てたことの主張 ──
// 組版ブラウザは SOP 無効で動くので、loopback の他サービスへ**届くこと自体**が持ち出し経路。
describe('egressGuard — 予約していない loopback ポートは通さない', () => {
  it('別プロセスが待っている loopback ポート(editor API / DB / 他人のプレビュー相当)は 502', async () => {
    const other = http.createServer((_req, res) => res.end('SECRET-FROM-OTHER-SERVICE'));
    await new Promise<void>((resolve) => other.listen(0, '127.0.0.1', () => resolve()));
    const otherPort = (other.address() as AddressInfo).port;
    try {
      const res = await viaProxy(`http://127.0.0.1:${otherPort}/@fs/C:/secret`);
      expect(res.status).toBe(502);
      expect(res.body).not.toContain('SECRET-FROM-OTHER-SERVICE');
    } finally {
      await new Promise<void>((resolve) => other.close(() => resolve()));
    }
  });

  it('ポート省略(80 番)の loopback も予約が無ければ 502', async () => {
    const res = await viaProxy('http://127.0.0.1/x');
    expect(res.status).toBe(502);
  });

  it('release 後は中継ごと畳まれる(枠が開いたまま残らない)', async () => {
    const before = activeEgressRelayCount();
    const r = await reserveBuildOrigin();
    expect(activeEgressRelayCount()).toBe(before + 1);
    r.release();
    expect(activeEgressRelayCount()).toBe(before);
    // 二重 release で他のビルドの中継を巻き添えにしない。
    r.release();
    expect(activeEgressRelayCount()).toBe(before);
    // 畳んだ中継はもう喋らない(繋がらないので接続そのものが失敗する)。
    await expect(
      viaProxy(`http://127.0.0.1:${r.port}/x`, new URL(r.proxyServer)),
    ).rejects.toThrow();
  });
});

// ── ここが主眼 ── 許可を 1 本の中継で共有すると、`allowedPorts` が
// 「実行中の全ビルドの予約ポートの和集合」になる。SOP 無効の組版ブラウザでは、
// これは「A の文書に埋めた JS が B の本文を読んで自分の PDF へ書き写す」経路そのもの。
describe('egressGuard — 同時に走る別ビルドのオリジンへは中継しない', () => {
  it('A の中継から B の枠は 502(和集合になっていない)', async () => {
    const a = await startFakeBuild('SECRET-OF-BUILD-A');
    const b = await startFakeBuild('SECRET-OF-BUILD-B');
    try {
      // 前提: どちらのビルドも自分のオリジンへは届いている(遮断が強すぎるのではない)。
      expect((await viaProxy(`http://127.0.0.1:${a.originPort}/`, a.proxyUrl)).body).toBe(
        'SECRET-OF-BUILD-A',
      );
      expect((await viaProxy(`http://127.0.0.1:${b.originPort}/`, b.proxyUrl)).body).toBe(
        'SECRET-OF-BUILD-B',
      );
      // 主張: 互いの枠へは 1 バイトも出ない。
      const aToB = await viaProxy(`http://127.0.0.1:${b.originPort}/`, a.proxyUrl);
      expect(aToB.status).toBe(502);
      expect(aToB.body).not.toContain('SECRET-OF-BUILD-B');
      const bToA = await viaProxy(`http://127.0.0.1:${a.originPort}/`, b.proxyUrl);
      expect(bToA.status).toBe(502);
      expect(bToA.body).not.toContain('SECRET-OF-BUILD-A');
    } finally {
      await stopFakeBuild(a);
      await stopFakeBuild(b);
    }
  });

  // 中継を分けても span が相手のポートを覆えば届いてしまう。OS の ephemeral 割当は
  // 近接した番地を続けて配るので、重なりの禁止が無いと連続する 2 予約はほぼ必ず重なる
  // (この主張が無いと上のテストが「たまたま通る」に化ける)。
  it('同時に取った枠どうしは 1 ポートも重ならない', async () => {
    const reservations = await Promise.all(Array.from({ length: 5 }, () => reserveBuildOrigin()));
    try {
      const seen = new Set<number>();
      for (const r of reservations) {
        for (const p of r.ports) {
          expect(seen.has(p), `port ${p} が 2 つの予約に入っている`).toBe(false);
          seen.add(p);
        }
      }
    } finally {
      for (const r of reservations) r.release();
    }
  });

  // 中継自身の待受ポートを転送先にすると、隣の中継を踏み台にする形が作れる。
  it('別ビルドの中継の待受ポートそのものへも中継しない', async () => {
    const other = await reserveBuildOrigin();
    try {
      const res = await viaProxy(`http://${new URL(other.proxyServer).host}/x`);
      expect(res.status).toBe(502);
    } finally {
      other.release();
    }
  });
});

describe('egressGuard — 共有中継(プレビュー経路)の性質', () => {
  it('多重呼び出しでも同じ URL(ポートを増やさない)', async () => {
    const a = await startEgressGuard();
    const b = await startEgressGuard();
    expect(a).toBe(b);
  });

  // 共有中継は枠を 1 つも持たない = 既定は全遮断。ビルドは自分の中継で上書きする。
  it('共有中継はどのビルドの枠も通さない', async () => {
    const shared = new URL(await startEgressGuard());
    const res = await viaProxy(`http://127.0.0.1:${originPort}/doc.html`, shared);
    expect(res.status).toBe(502);
    expect(res.body).not.toContain('LOOPBACK-OK');
  });

  it('loopback にしか bind しない(LAN からプロキシとして使われない)', () => {
    expect(proxyUrl.hostname).toBe('127.0.0.1');
    expect(new URL(build.reservation.proxyServer).hostname).toBe('127.0.0.1');
  });

  it('起動していない状態で止めても壊れない', async () => {
    await stopEgressGuard();
    await expect(stopEgressGuard()).resolves.toBeUndefined();
    expect(new URL(await startEgressGuard()).hostname).toBe('127.0.0.1');
    // `stopEgressGuard` はビルド専用の中継も畳むので、以降のテストのために張り直す。
    build = await startFakeBuild('LOOPBACK-OK');
    proxyUrl = build.proxyUrl;
    originPort = build.originPort;
  });

  // 起動失敗は fail closed(build ごと落とす)だが、**失敗した約束を握り続けてはいけない**。
  // 握ると一時的な EADDRINUSE がサーバ再起動まで続く永続故障になり、以後の PDF が全部
  // 同じ失敗を再生する。失敗はその 1 回で終わり、次の呼び出しは再試行できること。
  it('起動に失敗しても次の呼び出しで再試行できる(失敗を握り続けない)', async () => {
    await stopFakeBuild(build);
    await stopEgressGuard();
    const boom = vi.spyOn(http, 'createServer').mockImplementation(() => {
      const fake = new EventEmitter() as unknown as http.Server;
      (fake as unknown as { listen: () => void }).listen = () => {
        setImmediate(() => fake.emit('error', new Error('EADDRINUSE')));
      };
      return fake;
    });
    await expect(startEgressGuard()).rejects.toThrow('EADDRINUSE');
    boom.mockRestore();
    const url = await startEgressGuard();
    expect(new URL(url).hostname).toBe('127.0.0.1');
    build = await startFakeBuild('LOOPBACK-OK');
    proxyUrl = build.proxyUrl;
    originPort = build.originPort;
  });
});
