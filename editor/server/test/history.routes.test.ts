// =============================================================================
// history.routes.test.ts — 履歴ルートの入力検証(HTTP 結合)
// =============================================================================
// `GET /snapshots/:historyId` と `GET /templates/:templateId/versions` のパラメータは
// そのまま git の引数(リビジョン / pathspec)になる。`-` 始まりの値を git はオプションとして
// 読むため、境界で 400 に落ちることを HTTP 経路ごと固定する(オプション注入の回帰)。正常系は実 git の
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
// PDF 出力記録は git ではなく `<LOG_DIR>/history/pdf.jsonl` へ書く。逸らさないとテストの度に
// リポジトリ作業ツリーへ `editor/logs/history/pdf.jsonl` が生える。
process.env.LOG_DIR = path.join(tmp, 'logs');

/**
 * `x-test-user` ヘッダがあれば `request.user` へ注入する(無ければ既存テスト同様に未設定の
 * まま = `actor()` は `'system'` にフォールバックする)。history ルートは `requireAuth` しか
 * 課さず(`config.requireAuth=false` では no-op)、ロール別の分岐を持たないため、他ファイルの
 * `x-test-user`/`x-test-role` 2 本立てではなく user 名だけで足りる。
 */
async function buildApp(): Promise<FastifyInstance> {
  const Fastify = (await import('fastify')).default;
  const { errorHandler } = await import('../src/middleware/errorHandler.js');
  const { historyRoutes } = await import('../src/routes/history.routes.js');
  const instance = Fastify();
  instance.setErrorHandler(errorHandler);
  instance.addHook('onRequest', async (req) => {
    const username = req.headers['x-test-user'];
    if (typeof username === 'string') req.user = { username } as never;
  });
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

describe('POST /history/pdf は出力記録を残す', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('POST /history/pdf は 204 で記録し、GET /history/pdf に user 付きで現れる。templateId 欠落は 400', async () => {
    const bad = await app.inject({ method: 'POST', url: '/history/pdf', payload: {} });
    expect(bad.statusCode).toBe(400);

    const ok = await app.inject({
      method: 'POST',
      url: '/history/pdf',
      headers: { 'x-test-user': 'editor1' },
      payload: { templateId: 'AM01_510037_20240710_交付版' },
    });
    expect(ok.statusCode).toBe(204);

    const list = await app.inject({ method: 'GET', url: '/history/pdf' });
    expect(list.json()).toEqual([
      expect.objectContaining({ templateId: 'AM01_510037_20240710_交付版', user: 'editor1' }),
    ]);
  });

  // `actor()` の `req.user?.username ?? 'system'` は user 有り(上のテスト)/無しの両分岐を
  // 踏んで初めて branch 網羅になる。`x-test-user` ヘッダを送らないリクエストで `'system'` 側を
  // 踏む。
  it('POST /history/pdf: user ヘッダが無ければ actor は system で記録する', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/history/pdf',
      payload: { templateId: 'AM01_520037_20240710_交付版' },
    });
    expect(res.statusCode).toBe(204);

    const list = await app.inject({ method: 'GET', url: '/history/pdf' });
    expect(list.json()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ templateId: 'AM01_520037_20240710_交付版', user: 'system' }),
      ]),
    );
  });

  it('GET /history/edit と GET /history/create は配列(空)を返す', async () => {
    const edit = await app.inject({ method: 'GET', url: '/history/edit' });
    expect(edit.statusCode).toBe(200);
    expect(edit.json()).toEqual([]);

    const create = await app.inject({ method: 'GET', url: '/history/create' });
    expect(create.statusCode).toBe(200);
    expect(create.json()).toEqual([]);
  });
});

d('history routes still serve valid ids', () => {
  let app: FastifyInstance;
  let hash: string;
  const templateId = 'AM01_999999_20250101_交付版';

  beforeAll(async () => {
    const git = await import('../src/git/gitRepo.js');
    await git.ensureRepo();
    fs.mkdirSync(path.join(tmp, 'filled'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'css'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'filled', `${templateId}.html`), '<p>本文</p>', 'utf8');
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
