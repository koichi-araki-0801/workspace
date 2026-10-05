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

// 生成器(python)と sproc は本テストの対象外。生成器は「何を渡されたか」だけを、sproc は
// `テンプレート` を呼ばないことだけを観測する(注記マスタの適用は DB 不達でも素通しする)。
let templateCalls = 0;
const { generateMock } = vi.hoisted(() => ({
  generateMock: vi.fn(async (_attrs: unknown) => '<html><body><p>生成物</p></body></html>'),
}));
vi.mock('../src/generate/pyTemplate.js', () => ({ generateTemplate: generateMock }));
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
process.env.DRAFTS_DIR = path.join(root, 'data', 'drafts');
process.env.REVIEWS_DIR = path.join(root, 'data', 'reviews');

const templatesDir = path.join(root, 'data', 'templates');
const filledDir = path.join(root, 'data', 'filled');
const pendingDir = path.join(root, 'data', 'pending');
const draftsDir = path.join(root, 'data', 'drafts');
const reviewsDir = path.join(root, 'data', 'reviews');
const cssDir = path.join(root, 'data', 'css');
// メモの置き場は env を持たず `<DATA_ROOT>/notes` 固定(`files/notesFile.ts` の `notesDir`)。
const notesDir = path.join(root, 'data', 'notes');
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
    const { SP } = await import('../src/db/sprocNames.js');
    const sproc = createSprocClient(async (sql) => {
      if (sql.includes(SP.template)) templateCalls += 1;
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
    templateCalls = 0;
    for (const d of [
      templatesDir,
      filledDir,
      pendingDir,
      draftsDir,
      reviewsDir,
      notesDir,
      cssDir,
    ]) {
      fs.rmSync(d, { recursive: true, force: true });
      fs.mkdirSync(d, { recursive: true });
    }
  });

  // テンプレートは基準日を持たない。生成の ID は会社_ファンド_版種で、日付に依らず決まる。
  const ID = 'AM01_510037_交付版';
  const FILLED_ID = 'AM01_510037_20240710_交付版';
  const ATTRS = { companyCode: 'AM01', fundCode: '510037', editionType: '交付版' };

  /** 承認待ち(または決着済み)の申請を 1 件置く。id は reviewFiles の REQ_ID_PATTERN に合う形。 */
  async function putReview(
    id: string,
    origin: 'create' | 'edit',
    status: 'pending' | 'approved' | 'rejected',
  ) {
    const { writeReview } = await import('../src/files/reviewFiles.js');
    await writeReview({
      id,
      templateId: ID,
      attributes: ATTRS,
      origin,
      status,
      submittedBy: 'editor1',
      submittedAt: new Date().toISOString(),
      reviewedBy: null,
      reviewedAt: null,
      comment: null,
      baseHash: null,
      html: '<p>申請</p>',
      css: '',
    });
  }

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

  it('作成済み(templates/ にある)なら 409「作成済み」で、そのバイト列は変わらない', async () => {
    const confirmed = path.join(templatesDir, `${ID}.html`);
    fs.writeFileSync(confirmed, '<p>承認済みの本番テンプレ</p>', 'utf8');
    const res = await generate(validBody);
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toBe('作成済みです。既存のテンプレートを開いてください');
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

  it('生成直後のテンプレート(基準日なし)は編集タブの一覧に出ず、作成タブの作業中として開ける', async () => {
    // 編集タブは値入り HTML(基準日あり)だけを扱う。生成直後の id を見失わないよう、
    // 作成タブの creatable が作業中(inProgressId)として返す。到達不能は復旧手段が無いので退行扱い。
    await generate(validBody);
    const list = await app.inject({ method: 'GET', url: '/templates?fundCode=510037' });
    expect(list.statusCode).toBe(200);
    const rows = list.json() as { id: string; status: string }[];
    expect(rows.map((r) => r.id)).not.toContain(ID);
    const info = await app.inject({
      method: 'GET',
      url: `/templates/creatable?${new URLSearchParams({
        companyCode: 'AM01',
        rep1CompanyCode: 'R-AM01',
        fundCode: '510037',
        editionType: '交付版',
      })}`,
    });
    expect(info.statusCode).toBe(200);
    expect(info.json()).toMatchObject({ created: false, inProgressId: ID });
  });

  it('値入り HTML と同じ id の pending が残っていても、一覧は published の 1 行だけ', async () => {
    fs.writeFileSync(path.join(filledDir, `${FILLED_ID}.html`), '<p>確定版(値入り)</p>', 'utf8');
    fs.writeFileSync(path.join(pendingDir, `${FILLED_ID}.html`), '<p>消し残り</p>', 'utf8');
    const list = await app.inject({ method: 'GET', url: '/templates?fundCode=510037' });
    const rows = list.json() as { id: string; status: string }[];
    expect(rows.filter((r) => r.id === FILLED_ID)).toHaveLength(1);
    expect(rows.find((r) => r.id === FILLED_ID)?.status).toBe('published');
  });

  it('作り直しの同意(replaceExisting)があれば、pending のある属性も作り直せる(復旧手段を塞がない)', async () => {
    // ここが 409 や 500 になると「一覧に出るが開けない・作り直せない」テンプレが恒久的に残る。
    await generate(validBody);
    fs.writeFileSync(path.join(pendingDir, `${ID}.html`), '<p>古い生成物</p>', 'utf8');
    const res = await generate({ ...validBody, replaceExisting: true });
    expect(res.statusCode).toBe(200);
    expect(fs.readFileSync(path.join(pendingDir, `${ID}.html`), 'utf8')).toContain('生成物');
    expect(fs.readdirSync(templatesDir)).toEqual([]);
  });

  it('生成で sproc の テンプレート を呼ばない(作成タブの台帳は無い)', async () => {
    const res = await generate(validBody);
    expect(res.statusCode).toBe(200);
    expect(templateCalls).toBe(0);
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

  it('生成器へは検証済みの属性だけを渡し、基準日は渡さない(本文の他のキーや廃止した basedOnTemplateId も渡らない)', async () => {
    generateMock.mockClear();
    const res = await generate({
      ...validBody,
      replaceExisting: true,
      basedOnTemplateId: 'AM01_510037_20240710_交付版',
      evil: '<script>',
    });
    expect(res.statusCode).toBe(200);
    expect(generateMock).toHaveBeenCalledTimes(1);
    expect(generateMock.mock.calls[0][0]).toEqual({
      companyCode: 'AM01',
      fundCode: '510037',
      editionType: '交付版',
    });
  });

  it('sourceFundCode のコピー元テンプレートが templates/ に無ければ生成器を呼ばずに 400', async () => {
    generateMock.mockClear();
    const res = await generate({ ...validBody, fundCode: '510155', sourceFundCode: '999999' });
    expect(res.statusCode).toBe(400);
    expect(generateMock).not.toHaveBeenCalled();
  });

  it('規約外の sourceFundCode は 400', async () => {
    const res = await generate({ ...validBody, fundCode: '510155', sourceFundCode: '../x' });
    expect(res.statusCode).toBe(400);
  });

  it('コピー元があれば sourceFundCode と isRedemption を生成器へ渡し、作成履歴に残す', async () => {
    fs.writeFileSync(path.join(templatesDir, 'AM01_510037_交付版.html'), '<p>元</p>', 'utf8');
    generateMock.mockClear();
    const res = await generate({
      ...validBody,
      fundCode: '510155',
      sourceFundCode: '510037',
      isRedemption: true,
    });
    expect(res.statusCode).toBe(200);
    expect(generateMock.mock.calls[0][0]).toMatchObject({
      sourceFundCode: '510037',
      isRedemption: true,
    });
    const lines = fs
      .readFileSync(path.join(root, 'logs', 'history', 'create.jsonl'), 'utf8')
      .trim()
      .split('\n');
    expect(JSON.parse(lines[lines.length - 1])).toMatchObject({ sourceFundCode: '510037' });
    expect(JSON.parse(lines[lines.length - 1]).attributes).toEqual({
      companyCode: 'AM01',
      fundCode: '510155',
      editionType: '交付版',
    });
  });

  it('isRedemption が false なら生成器へ渡さない', async () => {
    generateMock.mockClear();
    await generate({ ...validBody, isRedemption: false });
    expect(generateMock.mock.calls[0][0]).not.toHaveProperty('isRedemption');
  });

  it('生成の ID は会社_ファンド_版種で、応答の属性は基準日を持たない', async () => {
    const res = await generate(validBody);
    expect(res.json().template.meta.id).toBe(ID);
    expect(res.json().template.meta.attributes).toEqual(ATTRS);
  });

  it('会社コードの大文字小文字だけが違うテンプレートがあっても 409「作成済み」', async () => {
    fs.writeFileSync(path.join(templatesDir, 'am01_510037_交付版.html'), '<p>既存</p>', 'utf8');
    generateMock.mockClear();
    const res = await generate(validBody);
    expect(res.statusCode).toBe(409);
    expect(generateMock).not.toHaveBeenCalled();
  });

  it('templates/ に旧形式(4 つ区切り)のファイルしか無ければ作成済みにしない', async () => {
    fs.writeFileSync(path.join(templatesDir, `${FILLED_ID}.html`), '<p>旧形式</p>', 'utf8');
    const res = await generate(validBody);
    expect(res.statusCode).toBe(200);
  });

  it('同じ id の承認待ちの作成申請があれば、同意があっても生成器を呼ばずに 409「申請中」', async () => {
    await putReview('11111111-1111-4111-8111-111111111111', 'create', 'pending');
    fs.writeFileSync(path.join(pendingDir, `${ID}.html`), '<p>申請した生成物</p>', 'utf8');
    generateMock.mockClear();
    const res = await generate({ ...validBody, replaceExisting: true });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toBe('申請中です。承認か却下を待ってください');
    expect(generateMock).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(pendingDir, `${ID}.html`))).toBe(true);
  });

  it('決着済み(承認・却下)や編集タブの申請は作り直しを止めない', async () => {
    await putReview('22222222-2222-4222-8222-222222222222', 'create', 'rejected');
    await putReview('33333333-3333-4333-8333-333333333333', 'edit', 'pending');
    const res = await generate(validBody);
    expect(res.statusCode).toBe(200);
  });

  it.each([
    ['下書き', () => fs.writeFileSync(path.join(draftsDir, `${ID}.html`), '<p>下書き</p>', 'utf8')],
    [
      'pending',
      () => fs.writeFileSync(path.join(pendingDir, `${ID}.html`), '<p>生成物</p>', 'utf8'),
    ],
  ])('作業中(%s)があり同意が無ければ、生成器を呼ばずに 409「作成中」', async (_label, seed) => {
    seed();
    generateMock.mockClear();
    const res = await generate(validBody);
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toBe('作成中のテンプレートがあります');
    expect(generateMock).not.toHaveBeenCalled();
  });

  it('同意して作り直すと、下書きを捨てて pending を新しい生成物にし、コメントとパーツ変更履歴は残す', async () => {
    fs.writeFileSync(path.join(draftsDir, `${ID}.html`), '<p>古い下書き</p>', 'utf8');
    fs.writeFileSync(path.join(draftsDir, `${ID}.css`), '.old{}', 'utf8');
    fs.writeFileSync(path.join(pendingDir, `${ID}.html`), '<p>古い生成物</p>', 'utf8');
    fs.mkdirSync(notesDir, { recursive: true });
    fs.writeFileSync(path.join(notesDir, `${ID}.json`), '{}', 'utf8');
    const history = await import('../src/repositories/historyRepo.js');
    await history.recordPartChange(ID, 'p1/a', '本文を変更', 'editor1');
    const res = await generate({ ...validBody, replaceExisting: true });
    expect(res.statusCode).toBe(200);
    expect(fs.existsSync(path.join(draftsDir, `${ID}.html`))).toBe(false);
    expect(fs.existsSync(path.join(draftsDir, `${ID}.css`))).toBe(false);
    expect(fs.readFileSync(path.join(pendingDir, `${ID}.html`), 'utf8')).toContain('生成物');
    expect(fs.existsSync(path.join(notesDir, `${ID}.json`))).toBe(true);
    expect(await history.listPartHistory(ID)).toHaveLength(1);
  });

  it('生成器が失敗したら、同意していても下書きも pending も消さない', async () => {
    fs.writeFileSync(path.join(draftsDir, `${ID}.html`), '<p>守る下書き</p>', 'utf8');
    fs.writeFileSync(path.join(pendingDir, `${ID}.html`), '<p>守る生成物</p>', 'utf8');
    generateMock.mockRejectedValueOnce(new Error('生成器が落ちた'));
    const res = await generate({ ...validBody, replaceExisting: true });
    expect(res.statusCode).toBeGreaterThanOrEqual(500);
    expect(fs.readFileSync(path.join(draftsDir, `${ID}.html`), 'utf8')).toBe('<p>守る下書き</p>');
    expect(fs.readFileSync(path.join(pendingDir, `${ID}.html`), 'utf8')).toBe('<p>守る生成物</p>');
  });

  it('コピー元が旧形式(4 つ区切り)しか無ければ 400', async () => {
    fs.writeFileSync(
      path.join(templatesDir, 'AM01_510037_20240710_交付版.html'),
      '<p>旧</p>',
      'utf8',
    );
    const res = await generate({ ...validBody, fundCode: '510155', sourceFundCode: '510037' });
    expect(res.statusCode).toBe(400);
  });

  it('CSS の初期値はコピー元テンプレの CSS(同名の既存 CSS より優先)', async () => {
    fs.writeFileSync(path.join(templatesDir, 'AM01_510037_交付版.html'), '<p>元</p>', 'utf8');
    fs.writeFileSync(path.join(cssDir, 'AM01_510037_交付版.css'), '.src{}', 'utf8');
    fs.writeFileSync(path.join(cssDir, 'AM01_510155_交付版.css'), '.own{}', 'utf8');
    const res = await generate({ ...validBody, fundCode: '510155', sourceFundCode: '510037' });
    expect(res.statusCode).toBe(200);
    expect(res.json().template.css).toBe('.src{}');
    // css/ は承認の専権。生成では書き換えない。
    expect(fs.readFileSync(path.join(cssDir, 'AM01_510155_交付版.css'), 'utf8')).toBe('.own{}');
  });

  it('コピー元テンプレはあるが CSS ファイルが無ければ、同じ名前の既存 CSS があっても空', async () => {
    fs.writeFileSync(path.join(templatesDir, 'AM01_510037_交付版.html'), '<p>元</p>', 'utf8');
    fs.writeFileSync(path.join(cssDir, 'AM01_510155_交付版.css'), '.own{}', 'utf8');
    const res = await generate({ ...validBody, fundCode: '510155', sourceFundCode: '510037' });
    expect(res.statusCode).toBe(200);
    expect(res.json().template.css).toBe('');
  });

  it('コピー元が無ければ同じ名前の既存 CSS を初期値にする', async () => {
    fs.writeFileSync(path.join(cssDir, 'AM01_510037_交付版.css'), '.same{}', 'utf8');
    const res = await generate(validBody);
    expect(res.json().template.css).toBe('.same{}');
  });

  it('どちらも無ければ空', async () => {
    fs.writeFileSync(path.join(cssDir, '510037.css'), '.old{}', 'utf8');
    const res = await generate(validBody);
    expect(res.json().template.css).toBe('');
  });
});
