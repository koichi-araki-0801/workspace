// =============================================================================
// report.routes.test.ts — create_report 連携の 4 ルート(権限・応答の形)
// =============================================================================
// 生成の境界(`generate/createReport.js`)だけ差し替え、ルート→reportRepo→検査は本物を通す。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSessionStub, decorateSessionStore } from './helpers/sessionStub.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-report-routes-'));
process.env.AUTH_REQUIRED = 'true';
process.env.DATA_ROOT = path.join(root, 'data');
process.env.GIT_REPO_DIR = path.join(root, 'data');
process.env.TEMPLATES_DIR = path.join(root, 'data', 'templates');
process.env.FILLED_DIR = path.join(root, 'data', 'filled');
process.env.LOG_DIR = path.join(root, 'logs');
const templatesDir = path.join(root, 'data', 'templates');
const filledDir = path.join(root, 'data', 'filled');

const m = vi.hoisted(() => ({
  generateFilled: vi.fn(),
  generateReportPdf: vi.fn(),
  report: undefined as unknown,
  role: 'editor',
}));
vi.mock('../src/generate/createReport.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/generate/createReport.js')>()),
  generateFilled: m.generateFilled,
  generateReportPdf: m.generateReportPdf,
}));
vi.mock('../src/git/gitRepo.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/git/gitRepo.js')>()),
  ensureRepo: async () => undefined,
  commitAll: async () => 'sha',
}));
vi.mock('../src/config.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/config.js')>();
  return {
    ...real,
    config: new Proxy(real.config, {
      get: (t, k) => (k === 'report' ? m.report : Reflect.get(t, k)),
    }),
  };
});
vi.mock('../src/auth/session.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/auth/session.js')>()),
  sessionIdFrom: () => 'test-session',
}));

const ID = 'XX01_950037_20240710_交付版';

/** 監査(`audit`)が `logger.info` へ流すレコードのうち、指定イベントのものを返す。 */
function auditRecords(spy: { mock: { calls: unknown[][] } }, event: string) {
  return spy.mock.calls
    .map((c) => c[0] as Record<string, unknown>)
    .filter((r) => r?.type === 'audit' && r.event === event);
}

describe('report routes', () => {
  let app: FastifyInstance;
  let logger: typeof import('../src/logger.js').logger;

  beforeAll(async () => {
    // env を読む config を引く logger は、環境変数の設定後に読む。
    ({ logger } = await import('../src/logger.js'));
    const Fastify = (await import('fastify')).default;
    const { errorHandler } = await import('../src/middleware/errorHandler.js');
    const { reportRoutes } = await import('../src/routes/report.routes.js');
    const { createSprocClient } = await import('../src/db/sproc.js');
    const { createDeps } = await import('../src/deps.js');
    const { SP } = await import('../src/db/sprocNames.js');
    const sproc = createSprocClient(async (sql, values) => {
      if (sql.includes(SP.template) && values[0] === '委託会社一覧') {
        return [{ 委託会社コード: 'R-XX01', 委託会社名: '会社 1', 委託会社略称: 'XX01' }];
      }
      return [];
    });
    const store = createSessionStub({
      getSessionUser: () => ({
        id: 'u1',
        username: 'u1',
        displayName: 'u1',
        role: m.role,
        disabled: false,
        mustChangePassword: false,
      }),
    });
    const deps = createDeps(sproc, store);
    app = Fastify();
    decorateSessionStore(app, store);
    app.setErrorHandler(errorHandler);
    app.addHook('onRequest', async (req) => {
      req.user = { username: 'u1', role: m.role } as never;
    });
    await app.register(reportRoutes, { deps });
    await app.ready();
  }, 30_000);
  afterAll(async () => {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
  beforeEach(() => {
    m.role = 'editor';
    m.report = {};
    m.generateFilled.mockReset().mockResolvedValue({ created: true });
    m.generateReportPdf.mockReset().mockResolvedValue(Buffer.from('%PDF-1.7'));
    fs.rmSync(templatesDir, { recursive: true, force: true });
    fs.mkdirSync(templatesDir, { recursive: true });
    fs.rmSync(filledDir, { recursive: true, force: true });
    fs.mkdirSync(filledDir, { recursive: true });
    fs.writeFileSync(path.join(filledDir, `${ID}.html`), '<p>filled</p>');
    fs.writeFileSync(path.join(templatesDir, 'XX01_950037_交付版.html'), '<p>t</p>');
    fs.writeFileSync(path.join(templatesDir, 'XX01_950037_20240710_交付版.html'), '<p>x</p>');
  });

  it('POST fill is 403 for viewer', async () => {
    m.role = 'viewer';
    const res = await app.inject({ method: 'POST', url: `/templates/${ID}/fill` });
    expect(res.statusCode).toBe(403);
    expect(m.generateFilled).not.toHaveBeenCalled();
  });

  it('POST fill returns {created:true}', async () => {
    fs.rmSync(path.join(filledDir, `${ID}.html`));
    const res = await app.inject({ method: 'POST', url: `/templates/${ID}/fill` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ created: true });
    expect(m.generateFilled).toHaveBeenCalledWith(ID, 'R-XX01');
  });

  it('POST report-pdf returns application/pdf', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/templates/${ID}/report-pdf`,
      payload: { html: '<p>ok</p>' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.rawPayload.toString()).toBe('%PDF-1.7');
  });

  it('POST report-pdf is 400 for empty html and 200 for viewer', async () => {
    const bad = await app.inject({
      method: 'POST',
      url: `/templates/${ID}/report-pdf`,
      payload: { html: '' },
    });
    expect(bad.statusCode).toBe(400);
    m.role = 'viewer';
    const res = await app.inject({
      method: 'POST',
      url: `/templates/${ID}/report-pdf`,
      payload: { html: '<p>ok</p>' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
  });

  it('POST fill failure is 502 and audited as report.fill failure', async () => {
    fs.rmSync(path.join(filledDir, `${ID}.html`));
    const spy = vi.spyOn(logger, 'info');
    m.generateFilled.mockRejectedValue(
      Object.assign(new Error('boom'), { kind: 'unexpected', statusCode: 502 }),
    );
    const res = await app.inject({ method: 'POST', url: `/templates/${ID}/fill` });
    expect(res.statusCode).toBe(502);
    expect(auditRecords(spy, 'report.fill')).toEqual([
      expect.objectContaining({
        outcome: 'failure',
        actor: 'u1',
        resource: { templateId: ID },
        error: 'boom',
      }),
    ]);
  });

  it('POST fill success is audited with created', async () => {
    fs.rmSync(path.join(filledDir, `${ID}.html`));
    const spy = vi.spyOn(logger, 'info');
    await app.inject({ method: 'POST', url: `/templates/${ID}/fill` });
    expect(auditRecords(spy, 'report.fill')).toEqual([
      expect.objectContaining({
        outcome: 'success',
        resource: { templateId: ID },
        detail: { created: true },
      }),
    ]);
  });

  it('POST report-pdf success is audited with pdfBytes', async () => {
    const spy = vi.spyOn(logger, 'info');
    await app.inject({
      method: 'POST',
      url: `/templates/${ID}/report-pdf`,
      payload: { html: '<p>ok</p>' },
    });
    expect(auditRecords(spy, 'report.pdf')).toEqual([
      expect.objectContaining({
        outcome: 'success',
        resource: { templateId: ID },
        detail: { pdfBytes: 8 },
      }),
    ]);
  });

  it('POST report-pdf rejection is 400 and audited as report.pdf failure', async () => {
    const spy = vi.spyOn(logger, 'info');
    const res = await app.inject({
      method: 'POST',
      url: `/templates/${ID}/report-pdf`,
      payload: { html: '<img src="https://evil.example/x.png">' },
    });
    expect(res.statusCode).toBe(400);
    expect(m.generateReportPdf).not.toHaveBeenCalled();
    expect(auditRecords(spy, 'report.pdf')).toEqual([
      expect.objectContaining({ outcome: 'failure', resource: { templateId: ID } }),
    ]);
  });

  it('POST fill for an unknown company is 400 with REPORT_COMPANY_UNKNOWN', async () => {
    const other = 'ZZ99_950037_20240710_交付版';
    fs.writeFileSync(path.join(templatesDir, 'ZZ99_950037_交付版.html'), '<p>t</p>');
    const res = await app.inject({ method: 'POST', url: `/templates/${other}/fill` });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'REPORT_COMPANY_UNKNOWN' });
  });

  it('POST report-pdf is 404 when filled is missing', async () => {
    fs.rmSync(path.join(filledDir, `${ID}.html`));
    const res = await app.inject({
      method: 'POST',
      url: `/templates/${ID}/report-pdf`,
      payload: { html: '<p>ok</p>' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('GET status returns enabled:false when report is unset', async () => {
    m.report = undefined;
    const res = await app.inject({ method: 'GET', url: '/report/status' });
    expect(res.json()).toEqual({ enabled: false });
    m.report = {};
    expect((await app.inject({ method: 'GET', url: '/report/status' })).json()).toEqual({
      enabled: true,
    });
  });

  it('GET skeletons lists templates/ entries only', async () => {
    const res = await app.inject({ method: 'GET', url: '/report/skeletons' });
    expect(res.json()).toEqual({
      skeletons: [{ companyCode: 'XX01', fundCode: '950037', editionType: '交付版' }],
    });
  });
});
