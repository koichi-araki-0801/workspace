// =============================================================================
// generate.routes.test.ts — 生成は確定領域へ 1 バイトも書かない
// =============================================================================
// `POST /api/generate` が確定ディレクトリへ直接書く形は、単に「ゴミが増える」
// 問題ではなく、(a) 承認を経ない実体が本番一覧・結合 PDF・比較タブへ載る、(b) ペア同期の
// 転写先条件(`templateExists`)を攻撃者が創り出せる、(c) 実行コード不変性の**基準**を
// 差し替えられる、の 3 つが同時に成立する経路になる。本テストの本命は
// 「generate 後に templatesDir が空のまま」である。
//
// 1 回の作成は、作成画面のファンドの交付版・全体版と組入先を取り込む。組入先は、別のファンドから
// 作られた作業を消さないよう、何も無い版だけを取り込む。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GenerateAttributes, GeneratedFile } from '../src/generate/pyTemplate.js';
import { createSessionStub, decorateSessionStore } from './helpers/sessionStub.js';

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
// 生成器の書き先の代わり。mock が実際にファイルを置き、取り込み後の後始末を観測する。
const outputDir = path.join(root, 'output');
const OUTSIDE = path.join(root, 'outside');

// 生成器(python)は本テストの対象外。mock は受けた属性から両版(と `extraFunds` の組入先)を
// `outputDir` に書いて返す。基準日は固定し、生成器へ渡る値を確かめる。
const { generateMock, recordCreateFail, state } = vi.hoisted(() => ({
  generateMock: vi.fn(),
  recordCreateFail: { on: false },
  state: { extraFunds: [] as string[] },
}));
vi.mock('../src/generate/pyTemplate.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/generate/pyTemplate.js')>()),
  generateTemplates: generateMock,
}));
vi.mock('../src/generate/baseDate.js', () => ({ latestBaseDate: () => '2026-10-23' }));
vi.mock('../src/repositories/historyRepo.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/repositories/historyRepo.js')>();
  return {
    ...real,
    recordCreate: async (...args: Parameters<typeof real.recordCreate>) => {
      if (recordCreateFail.on) throw new Error('作成記録に失敗');
      return real.recordCreate(...args);
    },
  };
});
// `AUTH_REQUIRED=true` の経路を実際に通したいので、セッション解決だけを差し替える
// (ロール検査ではなく「認証済み利用者が確定領域へ書けないこと」が本テストの関心)。
vi.mock('../src/auth/session.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/auth/session.js')>()),
  sessionIdFrom: () => 'test-session',
}));

const EDITIONS = ['交付版', '全体版'] as const;

function writeOutput(companyCode: string, fundCode: string, editionType: string): GeneratedFile {
  const fileName = `${companyCode}_${fundCode}_${editionType}.html`;
  const html = `<html><body><p>生成物 ${fundCode} ${editionType}</p></body></html>`;
  fs.mkdirSync(outputDir, { recursive: true });
  const file = path.join(outputDir, fileName);
  fs.writeFileSync(file, html, 'utf8');
  return { fileName, attributes: { companyCode, fundCode, editionType }, html, path: file };
}

async function fakeGenerate(attrs: GenerateAttributes): Promise<GeneratedFile[]> {
  const files: GeneratedFile[] = [];
  for (const fund of [attrs.fundCode, ...state.extraFunds]) {
    for (const e of EDITIONS) files.push(writeOutput(attrs.companyCode, fund, e));
  }
  return files;
}

let templateCalls = 0;
let companiesThrow = false;

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
    const sproc = createSprocClient(async (sql, values) => {
      if (sql.includes(SP.template) && values[0] === '委託会社一覧') {
        if (companiesThrow) throw new Error('Rep1 に届かない');
        return [
          { 委託会社コード: 'R-AM01', 委託会社名: '会社 1', 委託会社略称: 'AM01' },
          { 委託会社コード: 'R-BM02', 委託会社名: '会社 2', 委託会社略称: 'BM02' },
        ];
      }
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
    companiesThrow = false;
    recordCreateFail.on = false;
    state.extraFunds = [];
    generateMock.mockReset();
    generateMock.mockImplementation(fakeGenerate);
    for (const d of [
      templatesDir,
      filledDir,
      pendingDir,
      draftsDir,
      reviewsDir,
      notesDir,
      cssDir,
      outputDir,
    ]) {
      fs.rmSync(d, { recursive: true, force: true });
      fs.mkdirSync(d, { recursive: true });
    }
    fs.rmSync(path.join(root, 'logs'), { recursive: true, force: true });
  });

  // テンプレートは基準日を持たない。生成の ID は会社_ファンド_版種で、日付に依らず決まる。
  const ID = 'AM01_510037_交付版';
  const ZENTAI = 'AM01_510037_全体版';
  const FILLED_ID = 'AM01_510037_20240710_交付版';
  const ATTRS = { companyCode: 'AM01', fundCode: '510037', editionType: '交付版' };

  /** 承認待ち(または決着済み)の申請を 1 件置く。id は reviewFiles の REQ_ID_PATTERN に合う形。 */
  async function putReview(
    id: string,
    origin: 'create' | 'edit',
    status: 'pending' | 'approved' | 'rejected',
    templateId = ID,
  ) {
    const { writeReview } = await import('../src/files/reviewFiles.js');
    const [companyCode, fundCode, editionType] = templateId.split('_');
    await writeReview({
      id,
      templateId,
      attributes: { companyCode, fundCode, editionType },
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
    rep1CompanyCode: 'R-AM01',
    fundCode: '510037',
    editionType: '交付版',
  };

  const pendingHtml = (id: string) => fs.readFileSync(path.join(pendingDir, `${id}.html`), 'utf8');
  const createHistory = () =>
    fs
      .readFileSync(path.join(root, 'logs', 'history', 'create.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
  /** コピー元の確定テンプレートを両版置く。 */
  const putSource = (fund: string) => {
    for (const e of EDITIONS) {
      fs.writeFileSync(path.join(templatesDir, `AM01_${fund}_${e}.html`), '<p>元</p>', 'utf8');
    }
  };

  it('生成しても templatesDir には 1 ファイルも作られない', async () => {
    const res = await generate(validBody);
    expect(res.statusCode).toBe(200);
    expect(fs.readdirSync(templatesDir)).toEqual([]);
  });

  it('両版を pending に書き、応答は押した版を開き、importedIds に両版', async () => {
    const res = await generate({ ...validBody, editionType: '全体版' });
    expect(res.statusCode).toBe(200);
    expect(pendingHtml(ID)).toContain('生成物 510037 交付版');
    expect(pendingHtml(ZENTAI)).toContain('生成物 510037 全体版');
    expect(res.json().template.meta.id).toBe(ZENTAI);
    expect(res.json().template.html).toContain('全体版');
    expect(res.json().importedIds).toEqual([ID, ZENTAI]);
    expect(res.json().skipped).toEqual([]);
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

  it('全体版だけが作成済みでも 409「作成済み」で、生成器を呼ばない', async () => {
    fs.writeFileSync(path.join(templatesDir, `${ZENTAI}.html`), '<p>確定</p>', 'utf8');
    const res = await generate(validBody);
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toBe('作成済みです。既存のテンプレートを開いてください');
    expect(generateMock).not.toHaveBeenCalled();
  });

  it('pending は確定を覆い隠さない(確定優先が契約)', async () => {
    fs.writeFileSync(path.join(templatesDir, `${ID}.html`), '<p>確定版</p>', 'utf8');
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
    expect(pendingHtml(ID)).toContain('生成物');
    expect(fs.readdirSync(templatesDir)).toEqual([]);
  });

  it('Rep1 の会社一覧の照合のほかに sproc の テンプレート を呼ばない(作成タブの台帳は無い)', async () => {
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

  it('版種が交付版・全体版のどちらでもなければ、生成器を呼ばずに 400', async () => {
    const res = await generate({ ...validBody, editionType: 'kr' });
    expect(res.statusCode).toBe(400);
    expect(generateMock).not.toHaveBeenCalled();
  });

  it('Rep1 コードが無ければ 400', async () => {
    const { rep1CompanyCode: _omit, ...rest } = validBody;
    const res = await generate(rest);
    expect(res.statusCode).toBe(400);
    expect(generateMock).not.toHaveBeenCalled();
  });

  it('生成器へは Rep1 コード・ファンド・基準日だけを渡す(本文の他のキーや廃止した basedOnTemplateId も渡らない)', async () => {
    const res = await generate({
      ...validBody,
      rep1CompanyCode: ' R-AM01 ',
      replaceExisting: true,
      basedOnTemplateId: 'AM01_510037_20240710_交付版',
      evil: '<script>',
    });
    expect(res.statusCode).toBe(200);
    expect(generateMock).toHaveBeenCalledTimes(1);
    expect(generateMock.mock.calls[0][0]).toEqual({
      companyCode: 'AM01',
      rep1CompanyCode: 'R-AM01',
      fundCode: '510037',
    });
    expect(generateMock.mock.calls[0][1]).toBe('2026-10-23');
  });

  it.each([
    ['他社の Rep1 コード', { rep1CompanyCode: 'R-BM02' }],
    ['Rep1 に無いコード', { rep1CompanyCode: 'R-ZZ99' }],
    ['Rep1 に無い略称', { companyCode: 'ZZ99' }],
  ])('略称と Rep1 コードの組が Rep1 と食い違えば(%s)、生成器を呼ばずに 400', async (_l, over) => {
    const res = await generate({ ...validBody, ...over });
    expect(res.statusCode).toBe(400);
    expect(res.json().kind).toBe('validation');
    expect(generateMock).not.toHaveBeenCalled();
    expect(fs.readdirSync(pendingDir)).toEqual([]);
  });

  it('略称の大文字小文字が違っても Rep1 の組として通す', async () => {
    const res = await generate({ ...validBody, companyCode: 'am01' });
    expect(res.statusCode).toBe(200);
  });

  it('Rep1 に届かなければ失敗にし、生成器を呼ばない', async () => {
    companiesThrow = true;
    const res = await generate(validBody);
    expect(res.statusCode).toBeGreaterThanOrEqual(500);
    expect(generateMock).not.toHaveBeenCalled();
  });

  it('sourceFundCode のコピー元テンプレートが templates/ に無ければ生成器を呼ばずに 400', async () => {
    const res = await generate({ ...validBody, fundCode: '510155', sourceFundCode: '999999' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      kind: 'validation',
      message: 'コピー元のテンプレートがありません: 999999',
    });
    expect(generateMock).not.toHaveBeenCalled();
  });

  it('コピー元が片方の版しか無ければ 400', async () => {
    fs.writeFileSync(path.join(templatesDir, 'AM01_510037_交付版.html'), '<p>元</p>', 'utf8');
    const res = await generate({ ...validBody, fundCode: '510155', sourceFundCode: '510037' });
    expect(res.statusCode).toBe(400);
    expect(generateMock).not.toHaveBeenCalled();
  });

  it('規約外の sourceFundCode は 400', async () => {
    const res = await generate({ ...validBody, fundCode: '510155', sourceFundCode: '../x' });
    expect(res.statusCode).toBe(400);
  });

  it('コピー元があれば sourceFundCode と isRedemption を生成器へ渡し、両版の作成記録に残す', async () => {
    putSource('510037');
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
    const entries = createHistory();
    expect(entries.map((e) => e.attributes)).toEqual([
      { companyCode: 'AM01', fundCode: '510155', editionType: '交付版' },
      { companyCode: 'AM01', fundCode: '510155', editionType: '全体版' },
    ]);
    for (const e of entries) {
      expect(e.sourceFundCode).toBe('510037');
      expect(e).not.toHaveProperty('requestedFundCode');
    }
  });

  it('isRedemption が false なら生成器へ渡さない', async () => {
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
    const res = await generate(validBody);
    expect(res.statusCode).toBe(409);
    expect(generateMock).not.toHaveBeenCalled();
  });

  it('templates/ に旧形式(4 つ区切り)のファイルしか無ければ作成済みにしない', async () => {
    fs.writeFileSync(path.join(templatesDir, `${FILLED_ID}.html`), '<p>旧形式</p>', 'utf8');
    const res = await generate(validBody);
    expect(res.statusCode).toBe(200);
  });

  it.each([
    ['交付版', ID],
    ['全体版', ZENTAI],
  ])('%sに承認待ちの作成申請があれば、同意があっても生成器を呼ばずに 409「申請中」', async (_e, target) => {
    await putReview('11111111-1111-4111-8111-111111111111', 'create', 'pending', target);
    fs.writeFileSync(path.join(pendingDir, `${target}.html`), '<p>申請した生成物</p>', 'utf8');
    const res = await generate({ ...validBody, replaceExisting: true });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toBe('申請中です。承認か却下を待ってください');
    expect(generateMock).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(pendingDir, `${target}.html`))).toBe(true);
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
    const res = await generate(validBody);
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toBe('作成中のテンプレートがあります');
    expect(generateMock).not.toHaveBeenCalled();
  });

  it('全体版だけが作業中でも、同意が無ければ 409。同意があれば両版を置き換える', async () => {
    fs.writeFileSync(path.join(draftsDir, `${ZENTAI}.html`), '<p>全体版の下書き</p>', 'utf8');
    const refused = await generate(validBody);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().message).toBe('作成中のテンプレートがあります');
    const res = await generate({ ...validBody, replaceExisting: true });
    expect(res.statusCode).toBe(200);
    expect(fs.existsSync(path.join(draftsDir, `${ZENTAI}.html`))).toBe(false);
    expect(pendingHtml(ID)).toContain('交付版');
    expect(pendingHtml(ZENTAI)).toContain('全体版');
  });

  it('同意して作り直すと、下書きを捨てて pending を新しい生成物にし、コメントとパーツ変更履歴は残す', async () => {
    fs.writeFileSync(path.join(draftsDir, `${ID}.html`), '<p>古い下書き</p>', 'utf8');
    fs.writeFileSync(path.join(draftsDir, `${ID}.css`), '.old{}', 'utf8');
    fs.writeFileSync(path.join(pendingDir, `${ID}.html`), '<p>古い生成物</p>', 'utf8');
    fs.writeFileSync(path.join(notesDir, `${ID}.json`), '{}', 'utf8');
    const history = await import('../src/repositories/historyRepo.js');
    await history.recordPartChange(ID, 'p1/a', '本文を変更', 'editor1');
    const res = await generate({ ...validBody, replaceExisting: true });
    expect(res.statusCode).toBe(200);
    expect(fs.existsSync(path.join(draftsDir, `${ID}.html`))).toBe(false);
    expect(fs.existsSync(path.join(draftsDir, `${ID}.css`))).toBe(false);
    expect(pendingHtml(ID)).toContain('生成物');
    expect(fs.existsSync(path.join(notesDir, `${ID}.json`))).toBe(true);
    expect(await history.listPartHistory(ID)).toHaveLength(1);
  });

  it('綴り違い(会社コードの大文字小文字)の pending を作り直しても、新しい生成物は残り編集で開ける', async () => {
    // 大文字小文字を区別しないファイルシステムでは、古い綴りの pending と新しい生成物は同じ
    // ファイルになる。書いた後で古い綴りを消すと、新しい生成物ごと消えて成功応答のまま 404 になる。
    const OLD = 'am01_510037_交付版';
    fs.writeFileSync(path.join(pendingDir, `${OLD}.html`), '<p>古い綴りの生成物</p>', 'utf8');
    const res = await generate({ ...validBody, replaceExisting: true });
    expect(res.statusCode).toBe(200);
    const got = await app.inject({ method: 'GET', url: `/templates/${encodeURIComponent(ID)}` });
    expect(got.statusCode).toBe(200);
    expect(got.json().html).toContain('生成物');
    expect(got.json().html).not.toContain('古い綴り');
    const left = fs.readdirSync(pendingDir).filter((f) => f.endsWith('.html'));
    expect(left.sort()).toEqual([`${ID}.html`, `${ZENTAI}.html`]);
  });

  it('生成器が失敗したら、同意していても下書きも pending も output も触らない', async () => {
    fs.writeFileSync(path.join(draftsDir, `${ID}.html`), '<p>守る下書き</p>', 'utf8');
    fs.writeFileSync(path.join(pendingDir, `${ID}.html`), '<p>守る生成物</p>', 'utf8');
    fs.writeFileSync(path.join(outputDir, 'AM01_510037_交付版.html'), '<p>残り</p>', 'utf8');
    generateMock.mockRejectedValueOnce(new Error('生成器が落ちた'));
    const res = await generate({ ...validBody, replaceExisting: true });
    expect(res.statusCode).toBeGreaterThanOrEqual(500);
    expect(fs.readFileSync(path.join(draftsDir, `${ID}.html`), 'utf8')).toBe('<p>守る下書き</p>');
    expect(pendingHtml(ID)).toBe('<p>守る生成物</p>');
    expect(fs.readdirSync(outputDir)).toEqual(['AM01_510037_交付版.html']);
  });

  it('書いた後の段で失敗しても、書いた pending は残して失敗を返す', async () => {
    recordCreateFail.on = true;
    const res = await generate(validBody);
    expect(res.statusCode).toBe(500);
    expect(pendingHtml(ID)).toContain('交付版');
    expect(pendingHtml(ZENTAI)).toContain('全体版');
  });

  it('取り込んだファイルだけ output/ から消える', async () => {
    fs.writeFileSync(path.join(outputDir, 'AM01_999999_交付版.html'), '<p>他</p>', 'utf8');
    const res = await generate(validBody);
    expect(res.statusCode).toBe(200);
    expect(fs.readdirSync(outputDir)).toEqual(['AM01_999999_交付版.html']);
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
    putSource('510037');
    fs.writeFileSync(path.join(cssDir, 'AM01_510037_交付版.css'), '.src{}', 'utf8');
    fs.writeFileSync(path.join(cssDir, 'AM01_510155_交付版.css'), '.own{}', 'utf8');
    const res = await generate({ ...validBody, fundCode: '510155', sourceFundCode: '510037' });
    expect(res.statusCode).toBe(200);
    expect(res.json().template.css).toBe('.src{}');
    // css/ は承認の専権。生成では書き換えない。
    expect(fs.readFileSync(path.join(cssDir, 'AM01_510155_交付版.css'), 'utf8')).toBe('.own{}');
  });

  it('コピー元テンプレはあるが CSS ファイルが無ければ、同じ名前の既存 CSS があっても空', async () => {
    putSource('510037');
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

  describe('組入先', () => {
    const IN_KOFU = 'AM01_510100_交付版';
    const IN_ZENTAI = 'AM01_510100_全体版';
    beforeEach(() => {
      state.extraFunds = ['510100'];
    });

    it('何も無ければ両版を pending に入れ、importedIds の後ろに並べる', async () => {
      const res = await generate(validBody);
      expect(res.statusCode).toBe(200);
      expect(res.json().importedIds).toEqual([ID, ZENTAI, IN_KOFU, IN_ZENTAI]);
      expect(pendingHtml(IN_KOFU)).toContain('510100 交付版');
      expect(fs.readdirSync(outputDir)).toEqual([]);
    });

    it('何も無い版だけ pending に入れ、作業中の版は skipped に載せてそのまま残す', async () => {
      fs.writeFileSync(path.join(pendingDir, `${IN_KOFU}.html`), '<p>別の作業</p>', 'utf8');
      const res = await generate(validBody);
      expect(res.statusCode).toBe(200);
      expect(res.json().importedIds).toEqual([ID, ZENTAI, IN_ZENTAI]);
      expect(res.json().skipped).toEqual([{ templateId: IN_KOFU, reason: 'inProgress' }]);
      expect(pendingHtml(IN_KOFU)).toBe('<p>別の作業</p>');
      expect(pendingHtml(IN_ZENTAI)).toContain('510100 全体版');
      expect(fs.readdirSync(outputDir)).toEqual([`${IN_KOFU}.html`]);
    });

    it('下書きだけでも作業中として取り込まない', async () => {
      fs.writeFileSync(path.join(draftsDir, `${IN_ZENTAI}.html`), '<p>下書き</p>', 'utf8');
      const res = await generate(validBody);
      expect(res.json().skipped).toEqual([{ templateId: IN_ZENTAI, reason: 'inProgress' }]);
      expect(fs.existsSync(path.join(draftsDir, `${IN_ZENTAI}.html`))).toBe(true);
      expect(fs.existsSync(path.join(pendingDir, `${IN_ZENTAI}.html`))).toBe(false);
    });

    it('作成済みの版は created、承認待ちの作成申請がある版は pendingReview で取り込まない', async () => {
      fs.writeFileSync(path.join(templatesDir, `${IN_KOFU}.html`), '<p>確定</p>', 'utf8');
      await putReview('44444444-4444-4444-8444-444444444444', 'create', 'pending', IN_ZENTAI);
      const res = await generate(validBody);
      expect(res.statusCode).toBe(200);
      expect(res.json().importedIds).toEqual([ID, ZENTAI]);
      expect(res.json().skipped).toEqual([
        { templateId: IN_KOFU, reason: 'created' },
        { templateId: IN_ZENTAI, reason: 'pendingReview' },
      ]);
      expect(fs.readFileSync(path.join(templatesDir, `${IN_KOFU}.html`), 'utf8')).toBe(
        '<p>確定</p>',
      );
    });

    it('組入先には replaceExisting が効かない', async () => {
      fs.writeFileSync(path.join(pendingDir, `${IN_KOFU}.html`), '<p>別の作業</p>', 'utf8');
      fs.writeFileSync(path.join(draftsDir, `${IN_KOFU}.html`), '<p>別の下書き</p>', 'utf8');
      const res = await generate({ ...validBody, replaceExisting: true });
      expect(res.statusCode).toBe(200);
      expect(res.json().skipped).toEqual([{ templateId: IN_KOFU, reason: 'inProgress' }]);
      expect(pendingHtml(IN_KOFU)).toBe('<p>別の作業</p>');
      expect(fs.existsSync(path.join(draftsDir, `${IN_KOFU}.html`))).toBe(true);
    });

    it('組入先の作成記録には requestedFundCode が付き、コピー元は付かない', async () => {
      putSource('510003');
      const res = await generate({ ...validBody, sourceFundCode: '510003' });
      expect(res.statusCode).toBe(200);
      const entries = createHistory();
      expect(entries).toHaveLength(4);
      const inner = entries.filter((e) => e.attributes.fundCode === '510100');
      expect(inner).toHaveLength(2);
      for (const e of inner) {
        expect(e.requestedFundCode).toBe('510037');
        expect(e).not.toHaveProperty('sourceFundCode');
      }
    });

    it('組入先の CSS の初期値にコピー元を使わない', async () => {
      putSource('510003');
      fs.writeFileSync(path.join(cssDir, 'AM01_510003_交付版.css'), '.src{}', 'utf8');
      fs.writeFileSync(path.join(cssDir, 'AM01_510003_全体版.css'), '.src{}', 'utf8');
      fs.writeFileSync(path.join(cssDir, `${IN_KOFU}.css`), '.own{}', 'utf8');
      const res = await generate({ ...validBody, sourceFundCode: '510003' });
      expect(res.statusCode).toBe(200);
      expect(res.json().template.css).toBe('.src{}');
      expect(fs.readFileSync(path.join(pendingDir, `${IN_KOFU}.css`), 'utf8')).toBe('.own{}');
      expect(fs.readFileSync(path.join(pendingDir, `${IN_ZENTAI}.css`), 'utf8')).toBe('');
    });
  });

  it('同じ会社の作成は 1 本ずつで、別の会社は待たない', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    generateMock.mockImplementationOnce(async (attrs: GenerateAttributes) => {
      await gate;
      return fakeGenerate(attrs);
    });
    const first = generate(validBody);
    await vi.waitFor(() => expect(generateMock).toHaveBeenCalledTimes(1));
    const second = generate({ ...validBody, fundCode: '510155' });
    const other = generate({ ...validBody, companyCode: 'BM02', rep1CompanyCode: 'R-BM02' });
    await vi.waitFor(() => expect(generateMock).toHaveBeenCalledTimes(2));
    // 少し待っても、同じ会社の 2 本目は 1 本目が終わるまで生成器へ届かない。
    await new Promise((r) => setTimeout(r, 50));
    expect(generateMock).toHaveBeenCalledTimes(2);
    expect(generateMock.mock.calls[1][0]).toMatchObject({ companyCode: 'BM02' });
    release();
    const results = await Promise.all([first, second, other]);
    expect(results.map((r) => r.statusCode)).toEqual([200, 200, 200]);
    expect(generateMock).toHaveBeenCalledTimes(3);
    expect(generateMock.mock.calls[2][0]).toMatchObject({ fundCode: '510155' });
  });
});
