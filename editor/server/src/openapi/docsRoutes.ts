// =============================================================================
// docsRoutes.ts — API リファレンス UI(/api/docs)の登録と、その経路だけの CSP
// =============================================================================
// `/api/docs` は「vivliostyle build/preview の仕様は OpenAPI が正」と設計正典が名指しする
// 外部向けの面で、白紙になっても web UI のテストでは気付けない。専用の CSP をここに閉じ、
// 登録とセットで持つ。
import ScalarApiReference from '@scalar/fastify-api-reference';
import type { FastifyInstance } from 'fastify';
import { getOpenApiDocument } from './document.js';

/**
 * `/api/docs` にだけ効かせる CSP。
 *
 * Scalar は起動用スクリプトを `<script>Scalar.createApiReference(...)</script>` の**インライン**で
 * 吐き、その本文は OpenAPI ドキュメント全体を含む可変文字列になる。グローバル CSP
 * (`config.buildCspDirectives`)は SPA の index.html から採った sha256 ハッシュしか許さないため、
 * そのままではこのページだけブラウザが script を落として真っ白になる。
 *
 * nonce を渡す口はプラグイン側にあるが、`configuration` は登録時に固定されるためリクエスト
 * ごとに変えられない。起動中ずっと同じ nonce は、その値を読める誰にとっても
 * `'unsafe-inline'` と同義なので採らない。代わりに「この経路だけ `'unsafe-inline'`」と
 * 範囲を明示する。ここで描画するのはサーバ内で生成した OpenAPI ドキュメントだけで、
 * 利用者入力は混ざらない(混ぜるようになったら本方針を見直すこと)。
 */
const DOCS_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

/**
 * `/api/docs` 一式(HTML・同梱 JS)を登録する。呼び出し側は prefix 無しで register する
 * (`routePrefix` が絶対パスを持つため)。
 *
 * この関数は fastify-plugin を通さない = 独自コンテキストを作る。Scalar プラグイン自体は
 * fastify-plugin 済みでこのコンテキストへ直接ルートを足すので、下の `onSend` は
 * `/api/docs` のルートだけに掛かる。helmet はルート側の `onRequest` でヘッダを置き、
 * `onSend` はその後に走るため上書きが必ず勝つ。
 */
export async function docsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onSend', async (_request, reply) => {
    reply.header('content-security-policy', DOCS_CSP);
  });
  await app.register(ScalarApiReference, {
    routePrefix: '/api/docs',
    configuration: { content: getOpenApiDocument() },
  });
}
