// =============================================================================
// check-ports.mjs — e2e の直前に webServer 用ポートが空いていることを確かめる
// =============================================================================
// e2e の webServer(24680 / 24681)と制御ポート(24682)に、前回の e2e や開発中の dev サーバが
// 残っていると、playwright の起動が衝突して原因の読みにくい形で落ちる。`reuseExistingServer` は
// 両 webServer とも false なので古いサーバを使い回すことは無く、ここで確かめる価値は、起動前に
// 使用中のポートを名指しして早く分かりやすく落とすことにある。playwright が管理しない制御ポート
// も同じ方法で検査できる(`test:e2e` / `e2e:editor` の先頭で呼ぶ)。
//
// 判定は bind でなく **connect** で行う。Windows ではワイルドカードの bind が `127.0.0.1` /
// `::1` に居る listener と衝突しない(listen が成功する)ため、bind の成否は「空いている」の
// 証拠にならない。loopback の両アドレスへ接続を試み、どちらかが応じれば使用中とみなす
// (Fastify は `127.0.0.1`、Vite は `localhost` = 環境により `::1` で待つ)。

import { connect } from 'node:net';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const LOOPBACKS = ['127.0.0.1', '::1'];

/** `host:port` へ TCP 接続できれば true(= 誰かが待ち受けている)。拒否・到達不能・timeout は false。 */
export function isListening(port, host, timeoutMs = 1000) {
  return new Promise((done) => {
    const sock = connect({ port, host });
    const finish = (listening) => {
      sock.destroy();
      done(listening);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
  });
}

/** 使用中の `{ port, host }` を列挙する(空配列なら全部空き)。 */
export async function findBusyPorts(ports) {
  const busy = [];
  for (const port of ports) {
    for (const host of LOOPBACKS) {
      if (await isListening(port, host)) busy.push({ port, host });
    }
  }
  return busy;
}

// ── 実行部(直接起動時のみ。テストからの import では走らせない) ──
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const ports = process.argv.slice(2).map(Number);
  if (ports.length === 0 || ports.some((p) => !Number.isInteger(p) || p < 1 || p > 65535)) {
    console.error('使い方: node scripts/check-ports.mjs <port> [<port> ...]');
    process.exit(2);
  }
  const busy = await findBusyPorts(ports);
  if (busy.length > 0) {
    console.error(`[check-ports] 使用中: ${busy.map((b) => `${b.host}:${b.port}`).join(', ')}`);
    console.error(
      '[check-ports] 前回の e2e か開発中の dev サーバが残っています。このまま e2e を走らせると' +
        'サーバの起動が衝突するため中止します。サーバを停止してから再実行してください。',
    );
    process.exit(1);
  }
  console.log(`[check-ports] 空き: ${ports.join(', ')}`);
}
