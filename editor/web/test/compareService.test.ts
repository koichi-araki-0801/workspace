import {
  err,
  type HistoryRepository,
  isErr,
  isOk,
  notFound,
  ok,
  type TemplateRepository,
  type TemplateSnapshot,
} from '@editor/shared';
import { describe, expect, it, vi } from 'vitest';
import {
  COMPARE_PDF_ERROR,
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

describe('CompareService.renderVersion', () => {
  it('propagates not_found when the snapshot is missing', async () => {
    const history = {
      getSnapshot: vi.fn(async () => err(notFound('no snapshot'))),
    } as unknown as HistoryRepository;
    const templates = {} as TemplateRepository;
    const svc = createCompareService(templates, history);

    const res = await svc.renderVersion('eh-missing');
    expect(isErr(res)).toBe(true);
    if (isErr(res)) expect(res.error.kind).toBe('not_found');
  });

  it('renders the snapshot and POSTs it to /api/pdf, returning the blob', async () => {
    const history = {
      getSnapshot: vi.fn(async () => ok(snapshot)),
    } as unknown as HistoryRepository;
    const templates = {
      getSampleData: vi.fn(async () => ok({ fund: { name: 'テストファンド' } })),
    } as unknown as TemplateRepository;

    const fetchMock = vi.fn(async () => new Response(new Blob(['%PDF-1.7']), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const svc = createCompareService(templates, history);
    const res = await svc.renderVersion('eh-1');
    vi.unstubAllGlobals();

    expect(isOk(res)).toBe(true);
    // the rendered (nunjucks-applied) HTML and the snapshot CSS are sent
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.html).toContain('テストファンド');
    expect(body.css).toBe('.x{}');
  });

  it('returns the safe PDF error when the server responds non-ok', async () => {
    const history = {
      getSnapshot: vi.fn(async () => ok(snapshot)),
    } as unknown as HistoryRepository;
    const templates = {
      getSampleData: vi.fn(async () => ok({})),
    } as unknown as TemplateRepository;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('boom', { status: 500 })),
    );

    const svc = createCompareService(templates, history);
    const res = await svc.renderVersion('eh-1');
    vi.unstubAllGlobals();

    expect(isErr(res)).toBe(true);
    if (isErr(res)) {
      expect(res.error.message).toBe(COMPARE_PDF_ERROR);
      expect(res.error.cause).toBe('HTTP 500');
    }
  });
});
