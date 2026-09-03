// =============================================================================
// notes.entryId.test.ts — legacy id(`legacy:<pathKey>`)の URL パスパラメータ往復
// =============================================================================
// 旧形式メモの変換 ID は `legacy:<pathKey>`(`files/notesFile.ts` の `normalizeStored`)で、
// `pathKey` は `/` と `#` を含みうる(実物は `.page#1/cover#1` のような構造パスキー)。
// これが PATCH/DELETE の URL パスパラメータ `:entryId` として素通りするかは、パス区切りや
// URL fragment として誤解釈されると「旧形式メモだけ編集・削除が 404 になる」という形で
// 壊れる。新規メモ(id は乱数 UUID で `/` `#` を含まない)では絶対に再現しないため、旧形式
// ファイルが残っている環境でだけ踏む退行になり気づきにくい。
//
// URL は手で組まず `buildPath(apiPaths.noteEntry, ...)` で組み立てる。web 側
// (`api/rest/noteRepo.ts` 相当)も同じ関数で URL を組むため、ここでエスケープの往復を
// 固定すれば web とサーバの両方の契約を同時に守れる。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apiPaths, buildPath } from '@editor/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-notes-entryid-'));
process.env.DATA_ROOT = tmp;
// ローカルモード(認証を課さない構成)を明示する。ガードの通過自体はこのテストの主眼ではない
// (`auth.localMode.test.ts` が別途固定している)ので、ここでは素通りさせて経路そのものに絞る。
delete process.env.AUTH_REQUIRED;

const listNotes = vi.fn(async () => []);
const addNote = vi.fn(async () => {
  throw new Error('unused in this test');
});
const updateNote = vi.fn(
  async (
    templateId: string,
    entryId: string,
    _patch: { content?: string; status?: string },
    _loginId: string,
  ) => ({
    id: entryId,
    templateId,
    pathKey: '',
    content: 'x',
    createdAt: '',
    createdBy: '',
    updatedAt: null,
    updatedBy: null,
    status: 'open' as const,
    replyTo: null,
    kind: 'note' as const,
  }),
);
const deleteNote = vi.fn(async () => {});

vi.mock('../src/repositories/noteRepo.js', () => ({
  listNotes: (...a: unknown[]) => listNotes(...(a as [])),
  addNote: (...a: unknown[]) => addNote(...(a as [])),
  updateNote: (...a: unknown[]) => updateNote(...(a as [])),
  deleteNote: (...a: unknown[]) => deleteNote(...(a as [])),
}));

const TEMPLATE_ID = 'AM01_510037_20240710_交付版';
// `/` と `#` を両方含む legacy id。パス区切り・fragment いずれの誤解釈も検出できるよう選ぶ。
const LEGACY_ENTRY_ID = 'legacy:.page#1/cover#1';

describe('legacy id(`/`・`#` を含む)の PATCH/DELETE 往復', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const Fastify = (await import('fastify')).default;
    const { config } = await import('../src/config.js');
    expect(config.requireAuth).toBe(false);
    const { errorHandler } = await import('../src/middleware/errorHandler.js');
    const { notesRoutes } = await import('../src/routes/notes.routes.js');
    app = Fastify();
    app.decorateRequest('user', undefined);
    app.setErrorHandler(errorHandler);
    await app.register(notesRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('DELETE が 204 を返し、entryId が原文どおり届く', async () => {
    const url = buildPath(apiPaths.noteEntry, {
      templateId: TEMPLATE_ID,
      entryId: LEGACY_ENTRY_ID,
    });
    const res = await app.inject({ method: 'DELETE', url });
    expect(res.statusCode).toBe(204);
    expect(deleteNote).toHaveBeenCalledWith(TEMPLATE_ID, LEGACY_ENTRY_ID);
  });

  it('PATCH が 200 を返し、entryId が原文どおり届く', async () => {
    const url = buildPath(apiPaths.noteEntry, {
      templateId: TEMPLATE_ID,
      entryId: LEGACY_ENTRY_ID,
    });
    const res = await app.inject({ method: 'PATCH', url, payload: { content: 'x' } });
    expect(res.statusCode).toBe(200);
    expect(updateNote).toHaveBeenCalledWith(
      TEMPLATE_ID,
      LEGACY_ENTRY_ID,
      { content: 'x', status: undefined },
      'system',
    );
  });
});
