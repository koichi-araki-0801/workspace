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
import { createMergePdfService } from '@/features/merge/services/mergePdfService';

// 値埋めは `renderPdfDocument` 経由で opaque オリジンの iframe が行うため jsdom では
// 起動しない。ここで固定したいのは順序・進捗・履歴なので、隔離の向こう側にあたる
// nunjucks 実装を直に噛ませる(クライアントの契約は `renderHostClient.test.ts`)。
vi.mock('@/lib/renderHostClient', async () => {
  const { renderJinja } = await import('@/lib/nunjucksRender');
  return { renderJinjaIsolated: async (t: string, d: unknown) => renderJinja(t, d as never) };
});

/** id ごとに本文の違うテンプレを返すスタブ(版種はファンド共通サンプルへ被さる)。 */
function templatesOf(edition = '交付版'): TemplateRepository {
  return {
    getTemplate: vi.fn(async (id: string) =>
      ok({
        meta: {
          id,
          attributes: {
            companyCode: 'A',
            fundCode: 'F',
            baseDate: '20240101',
            editionType: edition,
          },
          fileName: `${id}.html`,
          status: 'draft',
          updatedAt: null,
          updatedBy: null,
        },
        html: `<html><body><p>doc-${id} {{ report.editionType }}</p></body></html>`,
        css: `.${id}{}`,
      } as Template),
    ),
    getSampleData: vi.fn(async () => ok({})),
  } as unknown as TemplateRepository;
}

function historyOf() {
  const recordPdfExport = vi.fn(async () => ok(undefined));
  return { repo: { recordPdfExport } as unknown as HistoryRepository, recordPdfExport };
}

describe('MergePdfService.renderMergedPdf', () => {
  it('sends documents in id order and resolves a PDF blob', async () => {
    const fetchSpy = vi.fn(async () => new Response('%PDF-1.4', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    const { repo, recordPdfExport } = historyOf();
    const svc = createMergePdfService(templatesOf(), repo);

    const res = await svc.renderMergedPdf(['t2', 't1']);
    vi.unstubAllGlobals();

    expect(isOk(res)).toBe(true);
    if (isOk(res)) expect(res.value).toBeInstanceOf(Blob);
    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(init.body as string) as { documents: { html: string; css: string }[] };
    expect(body.documents).toHaveLength(2);
    // 配列順 = 選択順(id 昇順などに並び替えない)。
    expect(body.documents[0].html).toContain('doc-t2');
    expect(body.documents[1].html).toContain('doc-t1');
    // 版種は applyTemplateAttributes で差し込まれる。
    expect(body.documents[0].html).toContain('交付版');
    // 履歴は各テンプレへ記録される。
    expect(recordPdfExport).toHaveBeenCalledTimes(2);
    expect(recordPdfExport).toHaveBeenCalledWith('t2');
    expect(recordPdfExport).toHaveBeenCalledWith('t1');
  });

  it('reports progress once per document', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('%PDF-1.4', { status: 200 })),
    );
    const svc = createMergePdfService(templatesOf(), historyOf().repo);
    const seen: [number, number][] = [];
    await svc.renderMergedPdf(['a', 'b', 'c'], (done, total) => seen.push([done, total]));
    vi.unstubAllGlobals();
    expect(seen).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
  });

  it('fails with a 何件目 message and skips fetch when a template is missing', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const templates = {
      getTemplate: vi.fn(async (id: string) =>
        id === 'bad'
          ? err(notFound('no'))
          : (templatesOf().getTemplate as (id: string) => unknown)(id),
      ),
      getSampleData: vi.fn(async () => ok({})),
    } as unknown as TemplateRepository;
    const svc = createMergePdfService(templates, historyOf().repo);

    const res = await svc.renderMergedPdf(['ok1', 'bad', 'ok2']);
    vi.unstubAllGlobals();

    expect(isErr(res)).toBe(true);
    if (isErr(res)) expect(res.error.message).toContain('(2件目)');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fails with a 何件目 message when a template does not render', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const templates = templatesOf();
    (templates.getTemplate as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      ok({
        meta: {
          id: 'x',
          attributes: { companyCode: 'A', fundCode: 'F', baseDate: '20240101', editionType: 'kr' },
          fileName: 'x.html',
          status: 'draft',
          updatedAt: null,
          updatedBy: null,
        },
        html: '<p>{{ oops</p>',
        css: '',
      } as Template),
    );
    const svc = createMergePdfService(templates, historyOf().repo);
    const res = await svc.renderMergedPdf(['x']);
    vi.unstubAllGlobals();
    expect(isErr(res)).toBe(true);
    if (isErr(res)) expect(res.error.message).toContain('(1件目)');
  });

  it('returns err when the server responds non-ok, without recording history', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('boom', { status: 500 })),
    );
    const { repo, recordPdfExport } = historyOf();
    const svc = createMergePdfService(templatesOf(), repo);
    const res = await svc.renderMergedPdf(['t1']);
    vi.unstubAllGlobals();
    expect(isErr(res)).toBe(true);
    if (isErr(res)) expect(res.error.cause).toBe('HTTP 500');
    expect(recordPdfExport).not.toHaveBeenCalled();
  });

  it('still resolves the blob when history recording fails (best effort)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('%PDF-1.4', { status: 200 })),
    );
    const repo = {
      recordPdfExport: vi.fn(async () => err(notFound('gone'))),
    } as unknown as HistoryRepository;
    const svc = createMergePdfService(templatesOf(), repo);
    const res = await svc.renderMergedPdf(['t1']);
    vi.unstubAllGlobals();
    expect(isOk(res)).toBe(true);
  });
});
