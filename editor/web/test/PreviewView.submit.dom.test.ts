// =============================================================================
// PreviewView.submit.dom.test.ts — 確定保存の申請を二重に出さないこと
// =============================================================================
// 確認ダイアログを閉じた後の変更概要の計算は長引きうる(数十秒)。その間に申請ボタンが押せると、
// 同じ編集が 2 件の承認待ちとして出てしまう。
import { conflict, err, notFound, ok, type Template } from '@editor/shared';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { REPOS_KEY } from '@/api/repositories';
import PreviewView from '@/features/preview/PreviewView.vue';
import { useEditorSessionStore } from '@/stores/editorSession';

const { loadForPreview, computeChangedSummary } = vi.hoisted(() => ({
  loadForPreview: vi.fn(),
  computeChangedSummary: vi.fn(),
}));
vi.mock('vue-router', () => ({ useRoute: () => ({ query: {} }), useRouter: () => ({}) }));
vi.mock('@/components/ui/toast', () => ({ toastError: vi.fn(), toastSuccess: vi.fn() }));

import { toastError } from '@/components/ui/toast';

vi.mock('@/components/ui/confirm', () => ({ confirm: vi.fn(async () => true) }));
vi.mock('@/features/reviews/services/changedSummary', () => ({
  useChangedSummaryService: () => ({ computeChangedSummary }),
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

function stubLoad() {
  loadForPreview.mockResolvedValue(
    ok({
      template: tpl,
      sample: {},
      restoredHtml: '<p>x</p>',
      css: '.a{color:red;}',
      cssBaseline: '.a{color:red;}',
      previewDoc: '<html><body>x</body></html>',
      renderError: null,
      hasDraft: false,
      isFilled: true,
    }),
  );
}

async function mountView(submitReview: () => Promise<unknown> = async () => ok({ id: 'r1' })) {
  const reviews = { submitReview: vi.fn(submitReview) };
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

const submitButton = (w: Awaited<ReturnType<typeof mountView>>['w']) =>
  w.findAll('button').find((b) => b.text().includes('確定保存'));

beforeEach(() => {
  setActivePinia(createPinia());
  sessionStorage.clear();
  loadForPreview.mockReset();
  computeChangedSummary.mockReset();
});

describe('確定保存の申請', () => {
  it('変更概要の計算中は申請ボタンを押せず、続けて押しても申請は 1 件だけ', async () => {
    stubLoad();
    let releaseSummary: (v: null) => void = () => {};
    computeChangedSummary.mockImplementation(
      () =>
        new Promise<null>((r) => {
          releaseSummary = r;
        }),
    );
    const { w, reviews } = await mountView();
    await submitButton(w)?.trigger('click');
    await flushPromises();
    expect(computeChangedSummary).toHaveBeenCalledTimes(1);
    expect(submitButton(w)?.attributes('disabled')).toBeDefined();

    await submitButton(w)?.trigger('click');
    await flushPromises();
    releaseSummary(null);
    await flushPromises();
    expect(reviews.submitReview).toHaveBeenCalledTimes(1);
    expect(submitButton(w)?.attributes('disabled')).toBeUndefined();
  });

  const DUP_MSG = '同じ内容の確定保存申請が既に承認待ちです。新しい申請は作りませんでした。';

  async function submitWith(res: unknown) {
    stubLoad();
    computeChangedSummary.mockResolvedValue(null);
    const clear = vi.spyOn(useEditorSessionStore(), 'clear');
    const { w } = await mountView(async () => res);
    await submitButton(w)?.trigger('click');
    await flushPromises();
    return clear;
  }

  it('同じ内容が既に承認待ち(REVIEW_DUPLICATE)なら、編集セッションを片付けてエラーを toast に出す', async () => {
    vi.mocked(toastError).mockClear();
    const clear = await submitWith(err(conflict(DUP_MSG, { code: 'REVIEW_DUPLICATE' })));
    expect(clear).toHaveBeenCalledWith(ID);
    expect(toastError).toHaveBeenCalledWith(DUP_MSG);
  });

  it('ほかのエラーでは編集セッションを片付けない', async () => {
    vi.mocked(toastError).mockClear();
    const clear = await submitWith(err(notFound('x')));
    expect(clear).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledWith('x');
    const clear2 = await submitWith(err(conflict('他の競合', { code: 'OTHER' })));
    expect(clear2).not.toHaveBeenCalled();
  });
});
