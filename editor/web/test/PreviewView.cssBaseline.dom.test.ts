// =============================================================================
// PreviewView.cssBaseline.dom.test.ts — 申請画面の CSS の baseline(申請への載せ方と知らせ)
// =============================================================================
// baseline は編集画面が測って編集セッションのストア(と sessionStorage)に置く。プレビュー画面は
// それを読み、申請に `cssBaseline` として載せる。下書きがあるのに読めないときは、ペアへ CSS が
// 写らないことを申請前に知らせる(申請は止めない)。
import { ok, type Template } from '@editor/shared';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { REPOS_KEY } from '@/api/repositories';
import PreviewView from '@/features/preview/PreviewView.vue';
import { CSS_BASELINE_MISSING_MSG } from '@/features/preview/services/templatePreviewService';
import { useEditorSessionStore } from '@/stores/editorSession';

const { loadForPreview } = vi.hoisted(() => ({ loadForPreview: vi.fn() }));
vi.mock('vue-router', () => ({ useRoute: () => ({ query: {} }), useRouter: () => ({}) }));
vi.mock('@/components/ui/toast', () => ({ toastError: vi.fn(), toastSuccess: vi.fn() }));
vi.mock('@/components/ui/confirm', () => ({ confirm: vi.fn(async () => true) }));
vi.mock('@/features/reviews/services/changedSummary', () => ({
  useChangedSummaryService: () => ({ computeChangedSummary: vi.fn(async () => null) }),
}));
vi.mock('@/features/preview/services/templatePreviewService', async (importOriginal) => {
  const mod =
    await importOriginal<typeof import('@/features/preview/services/templatePreviewService')>();
  return {
    ...mod,
    useTemplatePreviewService: () => ({
      loadForPreview,
      renderPdf: vi.fn(),
      recordPdfExport: vi.fn(),
    }),
  };
});

const ID = 'AM01_510037_20240710_交付版';
const tpl: Template = {
  meta: {
    id: ID,
    attributes: {
      companyCode: 'AM01',
      fundCode: '510037',
      baseDate: '20240710',
      editionType: '交付版',
    },
    fileName: `${ID}.html`,
    status: 'confirmed',
    updatedAt: null,
    updatedBy: null,
  },
  html: '<p>x</p>',
  css: '.a{}',
  filled: '<p>x</p>',
};

/**
 * プレビューの読み込み結果。`templatePreviewService` と同じ規則で、下書きがあれば編集画面の
 * baseline をそのまま返し、無ければ申請する css を返す。
 */
function stubLoad(hasDraft: boolean) {
  loadForPreview.mockImplementation(
    async (_id: string, opts?: { editorCssBaseline?: string | null }) =>
      ok({
        template: tpl,
        sample: {},
        restoredHtml: '<p>x</p>',
        css: '.a{color:red;}',
        cssBaseline: hasDraft ? (opts?.editorCssBaseline ?? null) : '.a{color:red;}',
        previewDoc: '<html><body>x</body></html>',
        renderError: null,
        hasDraft,
        isFilled: true,
      }),
  );
}

async function mountView() {
  const reviews = { submitReview: vi.fn(async () => ok({ id: 'r1' })) };
  const w = mount(PreviewView, {
    props: { id: ID },
    global: {
      provide: { [REPOS_KEY as symbol]: { reviews } },
      stubs: {
        PreviewPanel: true,
        PageRail: true,
        AttributeBar: { template: '<span />' },
        Tooltip: { template: '<span><slot /></span>' },
      },
    },
  });
  await flushPromises();
  return { w, reviews };
}

async function submit(w: Awaited<ReturnType<typeof mountView>>['w']) {
  const btn = w.findAll('button').find((b) => b.text().includes('確定保存'));
  expect(btn).toBeDefined();
  await btn?.trigger('click');
  await flushPromises();
}

beforeEach(() => {
  setActivePinia(createPinia());
  sessionStorage.clear();
  loadForPreview.mockReset();
});

describe('申請画面の CSS の baseline', () => {
  it('再読み込み後も sessionStorage の baseline を申請に載せ、知らせは出さない', async () => {
    useEditorSessionStore().setCssBaseline(ID, '.a{color:blue;}');
    setActivePinia(createPinia()); // 再読み込み相当(ストアのメモリは空)
    stubLoad(true);
    const { w, reviews } = await mountView();
    expect(loadForPreview).toHaveBeenCalledWith(ID, { editorCssBaseline: '.a{color:blue;}' });
    expect(w.find('[data-testid="css-baseline-notice"]').exists()).toBe(false);
    await submit(w);
    expect(reviews.submitReview).toHaveBeenCalledWith(
      expect.objectContaining({ cssBaseline: '.a{color:blue;}' }),
    );
  });

  it('下書きがあって baseline が無ければ知らせを出し、申請は baseline 無しで通す', async () => {
    stubLoad(true);
    const { w, reviews } = await mountView();
    const notice = w.find('[data-testid="css-baseline-notice"]');
    expect(notice.exists()).toBe(true);
    expect(notice.text()).toContain(CSS_BASELINE_MISSING_MSG);
    await submit(w);
    expect(reviews.submitReview).toHaveBeenCalledTimes(1);
    expect(reviews.submitReview.mock.calls[0]?.[0]).not.toHaveProperty('cssBaseline');
  });

  it('下書きが無ければ知らせを出さず、申請する css を baseline として載せる', async () => {
    stubLoad(false);
    const { w, reviews } = await mountView();
    expect(w.find('[data-testid="css-baseline-notice"]').exists()).toBe(false);
    await submit(w);
    expect(reviews.submitReview).toHaveBeenCalledWith(
      expect.objectContaining({ cssBaseline: '.a{color:red;}' }),
    );
  });
});
