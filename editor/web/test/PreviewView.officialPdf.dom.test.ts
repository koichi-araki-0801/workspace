// =============================================================================
// PreviewView.officialPdf.dom.test.ts — 正式 PDF の状態の行と作り直しボタン
// =============================================================================
// 行は create_report が有効な値入り HTML のときだけ出す。ボタンは承認権限のときだけ出し、
// 押すと rebuildOfficialPdf を呼んで状態が「待ち」になる。
import { type OfficialPdfStatus, ok, type Template } from '@editor/shared';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REPOS_KEY } from '@/api/repositories';
import PreviewView from '@/features/preview/PreviewView.vue';

const h = vi.hoisted(() => ({
  loadForPreview: vi.fn(),
  auth: { ready: true, user: { role: 'editor' } as object | null, isApprover: false },
}));
vi.mock('vue-router', () => ({ useRoute: () => ({ query: {} }), useRouter: () => ({}) }));
vi.mock('@/components/ui/toast', () => ({ toastError: vi.fn(), toastSuccess: vi.fn() }));
vi.mock('@/stores/auth', () => ({ useAuthStore: () => h.auth }));
vi.mock('@/features/preview/services/templatePreviewService', async (importOriginal) => {
  const mod =
    await importOriginal<typeof import('@/features/preview/services/templatePreviewService')>();
  return {
    ...mod,
    useTemplatePreviewService: () => ({
      loadForPreview: h.loadForPreview,
      renderPdf: vi.fn(),
      recordPdfExport: vi.fn(),
    }),
  };
});

const FILLED_ID = 'XX01_950037_20240710_交付版';
const SKELETON_ID = 'XX01_950037_交付版';

const st = (
  state: OfficialPdfStatus['state'],
  extra: Partial<OfficialPdfStatus> = {},
): OfficialPdfStatus => ({ id: FILLED_ID, state, updatedAt: null, error: null, ...extra });

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

async function mountView(id: string, enabled: boolean, status: OfficialPdfStatus) {
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
      isFilled: id === FILLED_ID,
    }),
  );
  const templates = {
    getReportStatus: vi.fn(async () => ok({ enabled })),
    officialPdfStatus: vi.fn(async () => ok(status)),
    rebuildOfficialPdf: vi.fn(async () => ok(st('queued'))),
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

const rebuildButton = (w: Awaited<ReturnType<typeof mountView>>['w']) =>
  w.findAll('button').find((b) => b.text().includes('正式 PDF を作り直す'));

beforeEach(() => {
  setActivePinia(createPinia());
  h.loadForPreview.mockReset();
  h.auth.ready = true;
  h.auth.user = { role: 'editor' };
  h.auth.isApprover = false;
});
afterEach(() => {
  document.body.innerHTML = '';
});

describe('PreviewView の正式 PDF の状態', () => {
  it.each([
    ['stale', '古い'],
    ['missing', '無い'],
    ['building', '組版中'],
    ['queued', '待ち'],
  ] as const)('%s は「%s」と出す', async (state, label) => {
    const { w } = await mountView(FILLED_ID, true, st(state));
    expect(w.get('[data-testid="official-pdf-status"]').text()).toContain(label);
  });

  it('done は日時つき、failed は理由つきで出す', async () => {
    const done = await mountView(
      FILLED_ID,
      true,
      st('done', { updatedAt: '2026-11-11T01:02:03.000Z' }),
    );
    expect(done.w.get('[data-testid="official-pdf-status"]').text()).toContain('できた（');
    const failed = await mountView(FILLED_ID, true, st('failed', { error: '落ちた' }));
    expect(failed.w.get('[data-testid="official-pdf-status"]').text()).toContain('失敗（落ちた）');
  });

  it('done で日時が無ければ「できた」だけ出す', async () => {
    const { w } = await mountView(FILLED_ID, true, st('done'));
    expect(w.get('[data-testid="official-pdf-status"]').text()).toContain('できた');
  });

  it('連携が無効・値入りでない id では行ごと出さない', async () => {
    const off = await mountView(FILLED_ID, false, st('done'));
    expect(off.w.find('[data-testid="official-pdf-status"]').exists()).toBe(false);
    const skeleton = await mountView(SKELETON_ID, true, st('done'));
    expect(skeleton.w.find('[data-testid="official-pdf-status"]').exists()).toBe(false);
  });

  it('作り直しボタンは承認権限のときだけ出る', async () => {
    const editor = await mountView(FILLED_ID, true, st('done'));
    expect(rebuildButton(editor.w)).toBeUndefined();
    h.auth.isApprover = true;
    const approver = await mountView(FILLED_ID, true, st('done'));
    expect(rebuildButton(approver.w)).toBeDefined();
  });

  it('無認証モード(取得済みで利用者なし)では作り直しボタンが出る', async () => {
    h.auth.user = null;
    const { w } = await mountView(FILLED_ID, true, st('done'));
    expect(rebuildButton(w)).toBeDefined();
  });

  it('利用者の取得前は作り直しボタンを出さない', async () => {
    h.auth.ready = false;
    h.auth.user = null;
    const { w } = await mountView(FILLED_ID, true, st('done'));
    expect(rebuildButton(w)).toBeUndefined();
  });

  it('押すと rebuildOfficialPdf を呼び、状態が待ちになる', async () => {
    h.auth.isApprover = true;
    const { w, templates } = await mountView(FILLED_ID, true, st('failed', { error: 'x' }));
    templates.officialPdfStatus.mockResolvedValue(ok(st('queued')));
    await rebuildButton(w)?.trigger('click');
    await flushPromises();
    expect(templates.rebuildOfficialPdf).toHaveBeenCalledWith(FILLED_ID);
    expect(w.get('[data-testid="official-pdf-status"]').text()).toContain('待ち');
    expect(rebuildButton(w)?.attributes('disabled')).toBeDefined();
    w.unmount();
  });
});
