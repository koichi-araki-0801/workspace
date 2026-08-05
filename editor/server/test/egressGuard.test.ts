// =============================================================================
// egressGuard.test.ts — 組版ブラウザの外向き通信が本当に落ちることの主張
// =============================================================================
// 「遮断した」を設定値の見た目で主張しても意味が無いので、**実際にプロキシへ喋って**
// 許可枠は通り・それ以外は 502 になることを観測する。CONNECT(https トンネル)も同様に
// 実接続で確かめる — ここを通すと中身を見ずに任意ホストへ抜けられる。
//
// ⚠ 遮断の単位は「loopback かどうか」ではなく「**そのビルドが押さえたオリジンかどうか**」。
// loopback を全ポート通していた版は、SOP 無効(CLI が `--disable-web-security` を必ず渡す)の
// 組版ブラウザから、他利用者のプレビュー Vite サーバや editor 自身の API を読める状態だった。
import { EventEmitter } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import net from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  allowEgressPorts,
  allowedEgressPorts,
  reserveBuildOrigin,
  startEgressGuard,
  stopEgressGuard,
} from '../src/vivliostyle/egressGuard.js';

let proxyUrl: URL;
let origin: http.Server;
let originPort: number;
/** 起点サーバのポートを「そのビルドが押さえた枠」として登録したままにする。 */
let releaseOrigin: () => void;

beforeAll(async () => {
  proxyUrl = new URL(await startEgressGuard());
  origin = http.createServer((_req, res) => {
    res.statusCode = 200;
    res.end('LOOPBACK-OK');
  });
  await new Promise<void>((resolve) => origin.listen(0, '127.0.0.1', () => resolve()));
  originPort = (origin.address() as AddressInfo).port;
  // 中継は**登録した枠だけ**通る。起点サーバも登録しないと通らない(それが仕様)。
  releaseOrigin = allowEgressPorts([originPort]);
});

afterAll(async () => {
  releaseOrigin();
  await new Promise<void>((resolve) => origin.close(() => resolve()));
  await stopEgressGuard();
});

/** プロキシへ絶対形リクエストラインで投げる(Chromium がプロキシへ喋る形と同じ)。 */
function viaProxy(targetUrl: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: proxyUrl.hostname,
        port: Number(proxyUrl.port),
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
      const res = await viaProxy(`http://127.0.0.1:${dead.port}/x`);
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

// ── ここが今回の主眼 ── 「loopback だから通す」を捨てたことの主張。
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

  it('release 後は同じポートでも 502 になる(枠が開いたまま残らない)', async () => {
    const before = allowedEgressPorts().length;
    const r = await reserveBuildOrigin();
    expect(allowedEgressPorts().length).toBeGreaterThan(before);
    const port = r.port;
    r.release();
    expect(allowedEgressPorts().length).toBe(before);
    // 二重 release で他のビルドの枠を巻き添えにしない。
    r.release();
    expect(allowedEgressPorts().length).toBe(before);
    expect((await viaProxy(`http://127.0.0.1:${port}/x`)).status).toBe(502);
  });
});

describe('egressGuard — 起動の性質', () => {
  it('多重呼び出しでも同じ URL(ポートを増やさない)', async () => {
    const a = await startEgressGuard();
    const b = await startEgressGuard();
    expect(a).toBe(b);
  });

  it('loopback にしか bind しない(LAN からプロキシとして使われない)', () => {
    expect(proxyUrl.hostname).toBe('127.0.0.1');
  });

  it('起動していない状態で止めても壊れない', async () => {
    await stopEgressGuard();
    await expect(stopEgressGuard()).resolves.toBeUndefined();
    proxyUrl = new URL(await startEgressGuard());
    // `stopEgressGuard` は許可枠も落とすので、以降のテストのために張り直す。
    releaseOrigin = allowEgressPorts([originPort]);
  });

  // 起動失敗は fail closed(build ごと落とす)だが、**失敗した約束を握り続けてはいけない**。
  // 握ると一時的な EADDRINUSE がサーバ再起動まで続く永続故障になり、以後の PDF が全部
  // 同じ失敗を再生する。失敗はその 1 回で終わり、次の呼び出しは再試行できること。
  it('起動に失敗しても次の呼び出しで再試行できる(失敗を握り続けない)', async () => {
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
    proxyUrl = new URL(url);
    releaseOrigin = allowEgressPorts([originPort]);
  });
});
