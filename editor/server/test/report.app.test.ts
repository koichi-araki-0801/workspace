// =============================================================================
// report.app.test.ts — 実配線(`buildApp({ sproc })`)で create_report のルートとガードが効く
// =============================================================================
// ルート単体のテスト(report.routes.test.ts)は plugin を直に載せるので、app.ts の登録と
// `ROUTE_POLICY` が本物で働くことは確かめられない。ここでは本物の `buildApp` へフェイク sproc を
// 差し込み、ログイン → cookie でそれを押さえる。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createFakeSproc } from './fakes/sprocFake.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-report-app-'));
process.env.DATA_ROOT = tmp;
process.env.GIT_REPO_DIR = tmp;
process.env.LOG_DIR = path.join(tmp, 'logs');
process.env.AUTH_REQUIRED = 'true';

describe('buildApp 経由の create_report ルート', { timeout: 60_000 }, () => {
  let app: FastifyInstance | null = null;

  afterAll(async () => {
    await app?.close();
    vi.resetModules();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('GET status is 401 without a session, 200 for editor; fill is 403 and report-pdf passes for viewer', async () => {
    vi.resetModules();
    const { buildApp } = await import('../src/app.js');
    app = buildApp({
      sproc: await createFakeSproc({
        users: [
          { username: 'editor', displayName: 'E', role: 'editor', password: 'editor' },
          { username: 'viewer', displayName: 'V', role: 'viewer', password: 'viewer' },
        ],
      }),
    });
    const login = async (username: string): Promise<string> => {
      const res = await app?.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { host: 'localhost' },
        payload: { username, password: username },
      });
      expect(res?.statusCode).toBe(200);
      return String(res?.headers['set-cookie']).split(';')[0];
    };
    const headers = (cookie?: string) => ({ host: 'localhost', ...(cookie ? { cookie } : {}) });

    const anonymous = await app.inject({
      method: 'GET',
      url: '/api/report/status',
      headers: headers(),
    });
    expect(anonymous.statusCode).toBe(401);

    const editorCookie = await login('editor');
    const status = await app.inject({
      method: 'GET',
      url: '/api/report/status',
      headers: headers(editorCookie),
    });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toEqual({ enabled: false });

    const viewerCookie = await login('viewer');
    const fill = await app.inject({
      method: 'POST',
      url: '/api/templates/XX01_950037_20240710_交付版/fill',
      headers: headers(viewerCookie),
    });
    expect(fill.statusCode).toBe(403);

    // 単体 PDF は閲覧者にも開く。ガードを通り、機能が無効な環境なので 404 で返る(403 ではない)。
    const pdf = await app.inject({
      method: 'POST',
      url: '/api/templates/XX01_950037_20240710_交付版/report-pdf',
      headers: headers(viewerCookie),
      payload: { html: '<p>x</p>' },
    });
    expect(pdf.statusCode).toBe(404);
  });
});
