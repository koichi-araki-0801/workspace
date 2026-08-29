// =============================================================================
// zipBodyParser.ts — project zip 本文のパーサ(受け付けるルートを限定して登録する)
// =============================================================================
// `application/zip` / `application/octet-stream` を Buffer 化して `request.body` に載せる。
// 使うのは vivliostyle の 2 ルート(`POST /build/project` と `POST /preview`)だけ。
//
// ── なぜ「登録する場所」が防御になるのか ──
// Fastify の content-type parser は encapsulation 単位で継承される。ルートインスタンスへ
// 登録すると**全ルート**へ伝播し、しかも関数形式のパーサ(`parseAs` を使わない形)は
// Fastify の `rawBody` を経由しないので `bodyLimit` が一切効かない。両者が重なると
// 「任意の POST/PUT に `Content-Type: application/zip` を付けるだけで `maxProjectBytes`
// (既定 64MB)をメモリへ積める」経路になる。パーサは preHandler より先に走るため、
// ロールガード(`requireEditor`)は 1 バイトも防げない。
//
// よって守りは 2 段にする:
//   1. 登録先を zip を受けるルートを含む plugin(`vivliostyleRoutes`)の内側だけにする。
//   2. パーサの先頭で**ルーティング結果の登録パターン**を許可リストと突き合わせ、
//      該当しなければ 1 バイトも読まずに 400 で返す。
// どちらか片方だけへ戻さないこと。
//
// ⚠ 本ファイルは plugin ではない(`FastifyInstance` を受け取る素の関数)。route module が
// 「関数を 1 つだけ export する」規約に乗っているため、補助 export はここへ置く
// (`test/routeGuards.test.ts` は module の関数 export を plugin とみなして register する)。

import { apiPaths, validation } from '@editor/shared';
import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';

/**
 * zip 本文を受け付けてよいルートの登録パターン(`prefix` 込み)。
 *
 * 照合に使うのは `request.routeOptions.url`(Fastify が実際にルーティングした登録パターン)
 * であって生の request target ではない。生 target は percent-encoding も dot セグメントも
 * 解かれていないため、そちらで照合すると `/api/build/%70roject` のような綴りで判定を外せる
 * (`config.preAuthGateUrl` が同じ理由で登録パターンを使っている)。
 */
export function zipBodyRoutesFor(prefix: string): ReadonlySet<string> {
  return new Set([`${prefix}${apiPaths.buildProject}`, `${prefix}${apiPaths.preview}`]);
}

/** 登録パターンが許可リストに載っているか(クエリ・フラグメントは落として比較する)。 */
export function isZipBodyRoute(allowed: ReadonlySet<string>, routedUrl: unknown): boolean {
  if (typeof routedUrl !== 'string') return false;
  return allowed.has(routedUrl.split(/[?#]/, 1)[0]);
}

/**
 * zip 本文のパーサを、この instance の encapsulation 内だけへ登録する。
 * 上限超過は 413 ではなく現行と同じ `validation`(400)で返すため関数形式で組む。
 */
export function registerZipBodyParser(app: FastifyInstance): void {
  const allowed = zipBodyRoutesFor(app.prefix);
  app.addContentTypeParser(
    ['application/zip', 'application/octet-stream'],
    (request, payload, done) => {
      // `done` は `Error` を期待するが、`AppError`(plain object)を渡しても setErrorHandler が
      // `toAppError`→`statusForKind('validation')`=400 で正規化する。
      const reject = (message: string) => validation(message) as unknown as Error;

      if (!isZipBodyRoute(allowed, request.routeOptions?.url)) {
        // 許可リスト外は 1 バイトも積まない。`payload` は読まずに放置する — 送信途中の
        // ストリームを destroy すると接続がリセットされ、クライアントは 400 を受け取れない。
        done(reject('この経路は zip 本文を受け付けません'), undefined);
        return;
      }

      const limit = config.vivliostyle.build.maxProjectBytes;
      const tooLarge = () => reject('プロジェクトが大きすぎます');

      // 申告サイズが上限超えなら受信前に断る。1 バイトも積まないので、上限ぎりぎりを詰めた
      // 同時接続でメモリを占有される窓が消える。
      const declared = Number(request.headers['content-length']);
      if (Number.isFinite(declared) && declared > limit) {
        done(tooLarge(), undefined);
        return;
      }

      const chunks: Buffer[] = [];
      let size = 0;
      payload.on('data', (c: Buffer) => {
        size += c.length;
        if (size > limit) {
          payload.destroy();
          done(tooLarge(), undefined);
          return;
        }
        chunks.push(c);
      });
      payload.on('end', () => done(null, Buffer.concat(chunks)));
      payload.on('error', (err) => done(err, undefined));
    },
  );
}
