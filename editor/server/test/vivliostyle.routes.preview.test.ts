// =============================================================================
// vivliostyle.routes.preview.test.ts — build 成功応答と preview セッションの HTTP 契約
// =============================================================================
// `vivliostyleRoutes.entry.test.ts` は `?entry=` の封じ込めだけを見る。ここでは成功経路
// (PDF の content-type・バイト列)と、preview の start / get / stop / resolveFor が
// previewManager の戻りをどう HTTP に写すか(空振りは 404 に合流、他人のセッションと区別
// しない)・中継が UUID でない id と許可リスト外のパスを上流へ出さずに 404 で止めることを
// 固定する。実 CLI も実ブラウザも起動しない。
//
// ⚠ brief は `previewManager.js` を `vi.mock` する想定だったが、`vivliostyle.routes.ts` が
// import するプロセス共有シングルトンは `previewServer.js` が export する(`previewManager.js`
// は `PreviewManager` クラスと型/`UUID_RE` を持つだけで、実 starter の配線は `previewServer.js`
// が行う)。`previewProxy.routes.test.ts` も同じ理由で `previewServer.js` 側を mock しており、
// 本ファイルもそれに合わせる(`previewManager.js` を mock しても route が参照する実体は差し
// 替わらない)。
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import JSZip from 'jszip';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// `extractProjectZip`(zip preview 経路)が実体で展開先を作るため、config を import する前に
// 専用の一時ディレクトリへ隔離する(`vivliostyleRoutes.entry.test.ts` と同方針)。
const TEST_TMP_DIR = path.join(
  os.tmpdir(),
  `editor-preview-routes-${process.pid}-${crypto.randomBytes(4).toString('hex')}`,
);
process.env.TMP_DIR = TEST_TMP_DIR;
process.env.DATA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-preview-routes-data-'));
process.env.AUDIT_DB = 'false';
process.env.LOG_DIR = path.join(TEST_TMP_DIR, 'logs');

// build 系 3 関数はテストごとに失敗させたいことがある(`auditedRethrow` の failure 分岐 =
// 監査ログを outcome=failure で記録する経路が、成功応答だけでは一度も踏まれない)。
// `generate.routes.test.ts` の `sprocFails` と同じ流儀でフラグを介して切り替える。
const buildFail = { inline: false, project: false, merge: false };

vi.mock('../src/vivliostyle/build.js', () => ({
  withBuildSlot: async (fn: (run: (o: unknown) => Promise<void>) => Promise<unknown>) =>
    fn(async () => {}),
  buildProjectInSlot: async () => {
    if (buildFail.project) throw new Error('project build failed(テストの意図的失敗)');
    return Buffer.from('%PDF-1.4 project');
  },
  buildInlinePdf: async () => {
    if (buildFail.inline) throw new Error('inline build failed(テストの意図的失敗)');
    return Buffer.from('%PDF-1.4 inline');
  },
  buildMergedPdf: async () => {
    if (buildFail.merge) throw new Error('merge build failed(テストの意図的失敗)');
    return Buffer.from('%PDF-1.4 merged');
  },
  prepareInlineDoc: async () => ({ dir: TEST_TMP_DIR, entry: path.join(TEST_TMP_DIR, 'x.html') }),
}));

/** 起動中セッション(id → mode/docBase/port)。実 Vite サーバは持たない。 */
const sessions = new Map<string, { mode: 'inline' | 'project'; docBase: string; port: number }>();

vi.mock('../src/vivliostyle/previewServer.js', () => ({
  previewManager: {
    start: vi.fn(async (spec: { mode: 'inline' | 'project'; docBase: string }) => {
      const id = crypto.randomUUID();
      sessions.set(id, { mode: spec.mode, docBase: spec.docBase, port: 1 });
      const now = Date.now();
      return {
        id,
        mode: spec.mode,
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 60_000).toISOString(),
        url: `/api/preview/${id}/`,
      };
    }),
    get: vi.fn((id: string) => {
      const s = sessions.get(id);
      if (!s) return undefined;
      return {
        id,
        mode: s.mode,
        createdAt: new Date().toISOString(),
        expiresAt: new Date().toISOString(),
        url: `/api/preview/${id}/`,
      };
    }),
    stop: vi.fn(async (id: string) => sessions.delete(id)),
    resolveFor: vi.fn((id: string) => {
      const s = sessions.get(id);
      return s ? { port: s.port, docBase: s.docBase } : undefined;
    }),
    list: vi.fn(() => [...sessions.keys()]),
    touch: vi.fn(() => true),
  },
}));

describe('vivliostyle build/preview の HTTP 契約', () => {
  let app: FastifyInstance;
  let zip: Buffer;

  beforeAll(async () => {
    const Fastify = (await import('fastify')).default;
    const { errorHandler } = await import('../src/middleware/errorHandler.js');
    const { vivliostyleRoutes } = await import('../src/routes/vivliostyle.routes.js');
    app = Fastify();
    app.setErrorHandler(errorHandler);
    await app.register(vivliostyleRoutes);
    await app.ready();

    const z = new JSZip();
    z.file('index.html', '<p>x</p>');
    zip = await z.generateAsync({ type: 'nodebuffer' });
  });
  afterAll(async () => {
    await app.close();
    fs.rmSync(TEST_TMP_DIR, { recursive: true, force: true });
    fs.rmSync(process.env.DATA_ROOT as string, { recursive: true, force: true });
  });

  it('POST /build(inline)は application/pdf のバイト列を返す', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/build',
      payload: { html: '<p>x</p>', css: '' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.rawPayload.subarray(0, 4).toString()).toBe('%PDF');
  });

  // `auditedRethrow` の failure 分岐(監査ログを outcome=failure で記録してから rethrow する)を
  // 通す。応答が 500(`unexpected` へ丸められる)になることが本命の主張ではなく、成功だけの
  // テストでは一度も呼ばれない `failure: () => ({ detail })` コールバックを踏むことが目的。
  it('POST /build(inline): ビルド失敗は失敗を監査してから 500 系で返す', async () => {
    buildFail.inline = true;
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/build',
        payload: { html: '<p>x</p>', css: '' },
      });
      expect(res.statusCode).toBeGreaterThanOrEqual(500);
    } finally {
      buildFail.inline = false;
    }
  });

  it('POST /build/merge は複数文書を 1 PDF にする', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/build/merge',
      payload: {
        documents: [
          { html: '<p>a</p>', css: '' },
          { html: '<p>b</p>', css: '' },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.toString()).toContain('merged');
  });

  it('POST /build/merge: ビルド失敗は失敗を監査してから 500 系で返す', async () => {
    buildFail.merge = true;
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/build/merge',
        payload: { documents: [{ html: '<p>a</p>', css: '' }] },
      });
      expect(res.statusCode).toBeGreaterThanOrEqual(500);
    } finally {
      buildFail.merge = false;
    }
  });

  it('POST /build/project: ビルド失敗は失敗を監査してから 500 系で返す', async () => {
    buildFail.project = true;
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/build/project',
        headers: { 'content-type': 'application/zip' },
        payload: zip,
      });
      expect(res.statusCode).toBeGreaterThanOrEqual(500);
    } finally {
      buildFail.project = false;
    }
  });

  it('GET /preview はセッション一覧を返す(previewManager.list への委譲)', async () => {
    await app.inject({ method: 'POST', url: '/preview', payload: { html: '<p>x</p>', css: '' } });
    const res = await app.inject({ method: 'GET', url: '/preview' });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json())).toBe(true);
  });

  it('POST /preview(inline)は 201 でセッション meta、不正ボディは 400', async () => {
    const bad = await app.inject({ method: 'POST', url: '/preview', payload: { nope: 1 } });
    expect(bad.statusCode).toBe(400);

    const res = await app.inject({
      method: 'POST',
      url: '/preview',
      payload: { html: '<p>x</p>', css: '' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ mode: 'inline' });
  });

  it('POST /preview(zip)は展開して project モードで起動する(?size= 指定も受ける)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/preview?size=A4',
      headers: { 'content-type': 'application/zip' },
      payload: zip,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ mode: 'project' });
  });

  it('GET /preview/:id は meta、未知 id は 404。DELETE は 204、二度目は 404(存在オラクルにしない)', async () => {
    const started = (
      await app.inject({ method: 'POST', url: '/preview', payload: { html: '<p>x</p>', css: '' } })
    ).json();

    expect((await app.inject({ method: 'GET', url: `/preview/${started.id}` })).statusCode).toBe(
      200,
    );
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/preview/22222222-2222-4222-8222-222222222222',
        })
      ).statusCode,
    ).toBe(404);

    expect((await app.inject({ method: 'DELETE', url: `/preview/${started.id}` })).statusCode).toBe(
      204,
    );
    expect((await app.inject({ method: 'DELETE', url: `/preview/${started.id}` })).statusCode).toBe(
      404,
    );
  });

  it('中継: UUID でない id・許可リスト外のパスは上流へ出ずに 404', async () => {
    const started = (
      await app.inject({ method: 'POST', url: '/preview', payload: { html: '<p>x</p>', css: '' } })
    ).json();

    expect(
      (await app.inject({ method: 'GET', url: '/preview/not-a-uuid/index.html' })).statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ method: 'GET', url: `/preview/${started.id}/@fs/etc/passwd` }))
        .statusCode,
    ).toBe(404);
  });
});
