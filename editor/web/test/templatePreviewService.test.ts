import {
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
import { CROP_MARKS_CSS } from '@/lib/cropMarks';

// 描画は opaque オリジンの iframe(`lib/renderHostClient.ts`)が行うため jsdom では起動しない。
// ここで固定したいのは draft 適用・文書組み立て・PDF 送信なので、隔離の向こう側にあたる
// nunjucks 実装を直に噛ませる(クライアントの契約は `renderHostClient.test.ts`)。
vi.mock('@/lib/renderHostClient', async () => {
  const { renderJinja } = await import('@/lib/nunjucksRender');
  return { renderJinjaIsolated: async (t: string, d: unknown) => renderJinja(t, d as never) };
});

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
      // 画面が「変更なし」を出せるよう、draft の有無をそのまま伝える。
      expect(res.value.hasDraft).toBe(false);
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
      expect(res.value.hasDraft).toBe(true);
    }
  });

  it('returns a validation err when a draft carries an un-restorable Jinja mask', async () => {
    // canvas 入口を素通りした攻撃形の draft(data-opaque に任意 HTML)。toTemplate が
    // 復元段で throw し、それが Result の validation エラーとして届くこと(throw が漏れない)。
    const { b64encode } = await import('@/lib/jinjaMask');
    const enc = b64encode('<img src=x onerror=alert(1)>');
    const templates = {
      getTemplate: vi.fn(async () => ok(tpl)),
      getSampleData: vi.fn(async () => ok({})),
      getDraft: vi.fn(async () =>
        ok({
          templateId: 't1',
          html: `<p><span data-opaque="${enc}" data-opaque-kind="script">JS</span></p>`,
          css: '.c{}',
          savedAt: '',
          savedBy: '',
        }),
      ),
    } as unknown as TemplateRepository;
    const svc = createTemplatePreviewService(templates, history);
    const res = await svc.loadForPreview('t1');
    expect(isErr(res)).toBe(true);
    if (isErr(res)) expect(res.error.kind).toBe('validation');
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

describe('TemplatePreviewService.recordPdfExport', () => {
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
    const res = await svc.renderPdf('<p>hi</p>', '', {}, false);
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
    const res = await svc.renderPdf('<p>hi</p>', '.c{}', {}, false);
    vi.unstubAllGlobals();
    expect(isOk(res)).toBe(true);
    if (isOk(res)) expect(res.value).toBeInstanceOf(Blob);
  });

  it('appends trim-mark CSS to the sent css only when cropMarks is on', async () => {
    const bodyOf = async (cropMarks: boolean): Promise<string> => {
      const fetchSpy = vi.fn(async () => new Response('%PDF-1.4', { status: 200 }));
      vi.stubGlobal('fetch', fetchSpy);
      const svc = createTemplatePreviewService({} as TemplateRepository, history);
      await svc.renderPdf('<p>hi</p>', '.c{}', {}, cropMarks);
      vi.unstubAllGlobals();
      const init = fetchSpy.mock.calls[0][1] as RequestInit;
      return JSON.parse(init.body as string).css as string;
    };
    expect(await bodyOf(true)).toContain(CROP_MARKS_CSS);
    expect(await bodyOf(false)).not.toContain(CROP_MARKS_CSS);
  });

  it('returns err without calling fetch when the template fails to render', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const svc = createTemplatePreviewService({} as TemplateRepository, history);
    const res = await svc.renderPdf('<p>{{ oops</p>', '', {}, false);
    vi.unstubAllGlobals();
    expect(isErr(res)).toBe(true);
    if (isErr(res)) expect(res.error.message).toBe(PDF_ERROR_MSG);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
