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
// 初版は「宛先が loopback なら全ポート中継」だった。これは遮断として不十分である:
//   - `@vivliostyle/cli` は proxy の有無に関わらず Chromium へ `--disable-web-security` を
//     渡す(11.0.0 の `launchBrowser`)。SOP が無効なので、文書内 JS は `fetch` の**応答本文を
//     読める**。読めた内容を document へ書けば PDF に載る = 持ち出しが成立する。
//   - loopback には無認証で応答する面が現に居る。プレビューセッションの Vite dev サーバ
//     (`/@fs/…` や `/__open-in-editor`)がその代表で、これらを守っている
//     `previewProxy.allowForwardPath` は**我々のプロキシを通る要求にしか効かない** —
//     組版ブラウザはここから直結するので丸ごと迂回される。
// よって「そのビルドが自分の組版に使う 1 オリジンだけ」を許可し、他は loopback でも 502 に
// する。ポートは親が先に押さえて CLI へ `port` として渡すので(`reserveBuildOrigin`)、
// 事前に判らないという初版の前提はもう成り立たない。
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

/** 拒否時に返す本文。組版側のログに出るので、なぜ落ちたかが判る文言にする。 */
const BLOCKED_BODY =
  'この文書からオリジン外への通信は許可されていません' +
  '(PDF 組版のネットワークは、そのビルド専用の loopback オリジンのみ)。';

let server: http.Server | undefined;
let starting: Promise<string> | undefined;

/**
 * 中継を許可する loopback ポート。値は参照数で、同時に走る複数ビルドが同じ番地を
 * 押さえた場合でも、先に終わった側の解放で後続の許可が消えないようにする。
 *
 * **空 = 何も中継しない。** これが既定であり、許可はビルドが自分の枠を登録している間だけ
 * 開く(`reserveBuildOrigin`)。プレビュー経路は CLI にブラウザを起こさせない
 * (`openViewer:false`)ので、ここへ登録するものが無くても成立する。
 */
const allowedPorts = new Map<number, number>();

/**
 * 中継してよい宛先か。ホストは loopback、かつポートは登録済みの枠に限る。
 *
 * editor 自身の API ポートだけは、たとえ枠に入っていても通さない。枠は空きポートの周辺
 * `BUILD_PORT_SPAN` 個を機械的に取るので、番地の巡り合わせで API ポートを覆う可能性が
 * 理屈の上では残る。ここが覆われると、組版ブラウザから我々自身の API を叩けてしまう
 * (認証 cookie は載らないが、無認証面がある限り最悪の当たりになる)。
 */
function isForwardableTarget(target: URL): boolean {
  if (!isLoopbackHost(target.hostname)) return false;
  const port = target.port === '' ? 80 : Number(target.port);
  if (port === config.port) return false;
  return allowedPorts.has(port);
}

/** 空きポートを 1 つ観測する(押さえた直後に閉じるので、確保の保証はない)。 */
function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

/**
 * loopback ポートを許可枠へ入れ、取り消す関数を返す。**枠の登録はこの 1 関数だけ**にして、
 * 「どこかで直接 Map を触った」形が生まれないようにする。
 *
 * 通常のビルドは `reserveBuildOrigin` を使うこと(空きポートの選択込み)。これを直接使うのは
 * 「既に待受中のポートを許可したい」場合(テスト)に限る。
 * 戻り値は冪等 — 2 度呼んでも他のビルドの枠を巻き添えにしない。
 */
export function allowEgressPorts(ports: readonly number[]): () => void {
  for (const p of ports) allowedPorts.set(p, (allowedPorts.get(p) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const p of ports) {
      const n = (allowedPorts.get(p) ?? 1) - 1;
      if (n <= 0) allowedPorts.delete(p);
      else allowedPorts.set(p, n);
    }
  };
}

/** 1 ビルド分の許可枠。`port` を CLI の `port` オプションへ渡し、終了時に `release()` する。 */
export interface BuildOriginReservation {
  /** CLI に使わせるポート(Vite が繰り上げても許可範囲内に収まる)。 */
  port: number;
  /** 許可を取り消す。**必ず `finally` で呼ぶこと** — 呼び忘れは遮断の穴として残る。 */
  release(): void;
}

/**
 * このビルドが自分の組版に使う loopback オリジンを 1 つ押さえ、中継の許可へ登録する。
 * 許可はここで登録した連番ポートだけで、他の loopback ポート(editor の API・SQL Server・
 * 他利用者のプレビューセッション)は 502 で落ちる。
 */
export async function reserveBuildOrigin(): Promise<BuildOriginReservation> {
  const port = await pickFreePort();
  const ports = Array.from({ length: BUILD_PORT_SPAN }, (_, i) => port + i);
  return { port, release: allowEgressPorts(ports) };
}

/** テスト用: 現在許可されている loopback ポートの一覧(順序は登録順)。 */
export function allowedEgressPorts(): number[] {
  return [...allowedPorts.keys()];
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
function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
  let target: URL;
  try {
    target = new URL(req.url ?? '');
  } catch {
    // 相対形で来た = プロキシ用途ではない直接アクセス。中継しない。
    refuse(res, String(req.url));
    return;
  }
  if (target.protocol !== 'http:' || !isForwardableTarget(target)) {
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

/**
 * `startEgressGuard` の待受を開始し、プロキシ URL を返す(多重呼び出しは同じ URL)。
 * 起動に失敗したら**呼び出し側へ throw する** — 「プロキシ無しで組版する」へ静かに
 * 落とすと遮断ごと消えるので、fail closed にする。
 */
export function startEgressGuard(): Promise<string> {
  if (starting) return starting;
  const attempt = new Promise<string>((resolve, reject) => {
    const s = http.createServer(handleRequest);
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
      server = s;
      // サーバプロセスの終了を妨げない(このポートは組版中だけ意味がある)。
      s.unref();
      const { port } = s.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
  // 失敗した約束を握り続けると、以後の build が全部同じ失敗を再生し続ける(一時的な
  // EADDRINUSE で永続故障になる)。失敗時だけキャッシュを捨てて次回に再試行させる。
  // fail closed は保たれている — 呼び出し側へは毎回 reject が返るだけである。
  starting = attempt.catch((e: unknown) => {
    starting = undefined;
    throw e;
  });
  return starting;
}

/** テスト用の停止。次回の `startEgressGuard` は新しい待受を開く。 */
export async function stopEgressGuard(): Promise<void> {
  const s = server;
  server = undefined;
  starting = undefined;
  allowedPorts.clear();
  if (!s) return;
  await new Promise<void>((resolve) => s.close(() => resolve()));
}
