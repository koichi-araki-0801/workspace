// =============================================================================
// NewBaseDateDialog.dom.test.ts — 編集タブの「新しい基準日で開く」ダイアログ
// =============================================================================
// 基準日を `yyyymmdd` にして id を組み、`fillTemplate` を待ってから編集画面へ進む。失敗したら
// 画面を開かず、理由と「再試行」を出す。
import { err, ok } from '@editor/shared';
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { REPOS_KEY } from '@/api/repositories';
import NewBaseDateDialog from '@/features/templates/components/NewBaseDateDialog.vue';

const { push } = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('vue-router', () => ({ useRouter: () => ({ push }), useRoute: () => ({ query: {} }) }));

const SKELETONS = [{ companyCode: 'XX01', fundCode: '950037', editionType: '交付版' }];

function mountDialog(fillTemplate: (id: string) => Promise<unknown>) {
  const templates = {
    listReportSkeletons: vi.fn(async () => ok(SKELETONS)),
    fillTemplate: vi.fn(fillTemplate),
  };
  const w = mount(NewBaseDateDialog, {
    props: { open: true },
    attachTo: document.body,
    global: { provide: { [REPOS_KEY as symbol]: { templates } } },
  });
  return { w, templates };
}

async function chooseAndSubmit() {
  await flushPromises();
  const select = document.body.querySelector('select') as HTMLSelectElement;
  select.value = '0';
  select.dispatchEvent(new Event('change'));
  const date = document.body.querySelector('input[type="date"]') as HTMLInputElement;
  date.value = '2026-03-31';
  date.dispatchEvent(new Event('input'));
  await flushPromises();
}

function button(label: string): HTMLButtonElement | undefined {
  return [...document.body.querySelectorAll('button')].find((b) => b.textContent?.includes(label));
}

afterEach(() => {
  document.body.innerHTML = '';
  push.mockReset();
});

describe('NewBaseDateDialog', () => {
  it('builds id with yyyymmdd and navigates after fill', async () => {
    const { templates } = mountDialog(async () => ok({ created: true }));
    await chooseAndSubmit();
    button('開く')?.click();
    await flushPromises();
    expect(templates.fillTemplate).toHaveBeenCalledWith('XX01_950037_20260331_交付版');
    expect(push).toHaveBeenCalledWith({
      name: 'editor',
      params: { id: 'XX01_950037_20260331_交付版' },
    });
  });

  it('shows retry and stays when fill fails with REPORT_TIMEOUT', async () => {
    mountDialog(async () => err({ code: 'REPORT_TIMEOUT', message: 'x' }));
    await chooseAndSubmit();
    button('開く')?.click();
    await flushPromises();
    expect(document.body.textContent).toContain('時間内に作成が終わりませんでした');
    expect(button('再試行')).toBeDefined();
    expect(push).not.toHaveBeenCalled();
  });

  it('shows server message for other codes', async () => {
    mountDialog(async () => err({ code: 'OTHER', message: 'サーバの理由' }));
    await chooseAndSubmit();
    button('開く')?.click();
    await flushPromises();
    expect(document.body.textContent).toContain('サーバの理由');
  });

  it('disables open button while filling', async () => {
    let release: (v: unknown) => void = () => {};
    mountDialog(
      () =>
        new Promise((r) => {
          release = r;
        }),
    );
    await chooseAndSubmit();
    button('開く')?.click();
    await flushPromises();
    expect(document.body.textContent).toContain('値入り HTML を作成しています');
    expect(button('開く')?.disabled).toBe(true);
    release(ok({ created: true }));
    await flushPromises();
    expect(push).toHaveBeenCalled();
  });
});
