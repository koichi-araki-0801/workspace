// =============================================================================
// PreviewView.jinjaLoss.dom.test.ts — 作成経路の申請の確認に Jinja のブロックの減少を出す
// =============================================================================
// 範囲の印の開きと閉じを両方消すと、そのブロックは例外にならずに地の本文として申請される。作成経路
// だけ、元のテンプレートと申請する本文のブロックの開きの数を比べ、減っていれば確認の説明に一文を
// 足す(申請は続けられる)。編集経路は値入り HTML で `toTemplate` を通らないので出さない。
import { ok, type Template } from '@editor/shared';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { REPOS_KEY } from '@/api/repositories';
import { confirm } from '@/components/ui/confirm';
import PreviewView from '@/features/preview/PreviewView.vue';

const { loadForPreview, routeQuery } = vi.hoisted(() => ({
  loadForPreview: vi.fn(),
  routeQuery: {} as Record<string, string>,
}));
vi.mock('vue-router', () => ({ useRoute: () => ({ query: routeQuery }), useRouter: () => ({}) }));
vi.mock('@/components/ui/toast', () => ({ toastError: vi.fn(), toastSuccess: vi.fn() }));
vi.mock('@/components/ui/confirm', () => ({ confirm: vi.fn(async () => false) }));
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

const ID = 'AM01_510037_交付版';
const LOSS = '元のテンプレートより Jinja のブロック（{% if %} など）が';

function tpl(html: string): Template {
  return {
    meta: {
      id: ID,
      attributes: { companyCode: 'AM01', fundCode: '510037', baseDate: '', editionType: '交付版' },
      fileName: `${ID}.html`,
      status: 'confirmed',
      updatedAt: null,
      updatedBy: null,
    },
    html,
    css: '',
    filled: '',
  };
}

function stub(original: string, restored: string) {
  loadForPreview.mockResolvedValue(
    ok({
      template: tpl(original),
      sample: {},
      restoredHtml: restored,
      css: '',
      cssBaseline: null,
      previewDoc: '<html><body>x</body></html>',
      renderError: null,
      hasDraft: true,
      isFilled: false,
    }),
  );
}

async function submitAndReadDescription(): Promise<string> {
  const w = mount(PreviewView, {
    props: { id: ID },
    global: {
      provide: { [REPOS_KEY as symbol]: { reviews: { submitReview: vi.fn() } } },
      stubs: {
        PreviewPanel: true,
        PageRail: true,
        AttributeBar: { template: '<span />' },
        Tooltip: { template: '<span><slot /></span>' },
      },
    },
  });
  await flushPromises();
  await w
    .findAll('button')
    .find((b) => b.text().includes('確定保存'))
    ?.trigger('click');
  await flushPromises();
  const call = vi.mocked(confirm).mock.calls.at(-1)?.[0] as { description: string } | undefined;
  return call?.description ?? '';
}

const ORIGINAL = '<body>{% if a %}<p>x</p>{% endif %}{% for i in l %}<p>y</p>{% endfor %}</body>';

beforeEach(() => {
  setActivePinia(createPinia());
  sessionStorage.clear();
  loadForPreview.mockReset();
  vi.mocked(confirm).mockClear();
  for (const k of Object.keys(routeQuery)) delete routeQuery[k];
});

describe('作成経路の申請の確認', () => {
  it('ブロックが減っていれば、減った数を説明に足す', async () => {
    routeQuery.created = '1';
    stub(ORIGINAL, '<body><p>x</p><p>y</p></body>');
    const d = await submitAndReadDescription();
    expect(d).toContain(`${LOSS} 2 個少なくなっています。`);
    expect(d).toContain('意図した削除でなければ、申請せずに編集画面で確かめてください。');
  });

  it('減っていなければ足さない', async () => {
    routeQuery.created = '1';
    stub(ORIGINAL, ORIGINAL);
    expect(await submitAndReadDescription()).not.toContain(LOSS);
  });

  it('元のテンプレートの Jinja が字句として読めなければ足さない(確認は通常どおり)', async () => {
    routeQuery.created = '1';
    stub('<body>{% if a </body>', '<body></body>');
    const d = await submitAndReadDescription();
    expect(d).toContain('精査者');
    expect(d).not.toContain(LOSS);
  });

  it('編集経路では比べない', async () => {
    stub(ORIGINAL, '<body><p>x</p></body>');
    expect(await submitAndReadDescription()).not.toContain(LOSS);
  });
});
