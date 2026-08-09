// =============================================================================
// egressGuard.ts — 組版ブラウザの外向き通信を「そのビルドのオリジン」だけに絞る中継
// =============================================================================
// PDF は CSP の無い headless ブラウザで組版される。サニタイザで能動コンテンツを削らない
// 方針(除去ではなく隔離)へ変えた以上、隔離の片翼として egress を塞ぐ必要がある。
//
// 実測で、文書中の**インライン `<script>` は組版時に実行される**(`@vivliostyle/core` が
// script 要素をビューアの window へ作り直して走らせる)。つまり `fetch('https://…')` は
// 現に書ける。加えて、塞ぐ前の観測では組版ブラウザ(システム Edge)自身が `www.bing.com` と
// `edge.microsoft.com` へ CONNECT していた — 文書に何も書かなくても、ビルドサーバの
// ネットワーク位置から外向き通信が出ていたということである。CSS の `@import` / `url()` も
// 組版エンジンが実際に取得するので、`security/externalRefs.ts` の入口検査を抜ける形が
// 1 つでもあれば egress は成立する。
//
// ── なぜ「到達不能なプロキシ + bypass」ではないのか(実測に基づく) ──
// `@vivliostyle/cli` 11.0.0 の `launchBrowser` は proxy 指定時に
// `--proxy-bypass-list=<利用者指定>;<-loopback>` を組む。`<-loopback>` は Chromium の
// 暗黙 loopback 免除を打ち消す指定で、**利用者指定の loopback 免除も効かなくなる**ことを
// 実測で確認した(`proxyBypass` に `localhost` / `127.0.0.1,localhost,[::1]` / `*` の
// いずれを渡しても、文書自体の取得が `net::ERR_PROXY_CONNECTION_FAILED` で失敗する)。
// つまり「行き止まりプロキシへ全部向ける」構成は文書ごと落とすので採れない。
//
// ── 採る構成 ──
// **登録した loopback オリジンにだけ中継する本物のプロキシ**を我々が立て、そこへ全部向ける。
//   - 宛先が「そのビルドが押さえた loopback の枠」→ 中継する(文書・同梱資産はここを通る)
//   - それ以外(loopback の他ポートを含む)→ 502 を返して 1 バイトも出さない
//   - CONNECT(https / トンネル)→ 常に拒否する。組版に要るのは loopback の平文 HTTP だけで、
//     トンネルを許すと中身を見ずに任意ホストへ抜ける穴になる
// bypass 指定の解釈に依存しないので、CLI や Chromium の版差で静かに無効化されない。
//
// ⚠ この中継はサーバプロセス(親)が持つ。ビルドは子プロセス(`pdf-build-worker*.mjs`)で
// 走るが、子は loopback 経由で親のこのポートへ繋ぐだけなので、子側に持ち込む必要はない。
//
// ── なぜ loopback ホストだけでは足りないのか(遮断をポート単位へ絞る理由)──
// 「宛先が loopback なら全ポート中継」は遮断として不十分である:
//   - `@vivliostyle/cli` は proxy の有無に関わらず Chromium へ `--disable-web-security` を
//     渡す(11.0.0 の `launchBrowser`)。SOP が無効なので、文書内 JS は `fetch` の**応答本文を
//     読める**。読めた内容を document へ書けば PDF に載る = 持ち出しが成立する。
//   - loopback には無認証で応答する面が現に居る。プレビューセッションの Vite dev サーバ
//     (`/@fs/…` や `/__open-in-editor`)がその代表で、これらを守っている
//     `previewProxy.allowForwardPath` は**我々のプロキシを通る要求にしか効かない** —
//     組版ブラウザはここから直結するので丸ごと迂回される。
// よって「そのビルドが自分の組版に使う 1 オリジンだけ」を許可し、他は loopback でも 502 に
// する。ポートは親が先に押さえて CLI へ `port` として渡すので(`reserveBuildOrigin`)、
// 「宛先が事前に判らない」ことはない。
//
// ── なぜ中継を**ビルドごとに立てる**のか(許可の和集合を作らないため)──
// 中継を 1 本だけ立て、許可ポートをプロセス全体で共有する 1 つの Map に足す形だと、
// `isForwardableTarget` が見るのは「**実行中の全ビルドの予約ポートの和集合**」で、
// 同時に走る別ビルドのオリジンまで通る。SOP 無効の組版ブラウザでは、これはそのまま
// 「A の文書に埋めた JS が B の Vite サーバから B の本文を読み、自分の PDF へ書き写す」
// 経路になる(既定 `poolSize` は 2 なので同時実行は普通に起きる)。
//
// 採ったのは **予約ごとに専用の中継リスナを立てる**案で、そのビルドの CLI にだけ
// `proxyServer` としてその URL を渡す(`build.ts` の `buildScope`)。宛先の判定は
// 「**この中継の枠か**」だけになり、他ビルドの枠は判定の入力に存在しないので和集合が
// 原理的に作れない。プロキシはブラウザの起動引数で決まるため、文書内 JS が自分の中継を
// 別のビルドのものへ差し替えることもできない。
//
// 採らなかった案: ビルドごとにランダムな資格情報を発行し、1 本の中継で
// `Proxy-Authorization` を見て枠を引く形。CLI 側の受け口は実在する(11.0.0 の
// inline-config に `proxyUser` / `proxyPass` があり、`launchPreview` が
// `page.authenticate({username, password})` へ渡す = puppeteer が CDP の
// `Fetch.authRequired` に応答する)。それでも採らない理由は 3 つある:
//   1. 資格情報が効くのは中継が 407 を返し、**puppeteer がそのページの認証要求に応答した**
//      ときだけ。`page.authenticate` はページ単位の設定なので、組版が別ページや worker から
//      取りに行く経路が 1 つでもあれば、そこは 407 のまま落ちて組版ごと死ぬ。
//   2. 遮断の成否が CLI と puppeteer の実装詳細(407 ハンドリング)へ従属する。版差で
//      静かに壊れないことを狙って bypass 依存を捨てたのに、同じ形の従属を戻すことになる。
//   3. そもそも資格情報が言えるのは「**そのブラウザ**が資格情報を持つ」ことだけで、粒度は
//      ブラウザ単位 = 中継を分ける案と同じ。得るものが無い分、単純な方を採る。
//
// 残余リスク: 遮断は HTTP プロキシ 1 本で実現しており、HTTP/HTTPS 以外(WebRTC の UDP 等)は
// この中継を通らない。OpenAPI の記述もその粒度に揃えてある。

import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { config, isLoopbackHost } from '../config.js';
import { logger } from '../logger.js';

/**
 * 上流(loopback)へ繋いだまま応答が来ない場合に諦めるまでの時間。組版は自分の Vite サーバ
 * から取るだけなので待つ理由が無く、待ち続けると build のタイムアウトまで枠を占有する。
 */
const FORWARD_TIMEOUT_MS = 30_000;

/**
 * 1 ビルドあたりに許可する連番ポートの数。
 *
 * 我々は空きポート `P` を押さえてから CLI へ `port: P` を渡すが、Vite の preview サーバは
 * `strictPort` 無指定だと `P` が塞がっていたとき `P+1`, `P+2`… と繰り上げる。`strictPort` を
 * 立てて 1 個に絞ると、押さえ〜起動の隙間で誰かが `P` を取った瞬間に**ビルドが失敗する**。
 * 数個の幅を許して失敗を避けつつ、許可範囲は自分が選んだ番地の周辺だけに留める。
 */
const BUILD_PORT_SPAN = 4;

/** 空き枠の取り直し回数。連番が空いていない番地・他のビルドと重なる番地を引くと消費する。 */
const PORT_SPAN_ATTEMPTS = 16;

/** 拒否時に返す本文。組版側のログに出るので、なぜ落ちたかが判る文言にする。 */
const BLOCKED_BODY =
  'この文書からオリジン外への通信は許可されていません' +
  '(PDF 組版のネットワークは、そのビルド専用の loopback オリジンのみ)。';

/** 中継 1 本。`allowed` はこの中継**だけ**が通す宛先で、他の中継とは共有しない。 */
interface EgressRelay {
  /** CLI の `proxyServer` へ渡すプロキシ URL。 */
  readonly url: string;
  /** 中継を閉じる(冪等)。 */
  close(): void;
}

/**
 * 生きている中継の実体。`stopEgressGuard` が取りこぼし無く閉じるために持つ。
 * 件数の上限はビルド行列の同時実行数(`buildWorkerPool.withSlot`)が与える — 枠を取る前に
 * 予約しない規律(`build.ts` の `withBuildSlot`)がここでも上限の根拠になっている。
 */
const relays = new Set<http.Server>();

/**
 * 生きている中継自身の待受ポート。**転送先には決してしない。**
 *
 * 中継 A から中継 B のポートへ中継してしまうと、B を踏み台にして B の枠へ届く形が
 * 理屈の上で作れる(相対形要求は B 側で落ちるので実害は無いが、番地の巡り合わせ次第の
 * 「たまたま安全」に寄りかからない)。
 */
const relayPorts = new Set<number>();

/**
 * 予約中の全ビルドの枠(和集合)。**枠を重ねさせないためだけに持つ。**
 *
 * 中継を分けても、A の span が B の使うポートを覆っていれば A から B へ届いてしまう
 * (実測: OS の ephemeral 割当は近接した番地を続けて配るので、素朴に取ると連続する
 * 2 つの予約はほぼ必ず重なる)。判定には使わない — 判定は各中継が持つ自分の枠だけを見る。
 */
const reservedPorts = new Set<number>();

/**
 * 枠を 1 つも持たない共有の中継(プレビュー経路用。全宛先を 502 にする)の起動。
 * 実体は `relays` が持つので、ここは URL のキャッシュだけを持つ。
 */
let sharedStarting: Promise<string> | undefined;

/**
 * 中継してよい宛先か。ホストは loopback、かつポートは**この中継の枠**に限る。
 *
 * editor 自身の API ポートだけは、たとえ枠に入っていても通さない。枠は空きポートの周辺
 * `BUILD_PORT_SPAN` 個を機械的に取るので、番地の巡り合わせで API ポートを覆う可能性が
 * 理屈の上では残る。ここが覆われると、組版ブラウザから我々自身の API を叩けてしまう
 * (認証 cookie は載らないが、無認証面がある限り最悪の当たりになる)。
 */
function isForwardableTarget(target: URL, allowed: ReadonlySet<number>): boolean {
  if (!isLoopbackHost(target.hostname)) return false;
  const port = target.port === '' ? 80 : Number(target.port);
  if (port === config.port) return false;
  if (relayPorts.has(port)) return false;
  return allowed.has(port);
}

/** 指定ポート(0 なら任意の空き)を実際に押さえる。押さえられなければ reject。 */
function listenProbe(port: number): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(port, '127.0.0.1', () => {
      probe.removeListener('error', reject);
      resolve(probe);
    });
  });
}

function closeProbe(probe: net.Server): Promise<void> {
  return new Promise((resolve) => probe.close(() => resolve()));
}

/**
 * 連番 `BUILD_PORT_SPAN` 個がまとめて空いている番地を 1 つ観測し、`reservedPorts` へ載せる
 * (bind は観測のためだけで、押さえた直後に閉じるので確保の保証はない)。
 *
 * **span の全ポートを実際に bind して確かめる。** 先頭 1 つだけ確かめていた版は、残りを
 * 無確認で許可枠へ入れていた — たまたまその番地に居る無関係な loopback リスナ(他利用者の
 * プレビュー Vite サーバなど)が、そのビルドから到達可能になる。
 *
 * **他のビルドの枠と重なる番地も使わない。** 中継を分けても、span が相手のポートを覆えば
 * そこから届いてしまう(OS の ephemeral 割当は近接した番地を続けて配るので、素朴に取ると
 * 連続する 2 予約はほぼ必ず重なる — テストで実測)。
 *
 * 外れた番地の probe は**閉じずに握ったまま**次の試行へ進む。閉じてしまうと OS が同じ番地を
 * 配り直し、同じ理由で外し続ける(進捗しない)。全部まとめて最後に閉じる。
 */
async function pickFreePortSpan(): Promise<number[]> {
  const held: net.Server[] = [];
  try {
    for (let attempt = 0; attempt < PORT_SPAN_ATTEMPTS; attempt += 1) {
      let base: number;
      try {
        const head = await listenProbe(0);
        held.push(head);
        base = (head.address() as AddressInfo).port;
      } catch {
        continue;
      }
      const ports = Array.from({ length: BUILD_PORT_SPAN }, (_, i) => base + i);
      // API ポートを覆う番地は端から使わない(`isForwardableTarget` の最終防御に頼らない)。
      if (ports.includes(config.port)) continue;
      if (ports.some((p) => reservedPorts.has(p))) continue;
      let free = true;
      for (const p of ports.slice(1)) {
        try {
          held.push(await listenProbe(p));
        } catch {
          // 連番の途中に先客が居た(または 65535 を跨いだ)。番地を替えて取り直す。
          free = false;
          break;
        }
      }
      if (!free) continue;
      for (const p of ports) reservedPorts.add(p);
      return ports;
    }
  } finally {
    await Promise.all(held.map(closeProbe));
  }
  throw new Error(`PDF 組版用の連番ポート ${BUILD_PORT_SPAN} 個を確保できませんでした`);
}

/**
 * 枠取りの直列化。**同時に probe させない。**
 *
 * 並行に走らせると、互いの probe が連番の途中を握って**誰も `BUILD_PORT_SPAN` 連番を
 * 取れない**ライブロックになる(実測: 5 本同時で全滅し、全員が試行回数を使い切った)。
 * 1 回の枠取りは数回の bind で終わるので、取り合いを順番待ちに変えるのが素直。
 */
let pickQueue: Promise<unknown> = Promise.resolve();

function pickFreePortSpanSerialized(): Promise<number[]> {
  const next = pickQueue.then(
    () => pickFreePortSpan(),
    () => pickFreePortSpan(),
  );
  // 直前の失敗で行列を止めない(失敗した約束を繋ぐと以後の全予約が同じ失敗を再生する)。
  pickQueue = next.catch(() => undefined);
  return next;
}

function refuse(res: http.ServerResponse, target: string): void {
  logger.warn({ type: 'egress.blocked', target }, 'PDF 組版からの外向き通信を遮断しました');
  res.statusCode = 502;
  res.setHeader('content-type', 'text/plain; charset=utf-8');
  res.end(BLOCKED_BODY);
}

/**
 * プロキシ要求を処理する。プロキシへ来る要求は絶対形リクエストライン
 * (`GET http://host:port/path HTTP/1.1`)なので、`req.url` をそのまま URL として解ける。
 */
function handleRequest(
  allowed: ReadonlySet<number>,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  let target: URL;
  try {
    target = new URL(req.url ?? '');
  } catch {
    // 相対形で来た = プロキシ用途ではない直接アクセス。中継しない。
    refuse(res, String(req.url));
    return;
  }
  if (target.protocol !== 'http:' || !isForwardableTarget(target, allowed)) {
    refuse(res, target.href);
    return;
  }
  const upstream = http.request(
    {
      protocol: 'http:',
      host: target.hostname,
      port: target.port === '' ? 80 : Number(target.port),
      method: req.method,
      path: `${target.pathname}${target.search}`,
      headers: req.headers,
      timeout: FORWARD_TIMEOUT_MS,
    },
    (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    },
  );
  upstream.on('error', () => {
    if (!res.headersSent) res.statusCode = 502;
    res.end();
  });
  req.pipe(upstream);
}

/** 枠 `allowed` だけを通す中継を 1 本立てる。**中継の生成はこの 1 関数だけ**にする。 */
function startRelay(allowed: ReadonlySet<number>): Promise<EgressRelay> {
  return new Promise((resolve, reject) => {
    const s = http.createServer((req, res) => handleRequest(allowed, req, res));
    // CONNECT は中身が見えないトンネル。loopback の平文 HTTP しか要らないので一律拒否する。
    s.on('connect', (req, socket) => {
      logger.warn(
        { type: 'egress.blocked', target: req.url, method: 'CONNECT' },
        'PDF 組版からの CONNECT を遮断しました',
      );
      socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    });
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      // サーバプロセスの終了を妨げない(このポートは組版中だけ意味がある)。
      s.unref();
      const { port } = s.address() as AddressInfo;
      relays.add(s);
      relayPorts.add(port);
      let closed = false;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close() {
          if (closed) return;
          closed = true;
          relays.delete(s);
          relayPorts.delete(port);
          // keep-alive の残り接続ごと落とす。閉じ残ると、枠を返したはずの中継が
          // 既存接続の上でだけ生き続ける。
          s.closeAllConnections();
          s.close();
        },
      });
    });
  });
}

/** 1 ビルド分の許可枠と、その枠専用の中継。 */
export interface BuildOriginReservation {
  /** CLI に使わせるポート(Vite が繰り上げても `ports` の中に収まる)。 */
  port: number;
  /** このビルドだけが到達できる連番ポート(先頭が `port`)。 */
  ports: readonly number[];
  /** このビルドの CLI へ渡すプロキシ URL。**他のビルドへは渡さないこと。** */
  proxyServer: string;
  /** 中継ごと枠を畳む。**必ず `finally` で呼ぶこと** — 呼び忘れは遮断の穴として残る。 */
  release(): void;
}

/**
 * このビルドが自分の組版に使う loopback オリジンを 1 つ押さえ、**その枠だけを通す中継**を
 * 立てる。許可はここで押さえた連番ポートだけで、他の loopback ポート(editor の API・
 * SQL Server・他利用者のプレビューセッション・**他のビルドの枠**)は 502 で落ちる。
 */
export async function reserveBuildOrigin(): Promise<BuildOriginReservation> {
  const ports = await pickFreePortSpanSerialized();
  let relay: EgressRelay;
  try {
    relay = await startRelay(new Set(ports));
  } catch (e) {
    // 中継が立たないなら枠も返す。返さないと以後の予約がこの番地を避け続ける(枠の枯渇)。
    for (const p of ports) reservedPorts.delete(p);
    throw e;
  }
  // 冪等にする。2 度目の release で枠を消すと、その番地を既に取り直した別のビルドの
  // 予約を `reservedPorts` から落とし、重なりの禁止が効かなくなる。
  let released = false;
  return {
    port: ports[0],
    ports,
    proxyServer: relay.url,
    release: () => {
      if (released) return;
      released = true;
      relay.close();
      for (const p of ports) reservedPorts.delete(p);
    },
  };
}

/**
 * 枠を 1 つも持たない共有の中継を起動し、その URL を返す(多重呼び出しは同じ URL)。
 * **既定は全遮断**で、これはプレビュー経路(`options.ts` の `sharedInlineConfig`)が
 * `proxyServer` を空にしないためだけに在る — CLI は空文字や `undefined` だと
 * `process.env.HTTP_PROXY` へフォールバックし、遮断ごと消える。
 * ビルド経路は自分の枠を持つ中継(`reserveBuildOrigin`)で**上書きする**。
 *
 * 起動に失敗したら**呼び出し側へ throw する** — 「プロキシ無しで組版する」へ静かに
 * 落とすと遮断ごと消えるので、fail closed にする。
 */
export function startEgressGuard(): Promise<string> {
  if (sharedStarting) return sharedStarting;
  const attempt = startRelay(new Set<number>()).then((relay) => relay.url);
  // 失敗した約束を握り続けると、以後の build が全部同じ失敗を再生し続ける(一時的な
  // EADDRINUSE で永続故障になる)。失敗時だけキャッシュを捨てて次回に再試行させる。
  // fail closed は保たれている — 呼び出し側へは毎回 reject が返るだけである。
  sharedStarting = attempt.catch((e: unknown) => {
    sharedStarting = undefined;
    throw e;
  });
  return sharedStarting;
}

/** テスト用: 生きている中継の本数(共有 1 本 + 予約中のビルドぶん)。 */
export function activeEgressRelayCount(): number {
  return relays.size;
}

/** テスト用の停止。共有・ビルド専用を問わず全部畳む。次回の起動は新しい待受を開く。 */
export async function stopEgressGuard(): Promise<void> {
  sharedStarting = undefined;
  const closing = [...relays].map((s) => {
    relays.delete(s);
    s.closeAllConnections();
    return new Promise<void>((resolve) => s.close(() => resolve()));
  });
  relayPorts.clear();
  reservedPorts.clear();
  await Promise.all(closing);
}
