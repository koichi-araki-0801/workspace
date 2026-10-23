// =============================================================================
// PreviewView.assetWarnings.dom.test.ts — プレビュー画面の警告欄(SVG の検査で配信しない画像)
// =============================================================================
// 組み立て済み文書の配信対象の画像を、画像の確認(`fundAssets.inspect`)へまとめて問い合わせ、
// `svg_rejected` を理由付きで警告欄に足す。問い合わせは非同期で、失敗しても画面は止めず警告も
// 足さない。
import { appError, err, ok, type Template } from '@editor/shared';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { REPOS_KEY } from '@/api/repositories';
import PreviewView from '@/features/preview/PreviewView.vue';
import { cssMissingMessage } from '@/lib/assetWarnings';

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

const ID = 'SMTAM_510037_20240710_交付版';
const tpl: Template = {
  meta: {
    id: ID,
    attributes: {
      companyCode: 'SMTAM',
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
  css: '',
  filled: '<p>x</p>',
  cssMissing: true,
};

const DOC =
  '<html><body><img src="../images/smtam/qr_code.svg"><img src="../images/510037_logo.png">' +
  '<img src="../images/am01/x.svg"></body></html>';

const SVG_MSG =
  'SVG の検査で配信しない画像があります（qr_code.svg: 許可されていない属性 name）。' +
  '外部ツールの出力を直してください';

function stubLoad(previewDoc: string) {
  loadForPreview.mockResolvedValue(
    ok({
      template: tpl,
      sample: {},
      restoredHtml: '<p>x</p>',
      css: '',
      cssBaseline: null,
      previewDoc,
      renderError: null,
      hasDraft: false,
      isFilled: true,
    }),
  );
}

async function mountView(fundAssets: unknown) {
  const w = mount(PreviewView, {
    props: { id: ID },
    global: {
      provide: { [REPOS_KEY as symbol]: { reviews: {}, fundAssets } },
      stubs: {
        PreviewPanel: true,
        PageRail: true,
        AttributeBar: { template: '<span />' },
        Tooltip: { template: '<span><slot /></span>' },
      },
    },
  });
  await flushPromises();
  return w;
}

const warningTexts = (w: Awaited<ReturnType<typeof mountView>>) =>
  w.findAll('[role="alert"] li').map((li) => li.text());

beforeEach(() => {
  setActivePinia(createPinia());
  loadForPreview.mockReset();
});

describe('プレビューの警告欄: SVG の検査で配信しない画像', () => {
  it('配信対象の画像をまとめて問い合わせ、svg_rejected を画像の警告の後ろに出す', async () => {
    stubLoad(DOC);
    const inspect = vi.fn(async (refs: Array<{ dir: string | null; file: string }>) =>
      ok(
        refs.map((ref) =>
          ref.file === 'qr_code.svg'
            ? { ...ref, status: 'svg_rejected', violations: ['許可されていない属性 name'] }
            : { ...ref, status: 'ok' },
        ),
      ),
    );
    const w = await mountView({ inspect });
    expect(inspect).toHaveBeenCalledTimes(1);
    expect(inspect).toHaveBeenCalledWith([
      { dir: 'smtam', file: 'qr_code.svg' },
      { dir: null, file: '510037_logo.png' },
    ]);
    const texts = warningTexts(w);
    expect(texts).toHaveLength(3);
    expect(texts[0]).toBe(cssMissingMessage(ID));
    expect(texts[1]).toContain('会社フォルダ名');
    expect(texts[2]).toBe(SVG_MSG);
  });

  it.each([
    ['err を返す', async () => err(appError('network', 'x'))],
    [
      '例外を投げる',
      async () => {
        throw new Error('boom');
      },
    ],
  ])('問い合わせが%sときは警告を足さず、画面は開いたまま', async (_l, impl) => {
    stubLoad(DOC);
    const inspect = vi.fn(impl);
    const w = await mountView({ inspect });
    expect(inspect).toHaveBeenCalledTimes(1);
    const texts = warningTexts(w);
    expect(texts).toHaveLength(2);
    expect(texts.some((t) => t.includes('SVG の検査'))).toBe(false);
  });

  it('配信対象の画像が無ければ問い合わせない', async () => {
    stubLoad('<html><body><p>x</p></body></html>');
    const inspect = vi.fn();
    await mountView({ inspect });
    expect(inspect).not.toHaveBeenCalled();
  });
});
