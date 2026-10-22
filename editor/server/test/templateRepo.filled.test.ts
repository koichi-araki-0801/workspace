// =============================================================================
// templateRepo.filled.test.ts — 編集タブの一覧・取得が filled/ を主、templates/ を従とすること
// =============================================================================
// 値入り HTML(filled/)を置いたテンプレだけが一覧に出て、取得は filled/ の本文を `html` と
// `filled` の両方に返す。templates/(作成タブの Jinja)にしか無い id は一覧に出ないが、
// 取得では読める(作成経路の承認直後に精査画面が確定版を読むため)。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SprocClient } from '../src/db/sproc.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-template-repo-filled-'));
process.env.DATA_ROOT = tmp;
process.env.TEMPLATES_DIR = path.join(tmp, 'templates');
process.env.FILLED_DIR = path.join(tmp, 'filled');
process.env.CSS_DIR = path.join(tmp, 'css');
process.env.PENDING_DIR = path.join(tmp, 'pending');
process.env.DRAFTS_DIR = path.join(tmp, 'drafts');

const FILLED_ID = 'AM01_510037_20240710_交付版';
const JINJA_ONLY_ID = 'AM01_510037_全体版';
const BOTH_ID = 'AM01_110024_20251117_交付版';
const SKELETON_ID = 'AM01_510124_交付版';
const SKELETON_PENDING_ID = 'AM01_510155_交付版';
const NO_COMPANY_ID = '510037_20240710_交付版';

describe('templateRepo と filled/', () => {
  let repo: import('../src/repositories/templateRepo.js').TemplateRepo;

  beforeAll(async () => {
    for (const d of ['templates', 'filled', 'css', 'pending']) {
      fs.mkdirSync(path.join(tmp, d), { recursive: true });
    }
    fs.writeFileSync(path.join(tmp, 'filled', `${FILLED_ID}.html`), '<p>値入り 510037</p>', 'utf8');
    fs.writeFileSync(
      path.join(tmp, 'templates', `${JINJA_ONLY_ID}.html`),
      '<p>{{ x }}</p>',
      'utf8',
    );
    fs.writeFileSync(path.join(tmp, 'templates', `${BOTH_ID}.html`), '<p>{{ y }}</p>', 'utf8');
    fs.writeFileSync(path.join(tmp, 'filled', `${BOTH_ID}.html`), '<p>値入り 110024</p>', 'utf8');
    fs.writeFileSync(path.join(tmp, 'css', 'AM01_510037_交付版.css'), '.a{}', 'utf8');
    // 会社コードの無い 3 つ区切り(ファンド_基準日_版種)。3 つ区切りはテンプレートの形なので
    // 会社=510037・ファンド=20240710 と読めてしまうが、値入り HTML ではない。
    fs.writeFileSync(path.join(tmp, 'filled', `${NO_COMPANY_ID}.html`), '<p>会社なし</p>', 'utf8');
    const { createOfflineSproc } = await import('./helpers/offlineSproc.js');
    const { createTemplateRepo } = await import('../src/repositories/templateRepo.js');
    fs.writeFileSync(path.join(tmp, 'templates', `${SKELETON_ID}.html`), '<p>{{ s }}</p>', 'utf8');
    const { writePending } = await import('../src/files/pendingFiles.js');
    await writePending(SKELETON_PENDING_ID, '<p>{{ 生成直後 }}</p>', '');
    repo = createTemplateRepo(createOfflineSproc());
  });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('一覧は filled/ にあるテンプレだけを published として返す', async () => {
    const ids = (await repo.listTemplates({}))
      .filter((m) => m.status === 'published')
      .map((m) => `${m.id}:${m.status}`);
    expect(ids).toEqual([`${BOTH_ID}:published`, `${FILLED_ID}:published`]);
  });

  it('テンプレート(3 つ区切り)は templates/ を読み、基準日を持たない', async () => {
    const t = await repo.getTemplate(SKELETON_ID);
    expect(t.html).toBe('<p>{{ s }}</p>');
    expect(t.filled).toBe('');
    expect(t.meta.status).toBe('published');
    expect(t.meta.attributes).toEqual({
      companyCode: 'AM01',
      fundCode: '510124',
      editionType: '交付版',
    });
  });

  it('pending/ にしか無いテンプレート(基準日なし)は取得できるが、編集タブの一覧と候補には出ない', async () => {
    const t = await repo.getTemplate(SKELETON_PENDING_ID);
    expect(t.meta.status).toBe('draft');
    const ids = (await repo.listTemplates({})).map((m) => m.id);
    expect(ids).not.toContain(SKELETON_PENDING_ID);
    const opts = await repo.getDropdownOptions({ companyCode: 'AM01' }, 'edit');
    expect(opts.fundCodes).not.toContain('510155');
  });

  it('filled/ の 3 つ区切り(ファンド_基準日_版種 など)は一覧にも候補にも出ない', async () => {
    const ids = (await repo.listTemplates({})).map((m) => m.id);
    expect(ids).not.toContain(NO_COMPANY_ID);
    for (const scope of ['edit', 'published'] as const) {
      const opts = await repo.getDropdownOptions({}, scope);
      expect(opts.companyCodes).not.toContain('510037');
    }
  });

  it('pending/ の基準日つき(4 つ区切り)は編集タブの一覧に draft で出る', async () => {
    const { writePending } = await import('../src/files/pendingFiles.js');
    await writePending('AM01_510999_20240711_交付版', '<p>生成直後</p>', '');
    const row = (await repo.listTemplates({})).find((m) => m.id === 'AM01_510999_20240711_交付版');
    expect(row?.status).toBe('draft');
  });

  it('基準日で絞った一覧と候補に、基準日を持たない行は混ざらない', async () => {
    const ids = (await repo.listTemplates({ baseDate: '20240710' })).map((m) => m.id);
    expect(ids).not.toContain(SKELETON_PENDING_ID);
    const opts = await repo.getDropdownOptions({}, 'edit');
    expect(opts.baseDates.every((d) => d !== '')).toBe(true);
  });

  it('4 つ区切りの id は templates/ を読まない(旧形式のファイルがあっても filled/ → pending/ だけ)', async () => {
    fs.writeFileSync(
      path.join(tmp, 'templates', 'AM01_510003_20240710_交付版.html'),
      '<p>旧形式</p>',
      'utf8',
    );
    await expect(repo.getTemplate('AM01_510003_20240710_交付版')).rejects.toMatchObject({
      kind: 'not_found',
    });
  });

  it('取得は filled/ の本文を html と filled の両方に返す', async () => {
    const t = await repo.getTemplate(FILLED_ID);
    expect(t.html).toBe('<p>値入り 510037</p>');
    expect(t.filled).toBe('<p>値入り 510037</p>');
    expect(t.css).toBe('.a{}');
    expect(t.meta.status).toBe('published');
  });

  it('全体版(テンプレ)は交付版の CSS を読まない(版種ごとに別の CSS)', async () => {
    const t = await repo.getTemplate(JINJA_ONLY_ID);
    expect(t.css).toBe('');
  });

  it('CSS ファイルが見つからなければ cssMissing=true、あれば付けない', async () => {
    // FILLED_ID は css/AM01_510037_交付版.css がある。BOTH_ID(AM01_110024_…)は CSS が無い。
    expect((await repo.getTemplate(FILLED_ID)).cssMissing).toBeUndefined();
    expect((await repo.getTemplate(BOTH_ID)).cssMissing).toBe(true);
    // テンプレート(3 つ区切り)の確定版も同じ。
    expect((await repo.getTemplate(JINJA_ONLY_ID)).cssMissing).toBe(true);
  });

  it('中身が空の CSS ファイルは「ある」(cssMissing を付けない)', async () => {
    fs.writeFileSync(path.join(tmp, 'css', 'AM01_510124_交付版.css'), '', 'utf8');
    try {
      const t = await repo.getTemplate(SKELETON_ID);
      expect(t.css).toBe('');
      expect(t.cssMissing).toBeUndefined();
    } finally {
      fs.rmSync(path.join(tmp, 'css', 'AM01_510124_交付版.css'));
    }
  });

  it('pending の CSS が空のファイルとしてあれば cssMissing を付けない', async () => {
    expect((await repo.getTemplate(SKELETON_PENDING_ID)).cssMissing).toBeUndefined();
  });

  it('pending の CSS ファイルが無ければ cssMissing=true で css は空', async () => {
    fs.rmSync(path.join(tmp, 'pending', `${SKELETON_PENDING_ID}.css`));
    try {
      const t = await repo.getTemplate(SKELETON_PENDING_ID);
      expect(t.cssMissing).toBe(true);
      expect(t.css).toBe('');
    } finally {
      fs.writeFileSync(path.join(tmp, 'pending', `${SKELETON_PENDING_ID}.css`), '', 'utf8');
    }
  });

  it('filled/ と templates/ の両方にあれば filled/ が勝つ', async () => {
    const t = await repo.getTemplate(BOTH_ID);
    expect(t.html).toBe('<p>値入り 110024</p>');
  });

  it('templates/ にしか無い id は一覧に出ないが取得はできる(filled は空)', async () => {
    const t = await repo.getTemplate(JINJA_ONLY_ID);
    expect(t.html).toBe('<p>{{ x }}</p>');
    expect(t.filled).toBe('');
  });

  it('どこにも無い id は notFound', async () => {
    await expect(repo.getTemplate('AM01_999999_20240710_交付版')).rejects.toMatchObject({
      kind: 'not_found',
    });
  });

  it('一覧は companyCode/baseDate/editionType でも絞れる', async () => {
    const ids = (
      await repo.listTemplates({ companyCode: 'AM01', baseDate: '20240710', editionType: '交付版' })
    ).map((m) => m.id);
    expect(ids).toEqual([FILLED_ID]);
    const none = await repo.listTemplates({
      companyCode: 'AM01',
      baseDate: '20240710',
      editionType: '全体版',
    });
    expect(none).toEqual([]);
  });
});

describe('getSampleData(共通一覧の合成 + Rep1 の実名)', () => {
  let createTemplateRepo: typeof import('../src/repositories/templateRepo.js').createTemplateRepo;
  const ID = 'AM01_510037_20240710_交付版';

  beforeAll(async () => {
    ({ createTemplateRepo } = await import('../src/repositories/templateRepo.js'));
  });

  const COMMON = [
    { 共通サンプルID: 1, データJSON: JSON.stringify({ fund: { name: '共通名', nav: 1 }, a: 1 }) },
    { 共通サンプルID: 2, データJSON: JSON.stringify({ b: 2 }) },
  ];

  /** 共通一覧・委託会社一覧・ファンド一覧を固定で返す最小 sproc。`rep1Throws` で Rep1 側だけ落とす。 */
  const sprocOf = (opts: {
    common?: Record<string, unknown>[];
    companies?: Record<string, unknown>[];
    funds?: Record<string, unknown>[];
    rep1Throws?: boolean;
  }): SprocClient => ({
    async callSproc<T>(_proc: string, op: string): Promise<T[]> {
      if (op === '共通一覧') return (opts.common ?? COMMON) as T[];
      if (opts.rep1Throws) throw new Error('rep1 down');
      if (op === '委託会社一覧') return (opts.companies ?? []) as T[];
      if (op === 'ファンド一覧') return (opts.funds ?? []) as T[];
      return [];
    },
  });

  const COMPANIES = [
    { 委託会社コード: '00001', 委託会社名: '他社', 委託会社略称: 'ZZ99' },
    { 委託会社コード: '00002', 委託会社名: '実委託会社', 委託会社略称: 'am01  ' },
  ];
  const FUNDS = [
    { ファンドコード: '510001', ファンド名: '別ファンド' },
    { ファンドコード: '510037', ファンド名: '実ファンド' },
  ];

  it('共通一覧を合成し、Rep1 の委託会社名・ファンド名を被せる', async () => {
    const repo = createTemplateRepo(sprocOf({ companies: COMPANIES, funds: FUNDS }));
    const { sample, warnings } = await repo.getSampleData(ID);
    expect(warnings).toEqual([]);
    // 略称は末尾空白・大小を無視して引く。company.code はファイル名の会社コード(Rep1 の略称)。
    expect(sample).toEqual({
      fund: { name: '実ファンド', nav: 1, code: '510037' },
      company: { code: 'am01', name: '実委託会社' },
      a: 1,
      b: 2,
    });
  });

  it('3 区切り(基準日なし)の ID でも引ける', async () => {
    const repo = createTemplateRepo(sprocOf({ companies: COMPANIES, funds: FUNDS }));
    const { sample } = await repo.getSampleData('AM01_510037_交付版');
    expect(sample.fund).toMatchObject({ code: '510037', name: '実ファンド' });
  });

  it('Rep1 で見つからなければ共通値のまま返す(ファンドコードだけ被せる)', async () => {
    const repo = createTemplateRepo(sprocOf({ companies: [] }));
    expect((await repo.getSampleData(ID)).sample).toEqual({
      fund: { name: '共通名', nav: 1, code: '510037' },
      a: 1,
      b: 2,
    });
    // 会社は見つかるがファンドが無いときは、会社名だけ被さる。
    const noFund = createTemplateRepo(sprocOf({ companies: COMPANIES, funds: [] }));
    const r = (await noFund.getSampleData(ID)).sample;
    expect(r.fund).toEqual({ name: '共通名', nav: 1, code: '510037' });
    expect(r.company).toMatchObject({ name: '実委託会社' });
  });

  it('Rep1 の取得が失敗しても共通値を返す', async () => {
    const repo = createTemplateRepo(sprocOf({ rep1Throws: true }));
    const { sample, warnings } = await repo.getSampleData(ID);
    expect(warnings).toEqual([]);
    expect(sample.fund).toEqual({ name: '共通名', nav: 1, code: '510037' });
  });

  it('合成の warnings をそのまま返す', async () => {
    const repo = createTemplateRepo(
      sprocOf({
        common: [
          { 共通サンプルID: 1, データJSON: JSON.stringify({ k: 1 }) },
          { 共通サンプルID: 2, データJSON: JSON.stringify({ k: 2 }) },
          { 共通サンプルID: 3, データJSON: '{broken' },
        ],
      }),
    );
    const { sample, warnings } = await repo.getSampleData(ID);
    expect(sample.k).toBe(1);
    expect(warnings).toHaveLength(2);
  });

  it('行が無ければ fund.code だけの sample', async () => {
    const repo = createTemplateRepo(sprocOf({ common: [] }));
    expect((await repo.getSampleData(ID)).sample).toEqual({ fund: { code: '510037' } });
  });

  it('ID が不正なら validation', async () => {
    const repo = createTemplateRepo(sprocOf({}));
    await expect(repo.getSampleData('../evil')).rejects.toMatchObject({ kind: 'validation' });
    await expect(repo.getSampleData('AM01')).rejects.toMatchObject({ kind: 'validation' });
  });
});

describe('config.sampleOverlay の差し替え', () => {
  it('被せ先のパスは config.sampleOverlay に従う', async () => {
    const { config } = await import('../src/config.js');
    const { createTemplateRepo } = await import('../src/repositories/templateRepo.js');
    const saved = { ...config.sampleOverlay };
    Object.assign(config.sampleOverlay, { fundCode: 'x.code', fundName: 'x.name' });
    try {
      const repo = createTemplateRepo({
        async callSproc<T>(_proc: string, op: string): Promise<T[]> {
          if (op === '委託会社一覧') {
            return [{ 委託会社コード: '1', 委託会社名: '社', 委託会社略称: 'AM01' }] as T[];
          }
          if (op === 'ファンド一覧') return [{ ファンドコード: '510037', ファンド名: 'F' }] as T[];
          return [];
        },
      });
      expect((await repo.getSampleData('AM01_510037_交付版')).sample).toMatchObject({
        x: { code: '510037', name: 'F' },
      });
    } finally {
      Object.assign(config.sampleOverlay, saved);
    }
  });
});
