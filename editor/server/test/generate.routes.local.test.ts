// =============================================================================
// generate.routes.local.test.ts — local モード(AUTH_REQUIRED=false)の生成経路
// =============================================================================
// `generate.routes.test.ts` は `AUTH_REQUIRED=true` で「認証済み利用者が確定領域へ
// 書けないこと」を検証するが、`request.user` を onRequest で必ず注入するため
// `loginId = request.user?.username ?? 'system'` の `?? 'system'` 側と、
// `if (config.requireAuth) { ... }` の else 側(台帳登録も pending 書込もしない)を
// 一度も踏まない。web の local モード(localStorage のみ・DB 不達を前提)を模した本ファイルは
// user 注入を外し、生成物を返すだけで台帳(sproc の `台帳登録`)にも pending にも触れないことを
// 固定する。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// 生成器(python)は本テストの対象外。
vi.mock('../src/generate/pyTemplate.js', () => ({
  generateTemplate: async () => '<html><body><p>生成物</p></body></html>',
}));

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-generate-local-'));
process.env.DATA_ROOT = path.join(root, 'data');
process.env.GIT_REPO_DIR = path.join(root, 'data');
process.env.TEMPLATES_DIR = path.join(root, 'data', 'templates');
process.env.CSS_DIR = path.join(root, 'data', 'css');
process.env.PENDING_DIR = path.join(root, 'data', 'pending');
// `HISTORY_DIR` という設定キーは存在しない。作成履歴は `config.logging.dir` 配下へ書かれる
// (local モードでは呼ばれない想定だが、逸れ先を tmp に固定しておく)。
process.env.LOG_DIR = path.join(root, 'logs');
process.env.AUTH_REQUIRED = 'false';

const templatesDir = path.join(root, 'data', 'templates');
const pendingDir = path.join(root, 'data', 'pending');

describe('POST /api/generate は local モード(AUTH_REQUIRED=false)では台帳にも pending にも触れない', () => {
  let app: FastifyInstance;
  // `SP.template`(生成登録)を呼んだ回数だけを数える。注記マスタ適用(`SP.noteMaster` の
  // `取得`)は生成のたび呼ばれる正当な経路なので、ここでは対象外にする(「台帳(sproc)も
  // pending も触らない」の"台帳"はテンプレート台帳への登録を指す)。
  let ledgerCalls = 0;

  beforeAll(async () => {
    const Fastify = (await import('fastify')).default;
    const { errorHandler } = await import('../src/middleware/errorHandler.js');
    const { generateRoutes } = await import('../src/routes/generate.routes.js');
    const { createSprocClient } = await import('../src/db/sproc.js');
    const { SP } = await import('../src/db/sprocNames.js');
    const { createDeps } = await import('../src/deps.js');
    const { createSessionStub } = await import('./helpers/sessionStub.js');
    const sproc = createSprocClient(async (sql) => {
      if (sql.includes(SP.template)) ledgerCalls += 1;
      return [];
    });
    const deps = createDeps(sproc, createSessionStub());
    app = Fastify();
    app.setErrorHandler(errorHandler);
    // `request.user` を注入する onRequest フックは置かない — これが「local モード」の再現で、
    // `requireAuth`/`requireEditor` は `config.requireAuth=false` で no-op のまま素通る。
    await app.register(generateRoutes, { deps });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  beforeEach(() => {
    ledgerCalls = 0;
    for (const d of [templatesDir, pendingDir]) {
      fs.rmSync(d, { recursive: true, force: true });
      fs.mkdirSync(d, { recursive: true });
    }
  });

  it('local モードでは生成物を返すだけで、台帳(sproc)も pending も触らない', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/generate',
      payload: { companyCode: 'AM01', fundCode: '510037', editionType: '交付版' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().template.html).toContain('生成物');
    expect(ledgerCalls).toBe(0);
    // 確定領域(`templatesDir`)へ書かないことは `generate.routes.test.ts` が認証オンで
    // 主張する。ここは local の非到達(台帳・pending)だけを見る。
    expect(fs.readdirSync(pendingDir)).toEqual([]);
  });
});
