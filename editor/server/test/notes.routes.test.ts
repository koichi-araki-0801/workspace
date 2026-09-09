// =============================================================================
// notes.routes.test.ts — メモ API の権限宣言・本文検証・HTTP 結合(投稿・返信)
// =============================================================================
// 変更系ルートは `ROUTE_POLICY` へ宣言されていなければ起動時に落ちる。ここでは 4 経路が
// 宣言されていること(GET は閲覧可・変更系は editor 以上)と、空文字の本文を受け付けない
// ことを主張する。加えて、`notesRoutes` を最小の Fastify に載せて `app.inject()` で
// `POST /templates/:templateId/notes` の追加ハンドラ(親投稿・返信・`pathKey` 欠落の 400)を
// HTTP 経路ごと固定する(`history.routes.test.ts` と同じ流儀)。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apiPaths } from '@editor/shared';
import { AddNoteRequest, UpdateNoteRequest } from '@editor/shared/schemas';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// config を import する前に一時ディレクトリへ向ける(history.routes.test.ts と同方針)。
// メモは `dataRoot/notes/<templateId>.json` に永続化されるため、`DATA_ROOT` だけで足りる
// (専用の `NOTES_DIR` という設定キーは存在しない)。
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-notes-routes-'));
process.env.DATA_ROOT = tmp;

// ⚠ `routeGuards.js` は `middleware/auth.js` 経由で `config.js` を静的 import する。ESM は
// import 先を先に評価するため、これを本ファイル先頭の静的 import に置くと(過去の事故)
// 上の `process.env.DATA_ROOT` 代入より前に `config.js` が確定し、開発機の実 `dataRoot`
// (既定 `../../editor-data`)へ書き込む事故になる(`generate.routes.test.ts` の
// `sprocFake.js` と同じ理由の回避)。top-level await で env 設定の**後**に動的 import する。
const { ROUTE_POLICY } = await import('../src/routes/routeGuards.js');

/** `x-test-user` ヘッダがあれば `request.user` へ注入する(history.routes.test.ts と同方針)。 */
const as = (username: string): Record<string, string> => ({ 'x-test-user': username });

async function buildApp(): Promise<FastifyInstance> {
  const Fastify = (await import('fastify')).default;
  const { errorHandler } = await import('../src/middleware/errorHandler.js');
  const { notesRoutes } = await import('../src/routes/notes.routes.js');
  const instance = Fastify();
  instance.setErrorHandler(errorHandler);
  instance.addHook('onRequest', async (req) => {
    const username = req.headers['x-test-user'];
    if (typeof username === 'string') req.user = { username } as never;
  });
  await instance.register(notesRoutes);
  await instance.ready();
  return instance;
}

describe('メモ API の権限宣言', () => {
  it('4 経路すべてが宣言されている', () => {
    expect(ROUTE_POLICY[`GET /api${apiPaths.notes}`]).toBe('auth');
    expect(ROUTE_POLICY[`POST /api${apiPaths.notes}`]).toBe('editor');
    expect(ROUTE_POLICY[`PATCH /api${apiPaths.noteEntry}`]).toBe('editor');
    expect(ROUTE_POLICY[`DELETE /api${apiPaths.noteEntry}`]).toBe('editor');
  });

  it('旧 PUT 経路は宣言から消えている', () => {
    expect(ROUTE_POLICY[`PUT /api${apiPaths.notes}`]).toBeUndefined();
  });
});

describe('本文の検証', () => {
  it('空文字は追加・編集とも拒否する(削除は DELETE で明示する)', () => {
    expect(AddNoteRequest.safeParse({ pathKey: 'p', content: '   ' }).success).toBe(true);
    expect(AddNoteRequest.safeParse({ pathKey: 'p', content: '' }).success).toBe(false);
    expect(UpdateNoteRequest.safeParse({ content: '' }).success).toBe(false);
  });

  it('追加は返信先を受け、種別は持たない(旧クライアントの kind は捨てる)', () => {
    const parsed = AddNoteRequest.parse({
      pathKey: 'p',
      content: 'x',
      replyTo: 'p1',
      kind: 'note',
    });
    expect(parsed).not.toHaveProperty('kind');
    expect(parsed.replyTo).toBe('p1');
  });

  it('更新は本文か状態のどちらかが要る', () => {
    expect(UpdateNoteRequest.safeParse({}).success).toBe(false);
    expect(UpdateNoteRequest.safeParse({ status: 'resolved' }).success).toBe(true);
  });
});

describe('POST /templates/:templateId/notes(HTTP 結合)', () => {
  let app: FastifyInstance;
  const ID = 'AM01_510037_20240710_交付版';
  const url = `/templates/${encodeURIComponent(ID)}/notes`;

  beforeAll(async () => {
    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('POST は 201 で投稿を返し、返信は replyTo を保つ(kind は出ない)。pathKey 欠落は 400', async () => {
    const parent = await app.inject({
      method: 'POST',
      url,
      headers: as('editor1'),
      payload: { pathKey: 'p#1', content: '親', replyTo: null, kind: 'note' },
    });
    expect(parent.statusCode).toBe(201);
    expect(parent.json()).toMatchObject({
      pathKey: 'p#1',
      content: '親',
      status: 'open',
      replyTo: null,
      createdBy: 'editor1',
    });
    expect(parent.json()).not.toHaveProperty('kind');

    const reply = await app.inject({
      method: 'POST',
      url,
      headers: as('editor1'),
      payload: { pathKey: 'p#1', content: '子', replyTo: parent.json().id, kind: 'question' },
    });
    expect(reply.statusCode).toBe(201);
    expect(reply.json()).toMatchObject({ replyTo: parent.json().id });
    expect(reply.json()).not.toHaveProperty('kind');

    const missingPathKey = await app.inject({
      method: 'POST',
      url,
      headers: as('editor1'),
      payload: { content: 'x' },
    });
    expect(missingPathKey.statusCode).toBe(400);
  });

  it('GET は投稿一覧、PATCH は本文/状態を更新、DELETE は 204 で消す', async () => {
    const posted = await app.inject({
      method: 'POST',
      url,
      headers: as('editor1'),
      payload: { pathKey: 'p#2', content: '原文', replyTo: null, kind: 'note' },
    });
    const entryId = posted.json().id;

    const list = await app.inject({ method: 'GET', url, headers: as('editor1') });
    expect(list.statusCode).toBe(200);
    expect((list.json() as Array<{ id: string }>).some((e) => e.id === entryId)).toBe(true);

    const entryUrl = `/templates/${encodeURIComponent(ID)}/notes/${entryId}`;
    const patched = await app.inject({
      method: 'PATCH',
      url: entryUrl,
      headers: as('editor1'),
      payload: { content: '訂正後', status: 'resolved' },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({
      content: '訂正後',
      status: 'resolved',
      updatedBy: 'editor1',
    });

    const deleted = await app.inject({ method: 'DELETE', url: entryUrl, headers: as('editor1') });
    expect(deleted.statusCode).toBe(204);

    const listAfter = await app.inject({ method: 'GET', url, headers: as('editor1') });
    expect((listAfter.json() as Array<{ id: string }>).some((e) => e.id === entryId)).toBe(false);
  });

  // `actor()` の `req.user?.username ?? 'system'` は user 有り(上のテスト)/無しの両分岐を
  // 踏んで初めて branch 網羅になる。`x-test-user` ヘッダを送らないリクエストで `'system'` 側を
  // 踏む。
  it('user ヘッダが無ければ投稿者は system になる', async () => {
    const res = await app.inject({
      method: 'POST',
      url,
      payload: { pathKey: 'p#3', content: '無記名', replyTo: null, kind: 'note' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ createdBy: 'system' });
  });
});
