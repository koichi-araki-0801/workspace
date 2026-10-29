// =============================================================================
// templateRepo.creatable.test.ts — 作成タブの会社・ファンド・作成可否(Rep1 の属性 + ファイル)
// =============================================================================
// 会社・ファンド・シリーズは sproc(Rep1)から、作成済みとコピー元の有無はファイルから決める。
// ファイル名の会社コードは Rep1 の略称で、Rep1 のコードとは書式が違う。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-template-repo-creatable-'));
process.env.DATA_ROOT = tmp;
process.env.TEMPLATES_DIR = path.join(tmp, 'templates');
process.env.FILLED_DIR = path.join(tmp, 'filled');
process.env.CSS_DIR = path.join(tmp, 'css');
process.env.PENDING_DIR = path.join(tmp, 'pending');
process.env.DRAFTS_DIR = path.join(tmp, 'drafts');

// fake(DEFAULT_FUNDS)の会社名。fake をここで import すると env 設定より先に config が読まれる。
const DUMMY_AM = '架空アセットマネジメント株式会社（ダミー）';

const put = (dir: string, id: string) =>
  fs.writeFileSync(path.join(tmp, dir, `${id}.html`), '<p>x</p>', 'utf8');
const q = (fundCode: string) => ({
  companyCode: 'XX01',
  rep1CompanyCode: 'R-XX01',
  fundCode,
});

describe('templateRepo の作成タブ用の問い合わせ', () => {
  let repo: import('../src/repositories/templateRepo.js').TemplateRepo;

  beforeAll(async () => {
    for (const d of ['templates', 'filled', 'pending', 'reviews'])
      fs.mkdirSync(path.join(tmp, d), { recursive: true });
    put('filled', 'xx01_910024_20250101_交付版'); // filled/ にしか無い
    put('templates', 'xx01_950037_交付版'); // 小文字の会社コード
    put('templates', 'XX01_950003_全体版');
    put('templates', 'XX01_950155_20240710_交付版'); // 旧形式(4 つ区切り)は数えない
    const { writePending } = await import('../src/files/pendingFiles.js');
    await writePending('XX01_950124_交付版', '<p>未確定</p>', '');
    const { writeDraft } = await import('../src/files/draftFiles.js');
    await writeDraft('XX01_950003_交付版', '<p>下書きだけ</p>', '');
    await writeDraft('xx01_950037_交付版', '<p>既存を直している下書き</p>', '');
    await writeDraft('XX01_910024_全体版', '<p>全体版だけの下書き</p>', '');
    // 950155 の全体版は承認待ちの作成申請(同じ id の pending もある)。
    await writePending('XX01_950155_全体版', '<p>申請した生成物</p>', '');
    const { writeReview } = await import('../src/files/reviewFiles.js');
    await writeReview({
      id: '11111111-1111-4111-8111-111111111111',
      templateId: 'XX01_950155_全体版',
      attributes: { companyCode: 'XX01', fundCode: '950155', editionType: '全体版' },
      origin: 'create',
      status: 'pending',
      submittedBy: 'editor1',
      submittedAt: new Date().toISOString(),
      reviewedBy: null,
      reviewedAt: null,
      comment: null,
      baseHash: null,
      html: '<p>申請</p>',
      css: '',
    });
    const { createFakeSproc } = await import('./fakes/sprocFake.js');
    const { createTemplateRepo } = await import('../src/repositories/templateRepo.js');
    repo = createTemplateRepo(await createFakeSproc());
  });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('findTemplateId は templates/ だけを、大文字小文字を区別せずに見る', async () => {
    const { findTemplateId, listTemplateFiles } = await import('../src/files/templateFiles.js');
    const files = await listTemplateFiles();
    expect(findTemplateId(files, 'xx01', '950037', '交付版')).not.toBeNull();
    expect(findTemplateId(files, 'XX01', '950003', '交付版')).toBeNull(); // 全体版だけ
    expect(findTemplateId(files, 'XX01', '910024', '交付版')).toBeNull(); // filled/ にしか無い
    expect(findTemplateId(files, 'XX01', '950155', '交付版')).toBeNull(); // 旧形式だけ
  });

  it('委託会社は略称をファイル名の会社コード、Rep1 のコードを rep1CompanyCode で返す', async () => {
    expect(await repo.listCompanies()).toEqual([
      { companyCode: 'XX01', companyName: DUMMY_AM, rep1CompanyCode: 'R-XX01' },
    ]);
  });

  it('ファンドは Rep1 の会社コードで引く', async () => {
    const funds = await repo.listFunds('R-XX01');
    expect(funds.map((f) => f.fundCode)).toEqual([
      '910024',
      '950003',
      '950037',
      '950124',
      '950155',
    ]);
    expect(await repo.listFunds('R-ZZ99')).toEqual([]);
  });

  const st = async (f: string, e?: string, over: Partial<ReturnType<typeof q>> = {}) =>
    (await repo.getCreatableInfo({ ...q(f), ...over, ...(e ? { editionType: e } : {}) })).editions;

  it('版種を指定しなければ両版の状態を交付版・全体版の順で返す', async () => {
    expect(await st('950037')).toEqual([
      { editionType: '交付版', state: 'created', templateId: 'xx01_950037_交付版' },
      { editionType: '全体版', state: 'none' },
    ]);
  });

  it('作成済みの版の下書きは作業中に数えず、もう片方の版は版ごとに判定する', async () => {
    expect(await st('950003')).toEqual([
      { editionType: '交付版', state: 'inProgress', templateId: 'XX01_950003_交付版' },
      { editionType: '全体版', state: 'created', templateId: 'XX01_950003_全体版' },
    ]);
  });

  it('作業中は pending を優先し、綴り違いもファイルの綴りのまま返す', async () => {
    expect((await st('950124', undefined, { companyCode: 'xx01' }))[0]).toEqual({
      editionType: '交付版',
      state: 'inProgress',
      templateId: 'XX01_950124_交付版',
    });
    expect((await st('910024'))[1]).toEqual({
      editionType: '全体版',
      state: 'inProgress',
      templateId: 'XX01_910024_全体版',
    });
  });

  it('承認待ちの作成申請は pending があっても pendingReview で、templateId を持たない', async () => {
    expect(await st('950155')).toEqual([
      { editionType: '交付版', state: 'none' },
      { editionType: '全体版', state: 'pendingReview' },
    ]);
  });

  it('filled/・旧形式(4 つ区切り)は作成済みに数えない', async () => {
    expect((await st('910024'))[0]).toEqual({ editionType: '交付版', state: 'none' });
    expect((await st('950155'))[0]).toEqual({ editionType: '交付版', state: 'none' });
  });

  it('版種を指定すればその版の 1 件だけを返す', async () => {
    expect(await st('950003', '全体版')).toEqual([
      { editionType: '全体版', state: 'created', templateId: 'XX01_950003_全体版' },
    ]);
  });

  it('シリーズの他ファンドをコピー元候補にし、自分は含めず、テンプレの有無を付ける', async () => {
    // 生成は両版のコピー元を要るので、片方の版しか無い候補(950003 は全体版だけ、950037 は
    // 交付版だけ)は選べない。
    expect((await repo.getCreatableInfo(q('950155'))).seriesFunds).toEqual([
      { fundCode: '950003', fundName: 'ダミーバランスファンド（安定型）', hasTemplate: false },
      { fundCode: '950037', fundName: 'ダミーバランスファンド（切替型）', hasTemplate: false },
    ]);
    expect((await repo.getCreatableInfo(q('910024'))).seriesFunds).toEqual([]);

    // 両版がそろえば、押した版に関係なく選べる。
    const extra = path.join(tmp, 'templates', 'XX01_950037_全体版.html');
    fs.writeFileSync(extra, '<p>x</p>', 'utf8');
    try {
      for (const editionType of ['交付版', '全体版', undefined]) {
        const info = await repo.getCreatableInfo({
          ...q('950155'),
          ...(editionType ? { editionType } : {}),
        });
        expect(info.seriesFunds.find((f) => f.fundCode === '950037')?.hasTemplate).toBe(true);
      }
    } finally {
      fs.rmSync(extra);
    }
  });

  it('シリーズ一覧に行が無いファンドも落ちず、seriesFunds は空', async () => {
    const { createSprocClient } = await import('../src/db/sproc.js');
    const { SP } = await import('../src/db/sprocNames.js');
    const { createTemplateRepo } = await import('../src/repositories/templateRepo.js');
    // createSprocClient が組む SQL は `EXEC <proc> @操作=?, …` で、@操作 の値は values[0]。
    const sproc = createSprocClient(async (sql, values) => {
      if (sql.includes(SP.series)) return [];
      if (values[0] === 'ファンド一覧') return [{ ファンドコード: '777777', ファンド名: '行なし' }];
      return [];
    });
    const info = await createTemplateRepo(sproc).getCreatableInfo(q('777777'));
    expect(info).toEqual({
      editions: [
        { editionType: '交付版', state: 'none' },
        { editionType: '全体版', state: 'none' },
      ],
      seriesFunds: [],
    });
  });
});
