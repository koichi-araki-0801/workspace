// =============================================================================
// PreviewView.reportPdf.dom.test.ts — 単体 PDF の経路(create_report / vivliostyle)の切り替え
// =============================================================================
// 値入り(4 つ区切り)のテンプレートで連携が有効なときだけ create_report の経路を使い、それ以外は
// 今までの vivliostyle(`renderPdf`)。create_report の失敗では vivliostyle へ切り替えない。
import { err, ok, REPORT_BUSY_USER, REPORT_BUSY_USER_MESSAGE, type Template } from '@editor/shared';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { REPOS_KEY } from '@/api/repositories';
import PreviewView from '@/features/preview/PreviewView.vue';

const h = vi.hoisted(() => ({
  loadForPreview: vi.fn(),
  renderPdf: vi.fn(),
  recordPdfExport: vi.fn(),
  toastError: vi.fn(),
  renderReportDocument: vi.fn(),
}));
vi.mock('vue-router', () => ({ useRoute: () => ({ query: {} }), useRouter: () => ({}) }));
vi.mock('@/components/ui/toast', () => ({ toastError: h.toastError, toastSuccess: vi.fn() }));
vi.mock('@/lib/pdfDocument', () => ({ renderReportDocument: h.renderReportDocument }));
vi.mock('@/features/preview/services/templatePreviewService', async (importOriginal) => {
  const mod =
    await importOriginal<typeof import('@/features/preview/services/templatePreviewService')>();
  return {
    ...mod,
    useTemplatePreviewService: () => ({
      loadForPreview: h.loadForPreview,
      renderPdf: h.renderPdf,
      recordPdfExport: h.recordPdfExport,
    }),
  };
});

const FILLED_ID = 'XX01_950037_20240710_交付版';
const SKELETON_ID = 'XX01_950037_交付版';

function tplOf(id: string): Template {
  return {
    meta: {
      id,
      attributes: {
        companyCode: 'XX01',
        fundCode: '950037',
        baseDate: '20240710',
        editionType: '交付版',
      },
      fileName: `${id}.html`,
      status: 'confirmed',
      updatedAt: null,
      updatedBy: null,
    },
    html: '<p>x</p>',
    css: '',
    filled: '<p>x</p>',
  };
}

async function mountView(
  id: string,
  status: 'enabled' | 'disabled' | 'error' | 'pending',
  buildReportPdf = vi.fn(async () => ok(new Blob(['pdf']))),
  isFilled = id === FILLED_ID,
) {
  h.loadForPreview.mockResolvedValue(
    ok({
      template: tplOf(id),
      sample: {},
      restoredHtml: '<p>body</p>',
      css: '',
      cssBaseline: '',
      previewDoc: '<html><body>x</body></html>',
      renderError: null,
      hasDraft: false,
      isFilled,
    }),
  );
  const templates = {
    getReportStatus: vi.fn(() =>
      status === 'pending'
        ? new Promise<never>(() => {})
        : Promise.resolve(
            status === 'error' ? err({ message: 'x' }) : ok({ enabled: status === 'enabled' }),
          ),
    ),
    buildReportPdf,
  };
  const w = mount(PreviewView, {
    props: { id },
    global: {
      provide: {
        [REPOS_KEY as symbol]: { templates, reviews: {}, fundAssets: { inspect: vi.fn() } },
      },
      stubs: {
        PreviewPanel: true,
        PageRail: true,
        AttributeBar: { template: '<span />' },
        Tooltip: { template: '<span><slot /></span>' },
      },
    },
  });
  await flushPromises();
  return { w, templates };
}

async function clickPdf(w: Awaited<ReturnType<typeof mountView>>['w']) {
  const btn = w.findAll('button').find((b) => b.text().includes('PDF出力'));
  await btn?.trigger('click');
  await flushPromises();
}

beforeEach(() => {
  setActivePinia(createPinia());
  for (const f of Object.values(h)) {
    f.mockReset();
  }
  URL.createObjectURL = vi.fn(() => 'blob:x');
  URL.revokeObjectURL = vi.fn();
  h.renderReportDocument.mockResolvedValue(ok('<html>doc</html>'));
  h.renderPdf.mockResolvedValue(ok(new Blob(['v'])));
});

describe('PreviewView の単体 PDF 経路', () => {
  it('uses buildReportPdf for filled id when report enabled', async () => {
    const { w, templates } = await mountView(FILLED_ID, 'enabled');
    await clickPdf(w);
    expect(h.renderReportDocument).toHaveBeenCalledWith(FILLED_ID, '<p>body</p>', 'XX01');
    expect(templates.buildReportPdf).toHaveBeenCalledWith(FILLED_ID, '<html>doc</html>');
    expect(h.renderPdf).not.toHaveBeenCalled();
    expect(h.recordPdfExport).toHaveBeenCalledWith(FILLED_ID);
  });

  it('uses renderPdf for skeleton id', async () => {
    const { w, templates } = await mountView(SKELETON_ID, 'enabled');
    await clickPdf(w);
    expect(h.renderPdf).toHaveBeenCalledTimes(1);
    expect(templates.buildReportPdf).not.toHaveBeenCalled();
    expect(h.recordPdfExport).toHaveBeenCalledWith(SKELETON_ID);
  });

  it.each(['disabled', 'error'] as const)('uses renderPdf when report %s', async (status) => {
    const { w, templates } = await mountView(FILLED_ID, status);
    await clickPdf(w);
    expect(h.renderPdf).toHaveBeenCalledTimes(1);
    expect(templates.buildReportPdf).not.toHaveBeenCalled();
  });

  it('hides crop marks toggle on report path', async () => {
    const on = await mountView(FILLED_ID, 'enabled');
    expect(on.w.text()).not.toContain('トンボ');
    const off = await mountView(FILLED_ID, 'disabled');
    expect(off.w.text()).toContain('トンボ');
  });

  it('does not fall back to renderPdf on report failure', async () => {
    const build = vi.fn(async () => err({ code: 'REPORT_FAILED', message: 'サーバの失敗文言' }));
    const { w } = await mountView(FILLED_ID, 'enabled', build);
    await clickPdf(w);
    expect(h.toastError).toHaveBeenCalledWith('サーバの失敗文言');
    expect(h.renderPdf).not.toHaveBeenCalled();
    expect(h.recordPdfExport).not.toHaveBeenCalled();
  });

  it('shows the per-user limit message as is', async () => {
    const build = vi.fn(async () =>
      err({ kind: 'unexpected', code: REPORT_BUSY_USER, message: REPORT_BUSY_USER_MESSAGE }),
    );
    const { w } = await mountView(FILLED_ID, 'enabled', build);
    await clickPdf(w);
    expect(h.toastError).toHaveBeenCalledWith(REPORT_BUSY_USER_MESSAGE);
    expect(h.renderPdf).not.toHaveBeenCalled();
  });

  it('disables PDF button while status is pending for a report candidate', async () => {
    const { w } = await mountView(FILLED_ID, 'pending');
    const btn = w.findAll('button').find((b) => b.text().includes('PDF出力'));
    expect(btn?.attributes('disabled')).toBeDefined();
  });

  it.each([false, true])(
    'keeps PDF button enabled for a 3-part id while status is pending (isFilled=%s)',
    async (isFilled) => {
      const { w, templates } = await mountView(SKELETON_ID, 'pending', undefined, isFilled);
      const btn = w.findAll('button').find((b) => b.text().includes('PDF出力'));
      expect(btn?.attributes('disabled')).toBeUndefined();
      await clickPdf(w);
      expect(h.renderPdf).toHaveBeenCalledTimes(1);
      expect(templates.buildReportPdf).not.toHaveBeenCalled();
    },
  );

  it('keeps crop marks out of the on-screen preview on report path', async () => {
    const on = await mountView(FILLED_ID, 'enabled');
    expect(on.w.findComponent({ name: 'PreviewPanel' }).props('html')).not.toContain('crop');
    const off = await mountView(FILLED_ID, 'disabled');
    expect(off.w.findComponent({ name: 'PreviewPanel' }).props('html')).toContain('crop');
  });

  it('shows the message and skips renderPdf when renderReportDocument fails', async () => {
    h.renderReportDocument.mockResolvedValue(err({ code: 'CONFLICT', message: '組み立て失敗' }));
    const { w, templates } = await mountView(FILLED_ID, 'enabled');
    await clickPdf(w);
    expect(h.toastError).toHaveBeenCalledWith('組み立て失敗');
    expect(h.renderPdf).not.toHaveBeenCalled();
    expect(templates.buildReportPdf).not.toHaveBeenCalled();
  });

  it('uses renderPdf for a 3-part id even when isFilled is true', async () => {
    const { w, templates } = await mountView(SKELETON_ID, 'enabled', undefined, true);
    await clickPdf(w);
    expect(h.renderPdf).toHaveBeenCalledTimes(1);
    expect(templates.buildReportPdf).not.toHaveBeenCalled();
    expect(w.text()).toContain('トンボ');
  });
});
