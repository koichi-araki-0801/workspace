import {
  conflict,
  err,
  isErr,
  isOk,
  ok,
  type TemplateMeta,
  type TemplateRepository,
} from '@editor/shared';
import { describe, expect, it, vi } from 'vitest';
import {
  createTemplateCreationService,
  SELECT_ALL_MSG,
} from '@/features/templates/services/templateCreationService';

const meta: TemplateMeta = {
  id: 'XX01_950037_20240710_kr',
  attributes: { companyCode: 'XX01', fundCode: '950037', baseDate: '20240710', editionType: 'kr' },
  fileName: 'XX01_950037_20240710_kr.html',
  status: 'draft',
  updatedAt: null,
  updatedBy: null,
};

function repoWithGenerate() {
  const generate = vi.fn(async () =>
    ok({
      template: { meta, html: '', css: '' },
      imported: [{ templateId: meta.id, editionType: '交付版' }],
      skipped: [],
    }),
  );
  return { generate } as unknown as TemplateRepository & { generate: typeof generate };
}

describe('TemplateCreationService.create', () => {
  it('rejects incomplete attributes without calling the repository', async () => {
    const repo = repoWithGenerate();
    const svc = createTemplateCreationService(repo);
    const res = await svc.create({ companyCode: 'XX01', fundCode: '', editionType: 'kr' });
    expect(isErr(res)).toBe(true);
    if (isErr(res)) {
      expect(res.error.kind).toBe('validation');
      expect(res.error.message).toBe(SELECT_ALL_MSG);
    }
    expect(repo.generate).not.toHaveBeenCalled();
  });

  it('editionType が無くても repo へ渡す', async () => {
    const repo = repoWithGenerate();
    const res = await createTemplateCreationService(repo).create({
      companyCode: 'XX01',
      fundCode: '950037',
    });
    expect(isOk(res)).toBe(true);
    expect(repo.generate).toHaveBeenCalledWith({ companyCode: 'XX01', fundCode: '950037' });
  });

  it('generates and returns the new meta when attributes are complete', async () => {
    const repo = repoWithGenerate();
    const svc = createTemplateCreationService(repo);
    const res = await svc.create({ companyCode: 'XX01', fundCode: '950037', editionType: 'kr' });
    expect(isOk(res)).toBe(true);
    if (isOk(res)) {
      expect(res.value).toEqual({
        meta,
        imported: [{ templateId: meta.id, editionType: '交付版' }],
        skipped: [],
      });
    }
    expect(repo.generate).toHaveBeenCalledOnce();
  });

  it('飛ばした版(skipped)をそのまま返す', async () => {
    const repo = repoWithGenerate();
    const skipped = [
      { templateId: 'XX01_950037_全体版', editionType: '全体版', reason: 'created' as const },
    ];
    repo.generate.mockResolvedValueOnce(
      ok({
        template: { meta, html: '', css: '' },
        imported: [{ templateId: meta.id, editionType: '交付版' }],
        skipped,
      }) as never,
    );
    const res = await createTemplateCreationService(repo).create({
      companyCode: 'XX01',
      fundCode: '950037',
      editionType: 'kr',
    });
    expect(isOk(res) && res.value.skipped).toEqual(skipped);
  });

  it('生成に成功したら、その id の同じタブの編集状態を捨てる(失敗したら捨てない)', async () => {
    const repo = repoWithGenerate();
    const forget = vi.fn();
    const svc = createTemplateCreationService(repo, forget);
    await svc.create({ companyCode: 'XX01', fundCode: '950037', editionType: 'kr' });
    expect(forget).toHaveBeenCalledWith(meta.id);
    forget.mockClear();
    repo.generate.mockResolvedValueOnce(err(conflict('作成中のテンプレートがあります')) as never);
    await svc.create({ companyCode: 'XX01', fundCode: '950037', editionType: 'kr' });
    expect(forget).not.toHaveBeenCalled();
  });

  it('取り込んだ全 id の編集状態を、重複なく捨てる', async () => {
    const repo = repoWithGenerate();
    repo.generate.mockResolvedValueOnce(
      ok({
        template: { meta, html: '', css: '' },
        imported: [
          { templateId: meta.id, editionType: '交付版' },
          { templateId: 'XX01_950037_全体版', editionType: '全体版' },
        ],
        skipped: [],
      }) as never,
    );
    const forget = vi.fn();
    await createTemplateCreationService(repo, forget).create({
      companyCode: 'XX01',
      fundCode: '950037',
      editionType: 'kr',
    });
    expect(forget.mock.calls.map((c) => c[0]).sort()).toEqual(
      [meta.id, 'XX01_950037_全体版'].sort(),
    );
  });

  it('template が無ければ meta は null で、imported の全 id の編集状態を捨てる', async () => {
    const repo = repoWithGenerate();
    const imported = [
      { templateId: 'XX01_950037_交付版', editionType: '交付版' },
      { templateId: 'XX01_950037_全体版', editionType: '全体版' },
    ];
    repo.generate.mockResolvedValueOnce(ok({ imported, skipped: [] }) as never);
    const forget = vi.fn();
    const res = await createTemplateCreationService(repo, forget).create({
      companyCode: 'XX01',
      fundCode: '950037',
      editionType: 'kr',
    });
    expect(isOk(res) && res.value).toEqual({ meta: null, imported, skipped: [] });
    expect(forget.mock.calls.map((c) => c[0]).sort()).toEqual(
      ['XX01_950037_交付版', 'XX01_950037_全体版'].sort(),
    );
  });
});

describe('TemplateCreationService の作成タブ用の問い合わせ', () => {
  it('listCompanies は repo へそのまま委譲する', async () => {
    const listCompanies = vi.fn(async () =>
      ok([{ companyCode: 'XX01', companyName: '会社', rep1CompanyCode: 'R-XX01' }]),
    );
    const svc = createTemplateCreationService({ listCompanies } as unknown as TemplateRepository);
    const res = await svc.listCompanies();
    expect(isOk(res) && res.value[0].rep1CompanyCode).toBe('R-XX01');
    expect(listCompanies).toHaveBeenCalledOnce();
  });

  it('listFunds は repo へそのまま委譲する', async () => {
    const listFunds = vi.fn(async () => ok([{ fundCode: '950037', fundName: 'F' }]));
    const svc = createTemplateCreationService({ listFunds } as unknown as TemplateRepository);
    const res = await svc.listFunds('R-XX01');
    expect(isOk(res)).toBe(true);
    expect(listFunds).toHaveBeenCalledWith('R-XX01');
  });

  it('getCreatableInfo は repo へそのまま委譲する', async () => {
    const info = { editions: [{ editionType: '交付版', state: 'none' as const }], seriesFunds: [] };
    const getCreatableInfo = vi.fn(async () => ok(info));
    const svc = createTemplateCreationService({
      getCreatableInfo,
    } as unknown as TemplateRepository);
    const q = {
      companyCode: 'XX01',
      rep1CompanyCode: 'R-XX01',
      fundCode: '950037',
      editionType: '交付版',
    };
    const res = await svc.getCreatableInfo(q);
    expect(isOk(res) && res.value).toEqual(info);
    expect(getCreatableInfo).toHaveBeenCalledWith(q);
  });
});
