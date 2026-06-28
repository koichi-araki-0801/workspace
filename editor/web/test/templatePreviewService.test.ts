import {
  type ConfirmSaveRequest,
  err,
  type HistoryRepository,
  isErr,
  isOk,
  notFound,
  ok,
  type Template,
  type TemplateRepository,
} from '@editor/shared';
import { describe, expect, it, vi } from 'vitest';
import {
  createTemplatePreviewService,
  PDF_ERROR_MSG,
} from '@/features/preview/services/templatePreviewService';

const history = {
  recordPdfExport: vi.fn(async () => ok(undefined)),
} as unknown as HistoryRepository;

const tpl: Template = {
  meta: {
    id: 't1',
    attributes: { companyCode: 'A', fundCode: 'F', baseDate: '20240101', editionType: 'kr' },
    fileName: 't1.html',
    status: 'draft',
    updatedAt: null,
    updatedBy: null,
  },
  html: '<html><body><p>hello</p></body></html>',
  css: '.from-file{}',
};

describe('TemplatePreviewService.loadForPreview', () => {
  it('propagates a not_found from getTemplate', async () => {
    const templates = {
      getTemplate: vi.fn(async () => err(notFound('no'))),
    } as unknown as TemplateRepository;
    const svc = createTemplatePreviewService(templates, history);
    const res = await svc.loadForPreview('x');
    expect(isErr(res)).toBe(true);
    if (isErr(res)) expect(res.error.kind).toBe('not_found');
  });

  it('builds a preview document from the source file when there is no draft', async () => {
    const templates = {
      getTemplate: vi.fn(async () => ok(tpl)),
      getSampleData: vi.fn(async () => ok({})),
      getDraft: vi.fn(async () => ok(null)),
    } as unknown as TemplateRepository;
    const svc = createTemplatePreviewService(templates, history);
    const res = await svc.loadForPreview('t1');
    expect(isOk(res)).toBe(true);
    if (isOk(res)) {
      expect(res.value.renderError).toBeNull();
      expect(res.value.previewDoc).toContain('hello');
      expect(res.value.previewDoc).toContain('data-preview-css');
      expect(res.value.restoredHtml).toBe(tpl.html);
    }
  });

  it('restores the draft body when an autosaved draft exists', async () => {
    const templates = {
      getTemplate: vi.fn(async () => ok(tpl)),
      getSampleData: vi.fn(async () => ok({})),
      getDraft: vi.fn(async () =>
        ok({
          templateId: 't1',
          html: '<p>draft</p>',
          css: '.from-draft{}',
          savedAt: '',
          savedBy: '',
        }),
      ),
    } as unknown as TemplateRepository;
    const svc = createTemplatePreviewService(templates, history);
    const res = await svc.loadForPreview('t1');
    expect(isOk(res)).toBe(true);
    if (isOk(res)) {
      // css は整形されて返る(`.from-draft {}`)。draft 由来であることを確認する。
      expect(res.value.css).toContain('.from-draft');
      expect(res.value.restoredHtml).toContain('draft');
    }
  });

  it('reports a user-facing render error when the template fails to render', async () => {
    const templates = {
      getTemplate: vi.fn(async () => ok({ ...tpl, html: '<body>{{ oops</body>' })),
      getSampleData: vi.fn(async () => ok({})),
      getDraft: vi.fn(async () => ok(null)),
    } as unknown as TemplateRepository;
    const svc = createTemplatePreviewService(templates, history);
    const res = await svc.loadForPreview('t1');
    expect(isOk(res)).toBe(true);
    if (isOk(res)) expect(res.value.renderError).not.toBeNull();
  });
});

describe('TemplatePreviewService.confirmSave / recordPdfExport', () => {
  it('delegates confirmSave to the template repository', async () => {
    const meta = tpl.meta;
    const confirmSave = vi.fn(async () => ok(meta));
    const templates = { confirmSave } as unknown as TemplateRepository;
    const svc = createTemplatePreviewService(templates, history);
    const req = { templateId: 't1' } as unknown as ConfirmSaveRequest;
    const res = await svc.confirmSave(req);
    expect(isOk(res)).toBe(true);
    expect(confirmSave).toHaveBeenCalledWith(req);
  });

  it('delegates recordPdfExport to the history repository', async () => {
    const recordPdfExport = vi.fn(async () => ok(undefined));
    const hist = { recordPdfExport } as unknown as HistoryRepository;
    const svc = createTemplatePreviewService({} as TemplateRepository, hist);
    const res = await svc.recordPdfExport('t1');
    expect(isOk(res)).toBe(true);
    expect(recordPdfExport).toHaveBeenCalledWith('t1');
  });
});

describe('TemplatePreviewService.renderPdf', () => {
  it('returns err with the safe PDF message when the server responds non-ok', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('boom', { status: 500 })),
    );
    const svc = createTemplatePreviewService({} as TemplateRepository, history);
    const res = await svc.renderPdf('<p>hi</p>', '', {});
    vi.unstubAllGlobals();
    expect(isErr(res)).toBe(true);
    if (isErr(res)) {
      expect(res.error.message).toBe(PDF_ERROR_MSG);
      expect(res.error.cause).toBe('HTTP 500');
    }
  });

  it('returns a PDF blob when the server responds ok', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('%PDF-1.4', { status: 200 })),
    );
    const svc = createTemplatePreviewService({} as TemplateRepository, history);
    const res = await svc.renderPdf('<p>hi</p>', '.c{}', {});
    vi.unstubAllGlobals();
    expect(isOk(res)).toBe(true);
    if (isOk(res)) expect(res.value).toBeInstanceOf(Blob);
  });

  it('returns err without calling fetch when the template fails to render', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const svc = createTemplatePreviewService({} as TemplateRepository, history);
    const res = await svc.renderPdf('<p>{{ oops</p>', '', {});
    vi.unstubAllGlobals();
    expect(isErr(res)).toBe(true);
    if (isErr(res)) expect(res.error.message).toBe(PDF_ERROR_MSG);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
