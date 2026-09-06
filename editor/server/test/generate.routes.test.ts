// =============================================================================
// generate.routes.test.ts — 生成は確定領域へ 1 バイトも書かない
// =============================================================================
// `POST /api/generate` が確定ディレクトリへ直接書く形は、単に「ゴミが増える」
// 問題ではなく、(a) 承認を経ない実体が本番一覧・結合 PDF・比較タブへ載る、(b) ペア同期の
// 転写先条件(`templateExists`)を攻撃者が創り出せる、(c) 実行コード不変性の**基準**を
// 差し替えられる、の 3 つが同時に成立する経路になる。本テストの本命は
// 「generate 後に templatesDir が空のまま」である。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSessionStub, decorateSessionStore } from './helpers/sessionStub.js';

// 生成器(python)と台帳(sproc)は本テストの対象外。台帳は既定で成功させ、孤児検査の
// ときだけ失敗へ切り替える。
let sprocFails = false;
vi.mock('../src/generate/pyTemplate.js', () => ({
  generateTemplate: async () => '<html><body><p>生成物</p></body></html>',
}));
// `AUTH_REQUIRED=true` の経路を実際に通したいので、セッション解決だけを差し替える
// (ロール検査ではなく「認証済み利用者が確定領域へ書けないこと」が本テストの関心)。
vi.mock('../src/auth/session.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/auth/session.js')>()),
  sessionIdFrom: () => 'test-session',
}));

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-generate-routes-'));
process.env.AUTH_REQUIRED = 'true';
process.env.DATA_ROOT = path.join(root, 'data');
process.env.GIT_REPO_DIR = path.join(root, 'data');
process.env.TEMPLATES_DIR = path.join(root, 'data', 'templates');
process.env.CSS_DIR = path.join(root, 'data', 'css');
process.env.PENDING_DIR = path.join(root, 'data', 'pending');
// `HISTORY_DIR` という設定キーは存在しない。作成履歴は `config.logging.dir` 配下
// (`<LOG_DIR>/history/create.jsonl`)へ書かれるので、ここを逸らさないとテストの度に
// リポジトリ作業ツリーへ `editor/logs/history/create.jsonl` が生える。
process.env.LOG_DIR = path.join(root, 'logs');

const templatesDir = path.join(root, 'data', 'templates');
const pendingDir = path.join(root, 'data', 'pending');
const OUTSIDE = path.join(root, 'outside');

describe('POST /api/generate は確定領域へ書かない', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    fs.mkdirSync(OUTSIDE, { recursive: true });
    const Fastify = (await import('fastify')).default;
    const { errorHandler } = await import('../src/middleware/errorHandler.js');
    const { generateRoutes } = await import('../src/routes/generate.routes.js');
    const { templatesRoutes } = await import('../src/routes/templates.routes.js');
    const { createSprocClient } = await import('../src/db/sproc.js');
    const { createDeps } = await import('../src/deps.js');
    const sproc = createSprocClient(async () => {
      if (sprocFails) throw new Error('台帳登録に失敗(テストの意図的失敗)');
      return [];
    });
    const store = createSessionStub({
      getSessionUser: () => ({
        id: 'editor1',
        username: 'editor1',
        displayName: 'editor1',
        role: 'editor',
        disabled: false,
        mustChangePassword: false,
      }),
    });
    const deps = createDeps(sproc, store);
    app = Fastify();
    decorateSessionStore(app, store);
    app.setErrorHandler(errorHandler);
    // `requireAuth` は実セッションを引くので、ここでは onRequest で user を注入して
    // 「認証済みの一般利用者」を作る(本テストの関心はロールではなく書込先)。
    app.addHook('onRequest', async (req) => {
      req.user = { username: 'editor1', role: 'editor' } as never;
    });
    await app.register(generateRoutes, { deps });
    await app.register(templatesRoutes, { deps });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  beforeEach(() => {
    sprocFails = false;
    for (const d of [templatesDir, pendingDir]) {
      fs.rmSync(d, { recursive: true, force: true });
      fs.mkdirSync(d, { recursive: true });
    }
  });

  const ymd = (() => {
    const d = new Date();
    return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  })();
  const ID = `AM01_510037_${ymd}_交付版`;

  const generate = (body: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/generate', payload: body });

  const validBody = {
    companyCode: 'AM01',
    fundCode: '510037',
    editionType: '交付版',
  };

  it('生成しても templatesDir には 1 ファイルも作られない', async () => {
    const res = await generate(validBody);
    expect(res.statusCode).toBe(200);
    expect(fs.readdirSync(templatesDir)).toEqual([]);
  });

  it('生成物は pending へ置かれ、GET /templates/:id が status=draft で返す', async () => {
    await generate(validBody);
    expect(fs.existsSync(path.join(pendingDir, `${ID}.html`))).toBe(true);
    const got = await app.inject({ method: 'GET', url: `/templates/${encodeURIComponent(ID)}` });
    expect(got.statusCode).toBe(200);
    expect(got.json().meta.status).toBe('draft');
  });

  it('同一属性の確定テンプレがあれば 409 で、そのバイト列は変わらない', async () => {
    const confirmed = path.join(templatesDir, `${ID}.html`);
    fs.writeFileSync(confirmed, '<p>承認済みの本番テンプレ</p>', 'utf8');
    const res = await generate(validBody);
    expect(res.statusCode).toBe(409);
    expect(fs.readFileSync(confirmed, 'utf8')).toBe('<p>承認済みの本番テンプレ</p>');
  });

  it('pending は確定を覆い隠さない(確定優先が契約)', async () => {
    fs.writeFileSync(path.join(templatesDir, `${ID}.html`), '<p>確定版</p>', 'utf8');
    fs.mkdirSync(pendingDir, { recursive: true });
    fs.writeFileSync(path.join(pendingDir, `${ID}.html`), '<p>すり替え</p>', 'utf8');
    const got = await app.inject({ method: 'GET', url: `/templates/${encodeURIComponent(ID)}` });
    expect(got.json().meta.status).toBe('published');
    expect(got.json().html).toBe('<p>確定版</p>');
  });

  it('生成直後のテンプレは編集タブの一覧に status=draft で出る(id を見失わせない)', async () => {
    // 一覧から外すと、作成タブの `/edit/:id` 遷移を閉じた時点でその id へ到達する手段が
    // UI から消える(履歴タブは遷移経路を持たない)。到達不能は復旧手段が無いので退行扱い。
    await generate(validBody);
    const list = await app.inject({ method: 'GET', url: '/templates?fundCode=510037' });
    expect(list.statusCode).toBe(200);
    const rows = list.json() as { id: string; status: string }[];
    expect(rows.map((r) => r.id)).toContain(ID);
    expect(rows.find((r) => r.id === ID)?.status).toBe('draft');
  });

  it('確定済みは一覧に published で出て、pending が二重行を作らない', async () => {
    fs.writeFileSync(path.join(templatesDir, `${ID}.html`), '<p>確定版</p>', 'utf8');
    fs.writeFileSync(path.join(pendingDir, `${ID}.html`), '<p>消し残り</p>', 'utf8');
    const list = await app.inject({ method: 'GET', url: '/templates?fundCode=510037' });
    const rows = list.json() as { id: string; status: string }[];
    expect(rows.filter((r) => r.id === ID)).toHaveLength(1);
    expect(rows[0]?.status).toBe('published');
  });

  it('pending がある属性の再生成は通り、pending を上書きする(復旧手段を塞がない)', async () => {
    // 台帳への再登録は `UQ_台帳_属性4` に当たるため行わない。ここが 409 や 500 になると
    // 「一覧に出るが開けない・作り直せない」テンプレが恒久的に残る。
    await generate(validBody);
    fs.writeFileSync(path.join(pendingDir, `${ID}.html`), '<p>古い生成物</p>', 'utf8');
    const res = await generate(validBody);
    expect(res.statusCode).toBe(200);
    expect(fs.readFileSync(path.join(pendingDir, `${ID}.html`), 'utf8')).toContain('生成物');
    expect(fs.readdirSync(templatesDir)).toEqual([]);
  });

  it('台帳登録に失敗したら pending も残さない(孤児を作らない)', async () => {
    sprocFails = true;
    const res = await generate(validBody);
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(fs.readdirSync(pendingDir)).toEqual([]);
  });

  it.each([
    ['../../outside', 'companyCode'],
    ['..\\..\\outside', 'companyCode'],
    ['/etc/passwd', 'fundCode'],
    ['C:\\Windows\\Temp\\pwned', 'fundCode'],
    ['AM01/../../outside', 'editionType'],
  ])('トラバーサル属性 %s (%s) は 400 で、管理外に痕跡を残さない', async (value, field) => {
    const res = await generate({ ...validBody, [field]: value });
    expect(res.statusCode).toBe(400);
    expect(fs.readdirSync(OUTSIDE)).toEqual([]);
    expect(fs.readdirSync(templatesDir)).toEqual([]);
  });

  it.each([
    'AM01 ',
    ' AM01',
    'AM01.',
  ])('末尾/先頭の空白・ドットを持つ会社コード %s は 400', async (companyCode) => {
    // ファイル名全体しか trim 検査していない `assertTemplateFileName` は素通しするが、
    // SQL Server の `=` は末尾空白を無視するため「ファイル 2 つ・台帳 1 行」を作れる。
    const res = await generate({ ...validBody, companyCode });
    expect(res.statusCode).toBe(400);
    expect(fs.readdirSync(pendingDir)).toEqual([]);
  });

  it('アンダースコアを含む属性は 400(ファイル名規約のトークン境界を偽装させない)', async () => {
    const res = await generate({ ...validBody, fundCode: '510037_20240710' });
    expect(res.statusCode).toBe(400);
  });
});
