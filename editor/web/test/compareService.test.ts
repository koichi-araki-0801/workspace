import {
  err,
  type HistoryRepository,
  isErr,
  isOk,
  notFound,
  ok,
  type TemplateMeta,
  type TemplateRepository,
  type TemplateSnapshot,
  type TemplateVersionMeta,
} from '@editor/shared';
import { describe, expect, it, vi } from 'vitest';
import {
  COMPARE_RENDER_ERROR,
  createCompareService,
} from '@/features/compare/services/compareService';

const snapshot: TemplateSnapshot = {
  historyId: 'eh-1',
  templateId: 'AM01_510037_20240710_kr',
  html: '<p>{{ fund.name }}</p>',
  css: '.x{}',
  fundCode: '510037',
  timestamp: '2026-06-01T00:00:00.000Z',
};

describe('CompareService.renderVersionHtml', () => {
  it('propagates not_found when the snapshot is missing', async () => {
    const history = {
      getSnapshot: vi.fn(async () => err(notFound('no snapshot'))),
    } as unknown as HistoryRepository;
    const templates = {} as TemplateRepository;
    const svc = createCompareService(templates, history);

    const res = await svc.renderVersionHtml('eh-missing');
    expect(isErr(res)).toBe(true);
    if (isErr(res)) expect(res.error.kind).toBe('not_found');
  });

  it('renders the snapshot to HTML and returns the html and snapshot css', async () => {
    const history = {
      getSnapshot: vi.fn(async () => ok(snapshot)),
    } as unknown as HistoryRepository;
    const templates = {
      getSampleData: vi.fn(async () => ok({ fund: { name: 'テストファンド' } })),
    } as unknown as TemplateRepository;

    const svc = createCompareService(templates, history);
    const res = await svc.renderVersionHtml('eh-1');

    expect(isOk(res)).toBe(true);
    if (isOk(res)) {
      // the nunjucks-applied HTML and the snapshot CSS come back unchanged
      expect(res.value.html).toContain('テストファンド');
      expect(res.value.css).toBe('.x{}');
    }
  });

  it('returns the safe render error when the template fails to render', async () => {
    const history = {
      getSnapshot: vi.fn(async () => ok({ ...snapshot, html: '{% if %}' })),
    } as unknown as HistoryRepository;
    const templates = {
      getSampleData: vi.fn(async () => ok({})),
    } as unknown as TemplateRepository;

    const svc = createCompareService(templates, history);
    const res = await svc.renderVersionHtml('eh-1');

    expect(isErr(res)).toBe(true);
    if (isErr(res)) expect(res.error.message).toBe(COMPARE_RENDER_ERROR);
  });
});

describe('CompareService.listCandidates', () => {
  const meta = (id: string): TemplateMeta => ({
    id,
    attributes: {
      companyCode: 'AM01',
      fundCode: '510037',
      baseDate: '20240710',
      editionType: '確報',
    },
    fileName: `${id}.html`,
    status: 'published',
    updatedAt: null,
    updatedBy: null,
  });
  const version = (historyId: string, templateId: string): TemplateVersionMeta => ({
    historyId,
    templateId,
    timestamp: '2024-07-10T00:00:00.000Z',
    user: '山田太郎',
    summary: '確定保存',
  });

  it('returns every matched template with its confirmed-version count', async () => {
    const versionsById: Record<string, TemplateVersionMeta[]> = {
      a: [version('a2', 'a'), version('a1', 'a')],
      b: [version('b1', 'b')],
      c: [],
    };
    const templates = {
      listTemplates: vi.fn(async () => ok([meta('a'), meta('b'), meta('c')])),
    } as unknown as TemplateRepository;
    const history = {
      listVersions: vi.fn(async (id: string) => ok(versionsById[id] ?? [])),
    } as unknown as HistoryRepository;

    const svc = createCompareService(templates, history);
    const res = await svc.listCandidates({});

    expect(isOk(res)).toBe(true);
    if (isOk(res)) {
      expect(res.value.map((c) => [c.meta.id, c.versionCount])).toEqual([
        ['a', 2],
        ['b', 1],
        ['c', 0],
      ]);
    }
  });

  it('propagates a listTemplates error', async () => {
    const templates = {
      listTemplates: vi.fn(async () => err(notFound('boom'))),
    } as unknown as TemplateRepository;
    const history = {} as HistoryRepository;

    const svc = createCompareService(templates, history);
    const res = await svc.listCandidates({});
    expect(isErr(res)).toBe(true);
  });
});

describe('CompareService delegation', () => {
  it('listTemplates and listVersions delegate to the repos', async () => {
    const listTemplates = vi.fn(async () => ok([]));
    const listVersions = vi.fn(async () => ok([]));
    const svc = createCompareService(
      { listTemplates } as unknown as TemplateRepository,
      { listVersions } as unknown as HistoryRepository,
    );
    await svc.listTemplates({ companyCode: 'AM01' });
    await svc.listVersions('tpl-1');
    expect(listTemplates).toHaveBeenCalledWith({ companyCode: 'AM01' });
    expect(listVersions).toHaveBeenCalledWith('tpl-1');
  });
});
