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
const TRUST_AM = '三井住友トラスト・アセットマネジメント株式会社';

const put = (dir: string, id: string) =>
  fs.writeFileSync(path.join(tmp, dir, `${id}.html`), '<p>x</p>', 'utf8');
const q = (fundCode: string) => ({
  companyCode: 'AM01',
  rep1CompanyCode: 'R-AM01',
  fundCode,
  editionType: '交付版',
});

describe('templateRepo の作成タブ用の問い合わせ', () => {
  let repo: import('../src/repositories/templateRepo.js').TemplateRepo;

  beforeAll(async () => {
    for (const d of ['templates', 'filled', 'pending'])
      fs.mkdirSync(path.join(tmp, d), { recursive: true });
    put('filled', 'am01_110024_20250101_交付版'); // filled/ にしか無い
    put('templates', 'am01_510037_交付版'); // 小文字の会社コード
    put('templates', 'AM01_510003_全体版');
    put('templates', 'AM01_510155_20240710_交付版'); // 旧形式(4 つ区切り)は数えない
    const { writePending } = await import('../src/files/pendingFiles.js');
    await writePending('AM01_510124_交付版', '<p>未確定</p>', '');
    const { writeDraft } = await import('../src/files/draftFiles.js');
    await writeDraft('AM01_510003_交付版', '<p>下書きだけ</p>', '');
    await writeDraft('am01_510037_交付版', '<p>既存を直している下書き</p>', '');
    const { createFakeSproc } = await import('./fakes/sprocFake.js');
    const { createTemplateRepo } = await import('../src/repositories/templateRepo.js');
    repo = createTemplateRepo(await createFakeSproc());
  });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('hasTemplateFor は templates/ だけを、大文字小文字を区別せずに見る', async () => {
    const { hasTemplateFor } = await import('../src/files/templateFiles.js');
    expect(await hasTemplateFor('am01', '510037', '交付版')).toBe(true);
    expect(await hasTemplateFor('AM01', '510003', '交付版')).toBe(false); // 全体版だけ
    expect(await hasTemplateFor('AM01', '110024', '交付版')).toBe(false); // filled/ にしか無い
    expect(await hasTemplateFor('AM01', '510155', '交付版')).toBe(false); // 旧形式だけ
  });

  it('委託会社は略称をファイル名の会社コード、Rep1 のコードを rep1CompanyCode で返す', async () => {
    expect(await repo.listCompanies()).toEqual([
      { companyCode: 'AM01', companyName: TRUST_AM, rep1CompanyCode: 'R-AM01' },
    ]);
  });

  it('ファンドは Rep1 の会社コードで引く', async () => {
    const funds = await repo.listFunds('R-AM01');
    expect(funds.map((f) => f.fundCode)).toEqual([
      '110024',
      '510003',
      '510037',
      '510124',
      '510155',
    ]);
    expect(await repo.listFunds('R-ZZ99')).toEqual([]);
  });

  it('作成済みは templates/ に 3 つ区切りがあるときだけ立つ(filled/・pending/・旧形式は見ない)', async () => {
    const created = async (f: string) => (await repo.getCreatableInfo(q(f))).created;
    expect(await created('510037')).toBe(true); // templates/
    expect(await created('110024')).toBe(false); // filled/ にしか無い
    expect(await created('510124')).toBe(false); // pending/ にしか無い
    expect(await created('510003')).toBe(false); // templates/ は全体版だけ
    expect(await created('510155')).toBe(false); // 旧形式だけ
  });

  it('作成済みは大文字小文字を区別せずに照合し、templateId はファイルの綴りのまま返す', async () => {
    expect(await repo.getCreatableInfo(q('510037'))).toMatchObject({
      created: true,
      templateId: 'am01_510037_交付版',
    });
    expect(await repo.getCreatableInfo(q('510003'))).not.toHaveProperty('templateId');
  });

  it('作業中(同じ id の pending か下書き)なら inProgressId を返す。作成済みなら返さない', async () => {
    expect(await repo.getCreatableInfo(q('510124'))).toMatchObject({
      created: false,
      inProgressId: 'AM01_510124_交付版', // pending
    });
    expect(await repo.getCreatableInfo(q('510003'))).toMatchObject({
      inProgressId: 'AM01_510003_交付版', // 下書きだけ
    });
    // 会社コードの綴りが違っても見つけ、id はファイルの綴りのまま返す(そのまま開ける)。
    expect(await repo.getCreatableInfo({ ...q('510124'), companyCode: 'am01' })).toMatchObject({
      inProgressId: 'AM01_510124_交付版',
    });
    expect(await repo.getCreatableInfo(q('510037'))).not.toHaveProperty('inProgressId');
    expect(await repo.getCreatableInfo(q('110024'))).not.toHaveProperty('inProgressId');
  });

  it('シリーズの他ファンドをコピー元候補にし、自分は含めず、テンプレの有無を付ける', async () => {
    expect((await repo.getCreatableInfo(q('510155'))).seriesFunds).toEqual([
      { fundCode: '510003', fundName: 'コア投資戦略ファンド（安定型）', hasTemplate: false },
      { fundCode: '510037', fundName: 'コア投資戦略ファンド（切替型）', hasTemplate: true },
    ]);
    expect((await repo.getCreatableInfo(q('110024'))).seriesFunds).toEqual([]);
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
    expect(info).toEqual({ created: false, seriesFunds: [] });
  });
});
