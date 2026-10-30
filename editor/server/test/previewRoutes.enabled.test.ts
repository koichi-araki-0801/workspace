// =============================================================================
// previewRoutes.enabled.test.ts — 外部向けライブプレビューの既定 off と、所有者だけが開ける形
// =============================================================================
// `/api/preview*` の viewer は文書の `<script src>` を app のオリジンで動かす(ビューアが文書の
// script を自分の head に作り直す)。SPA も e2e も使っていない経路なので、設定
// `VIVLIO_PREVIEW_ENABLED` で有効にしない限り 404 にする。画面内プレビュー(`/api/preview-host/*`)
// は別の経路で、off でも配る。有効にしたときも、管理者が他人のセッションを開ける例外は持たない
// (URL で誘えば管理者のセッションで文書の script が動くため)。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { User } from '@editor/shared';
import type { FastifyInstance } from 'fastify';
import JSZip from 'jszip';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createSessionStub, decorateSessionStore } from './helpers/sessionStub.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-preview-enabled-'));
process.env.AUTH_REQUIRED = 'true';
process.env.AUDIT_DB = 'false';
process.env.DATA_ROOT = path.join(root, 'data');
process.env.TMP_DIR = path.join(root, 'tmp');
process.env.LOG_DIR = path.join(root, 'logs');
// 既定(未設定 = off)を確かめるため、外から渡された値を消しておく。
delete process.env.VIVLIO_PREVIEW_ENABLED;

vi.mock('../src/auth/session.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/auth/session.js')>()),
  sessionIdFrom: (cookieHeader: string | undefined) => cookieHeader || undefined,
}));

// 組版は本題ではない。inline プレビューの作業フォルダだけ実体で作る。
/** プレビューの展開が人ごとの数の主体として渡した値。 */
const slotUsers: unknown[] = [];
vi.mock('../src/vivliostyle/build.js', () => ({
  withBuildSlot: async (
    fn: (run: (o: unknown) => Promise<void>) => Promise<unknown>,
    user: unknown,
  ) => {
    slotUsers.push(user);
    return fn(async () => {});
  },
  buildProjectInSlot: async () => Buffer.from('%PDF'),
  buildInlinePdf: async () => Buffer.from('%PDF'),
  buildMergedPdf: async () => Buffer.from('%PDF'),
  prepareInlineDoc: async () => ({
    dir: fs.mkdtempSync(path.join(root, 'prev-')),
    config: { entry: ['doc/index.html'], base: '/vivliostyle' },
  }),
}));

// 所有者の判定は本物の `PreviewManager` で見る(起動するサーバだけ偽物)。
vi.mock('../src/vivliostyle/previewServer.js', async () => {
  const { PreviewManager } = await import('../src/vivliostyle/previewManager.js');
  return {
    previewManager: new PreviewManager({
      idleTtlMs: 60_000,
      maxSessions: 8,
      host: '127.0.0.1',
      starter: async () => ({ port: 1, close: async () => {} }),
    }),
  };
});

const userOf = (username: string, role: User['role']): User => ({
  id: `id-${username}`,
  username,
  displayName: username,
  role,
  disabled: false,
  mustChangePassword: false,
});
const USERS: Record<string, User> = {
  alice: userOf('alice', 'editor'),
  root: userOf('root', 'admin'),
};
const as = (sid: string) => ({ cookie: sid });

let app: FastifyInstance;
let config: typeof import('../src/config.js').config;

beforeAll(async () => {
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  ({ config } = await import('../src/config.js'));
  const Fastify = (await import('fastify')).default;
  const { errorHandler } = await import('../src/middleware/errorHandler.js');
  const { vivliostyleRoutes } = await import('../src/routes/vivliostyle.routes.js');
  const { previewHostRoutes } = await import('../src/vivliostyle/previewHost.js');
  app = Fastify();
  app.decorateRequest('user', undefined);
  decorateSessionStore(app, createSessionStub({ getSessionUser: (sid) => USERS[sid] ?? null }));
  app.setErrorHandler(errorHandler);
  app.register(vivliostyleRoutes, { prefix: '/api' });
  app.register(previewHostRoutes, { prefix: '/api' });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const ID = '00000000-0000-4000-8000-000000000000';

describe('VIVLIO_PREVIEW_ENABLED が未設定(既定 off)', () => {
  it('設定の既定は off', () => {
    expect(config.vivliostyle.preview.enabled).toBe(false);
  });

  it.each([
    ['GET', '/api/preview'],
    ['POST', '/api/preview'],
    ['GET', `/api/preview/${ID}`],
    ['DELETE', `/api/preview/${ID}`],
    ['GET', `/api/preview/${ID}/__vivliostyle-viewer/index.html`],
    ['HEAD', `/api/preview/${ID}/__vivliostyle-viewer/index.html`],
  ])('%s %s はログインしていても 404', async (method, url) => {
    const res = await app.inject({
      method: method as 'GET',
      url,
      headers: as('alice'),
      ...(method === 'POST' ? { payload: { html: '<p>x</p>', css: '' } } : {}),
    });
    expect(res.statusCode).toBe(404);
  });

  it('有効なうちに作ったセッションも、off に戻せば本人から 404', async () => {
    config.vivliostyle.preview.enabled = true;
    const started = await app.inject({
      method: 'POST',
      url: '/api/preview',
      headers: as('alice'),
      payload: { html: '<p>x</p>', css: '' },
    });
    config.vivliostyle.preview.enabled = false;
    expect(started.statusCode).toBe(201);
    const id = started.json().id as string;
    for (const [method, url] of [
      ['GET', `/api/preview/${id}`],
      ['GET', `/api/preview/${id}/__vivliostyle-viewer/index.html`],
      ['DELETE', `/api/preview/${id}`],
    ]) {
      const res = await app.inject({ method: method as 'GET', url, headers: as('alice') });
      expect(res.statusCode, `${method} ${url}`).toBe(404);
    }
  });

  it('未ログインの zip の POST も、本文を読む前に 404', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/preview',
      headers: { 'content-type': 'application/zip' },
      payload: Buffer.alloc(1024),
    });
    expect(res.statusCode).toBe(404);
  });

  it('画面内プレビューのホスト(/api/preview-host/index.html)は off でも 200', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/preview-host/index.html',
      headers: as('alice'),
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('有効にしたとき', () => {
  async function startAsAlice(): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/preview',
      headers: as('alice'),
      payload: { html: '<p>x</p>', css: '' },
    });
    expect(res.statusCode).toBe(201);
    return res.json().id as string;
  }

  it('管理者でも他人のセッションは開けず、止められず、一覧にも出ない', async () => {
    config.vivliostyle.preview.enabled = true;
    try {
      const id = await startAsAlice();
      const get = (sid: string, url: string) =>
        app.inject({ method: 'GET', url, headers: as(sid) });
      expect((await get('root', `/api/preview/${id}`)).statusCode).toBe(404);
      expect(
        (await get('root', `/api/preview/${id}/__vivliostyle-viewer/index.html`)).statusCode,
      ).toBe(404);
      expect((await get('root', '/api/preview')).json()).toEqual([]);
      const del = await app.inject({
        method: 'DELETE',
        url: `/api/preview/${id}`,
        headers: as('root'),
      });
      expect(del.statusCode).toBe(404);
      // 本人には見える(止められていない)。
      expect((await get('alice', `/api/preview/${id}`)).statusCode).toBe(200);
      expect(
        (await get('alice', '/api/preview')).json().map((m: { id: string }) => m.id),
      ).toContain(id);
    } finally {
      config.vivliostyle.preview.enabled = false;
    }
  });

  it('zip の展開はログイン ID を人ごとの数の主体として渡す', async () => {
    config.vivliostyle.preview.enabled = true;
    try {
      const z = new JSZip();
      z.file('index.html', '<p>x</p>');
      slotUsers.length = 0;
      const res = await app.inject({
        method: 'POST',
        url: '/api/preview',
        headers: { ...as('alice'), 'content-type': 'application/zip' },
        payload: await z.generateAsync({ type: 'nodebuffer' }),
      });
      expect(res.statusCode).toBe(201);
      expect(slotUsers).toEqual(['alice']);
    } finally {
      config.vivliostyle.preview.enabled = false;
    }
  });

  it('無認証モードでは `@local` が所有者として一致して通る', async () => {
    config.vivliostyle.preview.enabled = true;
    config.requireAuth = false;
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/preview',
        payload: { html: '<p>x</p>', css: '' },
      });
      expect(res.statusCode).toBe(201);
      const id = res.json().id as string;
      expect((await app.inject({ method: 'GET', url: `/api/preview/${id}` })).statusCode).toBe(200);
      const list = (await app.inject({ method: 'GET', url: '/api/preview' })).json();
      expect(list.map((m: { id: string }) => m.id)).toContain(id);
    } finally {
      config.requireAuth = true;
      config.vivliostyle.preview.enabled = false;
    }
  });
});
