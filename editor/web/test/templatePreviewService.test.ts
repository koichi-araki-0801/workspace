import {
  err,
  type HistoryRepository,
  isErr,
  notFound,
  ok,
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
});
