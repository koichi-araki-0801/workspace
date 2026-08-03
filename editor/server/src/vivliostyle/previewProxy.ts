// =============================================================================
// previewProxy.ts — リクエストをループバック Vite プレビューサーバへ中継する
// =============================================================================

import type { IncomingMessage, ServerResponse } from 'node:http';
import http from 'node:http';

// ── プロキシ応答のセキュリティヘッダ ──
// プレビュー内容(inline HTML、または zip 同梱のファイル)はアップロード元が任意に作れる。
// それをアプリと同一 origin(:24680)で配信するため、素のままだと文書内の script が
// 被害者のセッションでアプリ API を叩けてしまう(承認の自己成立など)。upstream の Vite は
// CSP を付けないので、ここで必ず上書きして付ける。
//
// vivliostyle CLI はビューアアプリを `/__vivliostyle-viewer/` に、入力文書を `base`
// (既定 `/vivliostyle/`)にマウントする。両者は別プロファイルで扱う:
//
// - ビューアアプリ側: script が必須。ビューアの knockout は data-bind 式を `new Function` で
//   組み立てるため `'unsafe-eval'` まで要る。ただし `'unsafe-inline'` は外す(ビューアの
//   index.html は外部 script のみで、Vite が差し込むクライアントも外部 module)。
// - 入力文書側: `script-src 'none'`。ビューアは文書を XHR で取得して自前で組版するので、
//   文書内の script が動かなくても組版結果は変わらない。効くのは「文書 URL を直接開いた
//   時」だけで、そこが攻撃経路そのもの。
//
// 判定は fail-close。「ビューア側と分かっている path だけ」をビューアプロファイルにし、
// 残りは文書プロファイルへ倒す。逆向き(未知はビューア扱い)にすると、文書の配信 path を
// ずらすだけで `script-src 'unsafe-eval'` の側へ逃げられる — 文書の配信先はアップロードされた
// `vivliostyle.config.json` の `base` で変えられ、`/%76ivliostyle/x.html` のような
// percent-encoding でも upstream(`decodeURI` で照合)には届くのに単純な前方一致は外れる。
// 逆に「文書をビューアの取り分へマウントする base」は入口で拒否する
// (`projectInput.assertSafeConfigBase`。下の接頭辞表と対で保つこと)。

/** ビューア側と確定できる path 接頭辞。これ以外はすべて文書として扱う。 */
const VIEWER_PATH_PREFIXES = [
  // vivliostyle CLI のビューアアプリ本体(`VIEWER_ROOT_PATH`)。
  '/__vivliostyle-viewer',
  // Vite の内部モジュール(`/@vite/client`・`/@fs/...`・`/@id/...`)と依存の事前バンドル。
  '/@',
  '/node_modules/',
];

/** ビューアアプリと Vite の内部モジュールに与える CSP。 */
const VIEWER_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-eval' blob:",
  "style-src 'self' 'unsafe-inline' data:",
  "img-src 'self' data: blob:",
  "font-src 'self' data: blob:",
  "connect-src 'self' data: blob:",
  "worker-src 'self' blob:",
  "frame-src 'self' data: blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

/** アップロード由来の入力文書に与える CSP(script は一切動かさない)。 */
const CONTENT_CSP = [
  "default-src 'self'",
  "script-src 'none'",
  "style-src 'self' 'unsafe-inline' data:",
  "img-src 'self' data: blob:",
  "font-src 'self' data: blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

/**
 * ビューア側 path か。query/fragment を落とした**生の**前方一致だけで判定し、
 * percent-encoding は解かない。ビューアと Vite が出す URL は常に素の literal なので、
 * 復号しないことで取りこぼすのは不正な形だけ = すべて文書側(厳しい方)へ落ちる。
 *
 * 逆に復号してから照合すると、`base` を `/%40x` にした文書の path が `/@x/...` に見えて
 * ビューア扱いになる(`decodeURI` は `@` を復号しないので upstream には届く)。
 * fail-close と組み合わせるなら、正規化は「しない」方が穴が無い。
 */
function isViewerPath(forwardPath: string): boolean {
  const raw = forwardPath.split(/[?#]/, 1)[0];
  return VIEWER_PATH_PREFIXES.some((p) => raw.startsWith(p));
}

/**
 * プロキシ応答へ付けるセキュリティヘッダを返す。`forwardPath` はプレビューサーバへ
 * 転送する残差パス(`/__vivliostyle-viewer/index.html` など。query 付きもありうる)。
 */
export function previewSecurityHeaders(forwardPath: string): Record<string, string> {
  return {
    'content-security-policy': isViewerPath(forwardPath) ? VIEWER_CSP : CONTENT_CSP,
    // 文書を text/plain 等で置いても、ブラウザに script/CSS として読み直させない。
    'x-content-type-options': 'nosniff',
  };
}

/**
 * リクエストをループバックの Vite プレビューサーバへリバースプロキシする。
 *
 * 生の Node `http` の `req`/`res` を直接扱う。Fastify ルートからは `reply.hijack()` 済みの
 * `request.raw` / `reply.raw` を渡す(Fastify による応答送出を抑止し、ここで応答を完全所有する)。
 *
 * プレビューサーバは HMR 無効で動くため通信は素の HTTP で、WebSocket の `upgrade`
 * 処理は不要。安全な(ボディなし)メソッドのみ転送する。プレビューは GET 駆動であり、
 * これによりボディパーサが既にリクエストストリームを消費済みである問題も回避できる。
 */
export function proxyToPreview(
  host: string,
  port: number,
  forwardPath: string,
  req: IncomingMessage,
  res: ServerResponse,
): void {
  const headers = { ...req.headers, host: `${host}:${port}` };
  const upstream = http.request(
    { host, port, method: req.method, path: forwardPath, headers },
    (up) => {
      res.statusCode = up.statusCode ?? 502;
      for (const [key, value] of Object.entries(up.headers)) {
        if (value !== undefined) res.setHeader(key, value);
      }
      // upstream 由来のヘッダより後に置き、上流が同名ヘッダを返しても必ずこちらが勝つ。
      for (const [key, value] of Object.entries(previewSecurityHeaders(forwardPath))) {
        res.setHeader(key, value);
      }
      up.pipe(res);
    },
  );
  upstream.on('error', () => {
    if (!res.headersSent) {
      res.statusCode = 502;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ kind: 'network', message: 'プレビューサーバに接続できません' }));
    } else {
      res.end();
    }
  });

  if (req.method === 'GET' || req.method === 'HEAD') upstream.end();
  else req.pipe(upstream);
}
