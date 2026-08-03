// =============================================================================
// history.routes.test.ts — 履歴ルートの入力検証(HTTP 結合)
// =============================================================================
// `GET /snapshots/:historyId` と `GET /templates/:templateId/versions` のパラメータは
// そのまま git の引数(リビジョン / pathspec)になる。`-` 始まりの値を git はオプションとして
// 読むため、境界で 400 に落ちることを HTTP 経路ごと固定する(F30 の回帰)。正常系は実 git の
// 一時リポジトリで確認するので、git が無い環境ではその describe だけスキップする。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// config を import する前に一時ディレクトリへ向ける(gitRepo.test.ts と同方針)。
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-history-routes-'));
process.env.DATA_ROOT = tmp;
process.env.GIT_REPO_DIR = tmp;
process.env.TEMPLATES_DIR = path.join(tmp, 'templates');
process.env.CSS_DIR = path.join(tmp, 'css');

async function buildApp(): Promise<FastifyInstance> {
  const Fastify = (await import('fastify')).default;
  const { errorHandler } = await import('../src/middleware/errorHandler.js');
  const { historyRoutes } = await import('../src/routes/history.routes.js');
  const instance = Fastify();
  instance.setErrorHandler(errorHandler);
  await instance.register(historyRoutes);
  await instance.ready();
  return instance;
}

let gitAvailable = true;
try {
  execFileSync('git', ['--version'], { stdio: 'ignore' });
} catch {
  gitAvailable = false;
}
const d = gitAvailable ? describe : describe.skip;

describe('history routes reject git option injection', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('rejects an --output= historyId with 400 and creates no file', async () => {
    const victim = path.join(tmp, 'pwned.html');
    const res = await app.inject({
      method: 'GET',
      url: `/snapshots/${encodeURIComponent(`--output=${victim}`)}`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().kind).toBe('validation');
    expect(fs.existsSync(victim)).toBe(false);
  });

  it('rejects non-object-id historyId shapes', async () => {
    for (const id of ['HEAD', 'HEAD~1', '-deadbeef', 'deadbee..cafebab']) {
      const res = await app.inject({ method: 'GET', url: `/snapshots/${encodeURIComponent(id)}` });
      expect(res.statusCode).toBe(400);
    }
  });

  it('rejects a templateId that escapes the templates pathspec', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/templates/${encodeURIComponent('../../etc/passwd')}/versions`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().kind).toBe('validation');
  });
});

d('history routes still serve valid ids', () => {
  let app: FastifyInstance;
  let hash: string;
  const templateId = 'AM01_999999_20250101_交付版';

  beforeAll(async () => {
    const git = await import('../src/git/gitRepo.js');
    await git.ensureRepo();
    fs.mkdirSync(path.join(tmp, 'templates'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'css'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'templates', `${templateId}.html`), '<p>本文</p>', 'utf8');
    fs.writeFileSync(path.join(tmp, 'css', '999999.css'), 'p{color:#000}', 'utf8');
    hash = await git.commitAll(`確定保存: ${templateId} by tester`, { name: 'tester' });
    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('returns the snapshot for a real commit hash', async () => {
    const res = await app.inject({ method: 'GET', url: `/snapshots/${hash}` });
    expect(res.statusCode).toBe(200);
    const snap = res.json();
    expect(snap.templateId).toBe(templateId);
    expect(snap.html).toContain('本文');
    expect(snap.css).toContain('color');
    expect(snap.fundCode).toBe('999999');
  });

  it('returns the version list for a real templateId', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/templates/${encodeURIComponent(templateId)}/versions`,
    });
    expect(res.statusCode).toBe(200);
    const versions = res.json();
    expect(versions.length).toBe(1);
    expect(versions[0].historyId).toBe(hash);
    expect(versions[0].user).toBe('tester');
  });
});
