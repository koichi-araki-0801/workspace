// =============================================================================
// reviews.routes.test.ts — 承認ワークフローの HTTP 結合テスト(ルート + repo + validate)
// =============================================================================
// `reviews.test.ts` は repo を直接叩くが、ここでは最小の Fastify に `reviewsRoutes` を載せ、
// `app.inject()` で HTTP 経路(パラメータ抽出 → validate → repo → errorHandler の HTTP 変換)を
// 検証する。認可ゲート(`requireApprover`)は `config.requireAuth=false` では no-op のため、
// `actor()` が読む `request.user` を onRequest フックでヘッダから注入し、ロール依存の挙動
// (一覧の可視範囲・自己承認拒否)を駆動する。実ファイル反映を伴う approve は git 前提。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// config を import する前に一時ディレクトリへ向ける(reviews.test.ts と同方針)。
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-review-routes-'));
process.env.DATA_ROOT = tmp;
process.env.GIT_REPO_DIR = tmp;
process.env.TEMPLATES_DIR = path.join(tmp, 'templates');
process.env.CSS_DIR = path.join(tmp, 'css');
process.env.REVIEWS_DIR = path.join(tmp, 'reviews');

let gitAvailable = true;
try {
  execFileSync('git', ['--version'], { stdio: 'ignore' });
} catch {
  gitAvailable = false;
}
const d = gitAvailable ? describe : describe.skip;

d('review workflow (HTTP routes)', () => {
  let app: FastifyInstance;

  /** ヘッダ x-test-user / x-test-role から `request.user` を注入して actor を駆動する。 */
  async function buildApp(): Promise<FastifyInstance> {
    const Fastify = (await import('fastify')).default;
    const { errorHandler } = await import('../src/middleware/errorHandler.js');
    const { reviewsRoutes } = await import('../src/routes/reviews.routes.js');
    const instance = Fastify();
    instance.setErrorHandler(errorHandler);
    instance.addHook('onRequest', async (req) => {
      const username = req.headers['x-test-user'];
      const role = req.headers['x-test-role'];
      if (typeof username === 'string' && typeof role === 'string') {
        req.user = { username, role } as never;
      }
    });
    await instance.register(reviewsRoutes);
    await instance.ready();
    return instance;
  }

  const asUser = (username: string, role: string) => ({
    'x-test-user': username,
    'x-test-role': role,
  });

  const submit = (headers: Record<string, string>, templateId: string, html: string) =>
    app.inject({
      method: 'POST',
      url: '/review-requests',
      headers,
      payload: {
        templateId,
        html,
        css: '.x{}',
        fundCode: templateId.split('_')[1],
        origin: 'edit',
      },
    });

  beforeAll(async () => {
    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('POST /review-requests: 申請を積むが実ファイルは書かない', async () => {
    const tplId = 'AM01_611111_20250101_交付版';
    const res = await submit(asUser('editor1', 'editor'), tplId, '<p>{{ fund.name }} 申請</p>');
    expect(res.statusCode).toBe(200);
    const meta = res.json();
    expect(meta.status).toBe('pending');
    expect(meta.submittedBy).toBe('editor1');
    expect(fs.existsSync(path.join(tmp, 'templates', `${tplId}.html`))).toBe(false);
  });

  it('POST /review-requests: 不正ボディ(templateId 欠落)は 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/review-requests',
      headers: asUser('editor1', 'editor'),
      payload: { html: '<p>x</p>', css: '', fundCode: '611111', origin: 'edit' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('GET /review-requests: editor は自分の申請のみ、approver は全件', async () => {
    await submit(asUser('editor2', 'editor'), 'AM01_622222_20250101_交付版', '<p>e2</p>');

    const mine = await app.inject({
      method: 'GET',
      url: '/review-requests',
      headers: asUser('editor2', 'editor'),
    });
    const mineList = mine.json() as Array<{ submittedBy: string }>;
    expect(mineList.length).toBeGreaterThan(0);
    expect(mineList.every((r) => r.submittedBy === 'editor2')).toBe(true);

    const all = await app.inject({
      method: 'GET',
      url: '/review-requests',
      headers: asUser('approver1', 'approver'),
    });
    const allList = all.json() as Array<{ submittedBy: string }>;
    expect(allList.some((r) => r.submittedBy === 'editor1')).toBe(true);
    expect(allList.some((r) => r.submittedBy === 'editor2')).toBe(true);
  });

  it('GET /review-requests?status: 正しい状態で絞り込め、不正値は 400', async () => {
    const ok = await app.inject({
      method: 'GET',
      url: '/review-requests?status=pending',
      headers: asUser('approver1', 'approver'),
    });
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as Array<{ status: string }>).every((r) => r.status === 'pending')).toBe(
      true,
    );

    const bad = await app.inject({
      method: 'GET',
      url: '/review-requests?status=bogus',
      headers: asUser('approver1', 'approver'),
    });
    expect(bad.statusCode).toBe(400);
  });

  it('POST approve: approver が承認すると実ファイルへ反映し approved になる', async () => {
    const tplId = 'AM01_633333_20250101_交付版';
    const sub = await submit(asUser('editor1', 'editor'), tplId, '<p>{{ fund.name }} 反映済</p>');
    const reqId = sub.json().id;

    const res = await app.inject({
      method: 'POST',
      url: `/review-requests/${reqId}/approve`,
      headers: asUser('approver1', 'approver'),
      payload: { comment: 'ok' },
    });
    expect(res.statusCode).toBe(200);
    const written = fs.readFileSync(path.join(tmp, 'templates', `${tplId}.html`), 'utf8');
    expect(written).toContain('反映済');

    const got = await app.inject({
      method: 'GET',
      url: `/review-requests/${reqId}`,
      headers: asUser('approver1', 'approver'),
    });
    expect(got.json().status).toBe('approved');
  });

  it('GET /review-requests/:reqId: 他人の申請は editor から 403、本人/approver は 200', async () => {
    const sub = await submit(
      asUser('editor1', 'editor'),
      'AM01_677777_20250101_交付版',
      '<p>秘</p>',
    );
    const reqId = sub.json().id;

    const other = await app.inject({
      method: 'GET',
      url: `/review-requests/${reqId}`,
      headers: asUser('editor2', 'editor'),
    });
    expect(other.statusCode).toBe(403);

    const owner = await app.inject({
      method: 'GET',
      url: `/review-requests/${reqId}`,
      headers: asUser('editor1', 'editor'),
    });
    expect(owner.statusCode).toBe(200);

    const approver = await app.inject({
      method: 'GET',
      url: `/review-requests/${reqId}`,
      headers: asUser('approver1', 'approver'),
    });
    expect(approver.statusCode).toBe(200);
  });

  it('POST approve: 決定済みの申請は 409', async () => {
    const sub = await submit(
      asUser('editor1', 'editor'),
      'AM01_644444_20250101_交付版',
      '<p>y</p>',
    );
    const reqId = sub.json().id;
    await app.inject({
      method: 'POST',
      url: `/review-requests/${reqId}/approve`,
      headers: asUser('approver1', 'approver'),
      payload: {},
    });
    const again = await app.inject({
      method: 'POST',
      url: `/review-requests/${reqId}/approve`,
      headers: asUser('approver1', 'approver'),
      payload: {},
    });
    expect(again.statusCode).toBe(409);
  });

  it('POST approve: 自己承認(申請者==承認者・非admin)は 403', async () => {
    const sub = await submit(
      asUser('editor1', 'editor'),
      'AM01_655555_20250101_交付版',
      '<p>z</p>',
    );
    const reqId = sub.json().id;
    const res = await app.inject({
      method: 'POST',
      url: `/review-requests/${reqId}/approve`,
      headers: asUser('editor1', 'editor'),
      payload: {},
    });
    expect(res.statusCode).toBe(403);
  });

  it('POST reject: 実ファイルを書かず rejected になる', async () => {
    const tplId = 'AM01_666666_20250101_交付版';
    const sub = await submit(asUser('editor1', 'editor'), tplId, '<p>却下対象</p>');
    const reqId = sub.json().id;
    const res = await app.inject({
      method: 'POST',
      url: `/review-requests/${reqId}/reject`,
      headers: asUser('approver1', 'approver'),
      payload: { comment: '理由' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('rejected');
    expect(fs.existsSync(path.join(tmp, 'templates', `${tplId}.html`))).toBe(false);
  });
});
