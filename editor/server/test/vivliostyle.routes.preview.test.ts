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
// build/preview の HTTP 契約が本題で、認証は本テストの対象外(requireAuth を no-op にする)。
process.env.AUTH_REQUIRED = 'false';

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

/**
 * 起動中セッション。`meta` は `PreviewSessionMeta`(`previewManager.ts` の公開契約
 * `{ id, mode, createdAt, expiresAt, url }`)そのものを保持し、`get`/`list` は加工せず
 * この値を返す(実装は `owned()` が引いた `Session.meta` をそのまま返す形と対称)。
 * `docBase`/`port` は `resolveFor`(中継専用)にしか要らない内部値なので meta には含めない。
 */
interface FakeSession {
  meta: {
    id: string;
    mode: 'inline' | 'project';
    createdAt: string;
    expiresAt: string;
    url: string;
  };
  docBase: string;
  port: number;
}
const sessions = new Map<string, FakeSession>();

vi.mock('../src/vivliostyle/previewServer.js', () => ({
  previewManager: {
    start: vi.fn(async (spec: { mode: 'inline' | 'project'; docBase: string }) => {
      const id = crypto.randomUUID();
      const now = Date.now();
      const meta = {
        id,
        mode: spec.mode,
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 60_000).toISOString(),
        url: `/api/preview/${id}/`,
      };
      sessions.set(id, { meta, docBase: spec.docBase, port: 1 });
      return meta;
    }),
    get: vi.fn((id: string) => sessions.get(id)?.meta),
    stop: vi.fn(async (id: string) => sessions.delete(id)),
    resolveFor: vi.fn((id: string) => {
      const s = sessions.get(id);
      return s ? { port: s.port, docBase: s.docBase } : undefined;
    }),
    list: vi.fn(() => [...sessions.values()].map((s) => s.meta)),
    touch: vi.fn(() => true),
  },
}));

/** 展開ディレクトリの残骸(拒否時に残っていないことの確認用。entry.test.ts と同じ手法)。 */
function tmpProjectDirs(): string[] {
  try {
    return fs
      .readdirSync(TEST_TMP_DIR)
      .filter((n) => n.startsWith('vivlio-') && !n.endsWith('.zip'));
  } catch {
    return [];
  }
}

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

  // `previewManager.list(actor)` は `PreviewSessionMeta[]`(`{ id, mode, createdAt, expiresAt,
  // url }`)を返す(`previewManager.ts:210-214`)。mock がそれと違う形(id 文字列の配列など)を
  // 返すと、ルートが実際に mock の戻りをそのまま JSON へ流しているかを検査できない
  // (`Array.isArray` だけでは形の食い違いを見逃す)。
  it('GET /preview はセッション一覧(previewManager.list の戻り = meta 配列)をそのまま返す', async () => {
    const started = (
      await app.inject({ method: 'POST', url: '/preview', payload: { html: '<p>x</p>', css: '' } })
    ).json();
    const res = await app.inject({ method: 'GET', url: '/preview' });
    expect(res.statusCode).toBe(200);
    const list = res.json() as Array<{ id: string; mode: string; createdAt: string; url: string }>;
    const entry = list.find((s) => s.id === started.id);
    expect(entry).toMatchObject({
      id: started.id,
      mode: 'inline',
      url: `/api/preview/${started.id}/`,
    });
    expect(typeof entry?.createdAt).toBe('string');
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

  // `/build/project` の `?entry=` 封じ込めは `vivliostyleRoutes.entry.test.ts` が見るが、
  // preview 起動(zip)は別ハンドラで同じ `projectOptions()` を呼ぶ独立した経路であり
  // (`vivliostyle.routes.ts:196-204`)、そちらでは未検証だった。ここは SSRF/path traversal の
  // 入口そのものなので、展開後ディレクトリの後始末(`cleanupProject`)込みで固定する。
  it('POST /preview(zip): 不正な ?entry= は 400 で、展開ディレクトリを残さない', async () => {
    const before = tmpProjectDirs();
    const startedBefore = sessions.size;
    const res = await app.inject({
      method: 'POST',
      url: '/preview?entry=../../../../etc/passwd',
      headers: { 'content-type': 'application/zip' },
      payload: zip,
    });
    expect(res.statusCode).toBe(400);
    // `entry` 検証(`projectOptions`)は `previewManager.start` を呼ぶより前で失敗するので、
    // 新規セッションが 1 件も増えない(= start に到達していない)ことも併せて固定する。
    expect(sessions.size).toBe(startedBefore);
    expect(tmpProjectDirs().filter((n) => !before.includes(n))).toEqual([]);
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
