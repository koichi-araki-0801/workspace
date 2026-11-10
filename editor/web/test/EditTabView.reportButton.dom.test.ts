// =============================================================================
// EditTabView.reportButton.dom.test.ts — 「新しい基準日で開く」ボタンの出し分け
// =============================================================================
import { err, ok } from '@editor/shared';
import { flushPromises, shallowMount } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { describe, expect, it, vi } from 'vitest';
import { REPOS_KEY } from '@/api/repositories';
import EditTabView from '@/features/templates/EditTabView.vue';

vi.mock('vue-router', () => ({
  useRouter: () => ({ push: vi.fn() }),
  useRoute: () => ({ query: {} }),
}));

function mountWith(enabled: boolean | 'error') {
  const templates = {
    getReportStatus: vi.fn(async () =>
      enabled === 'error' ? err({ message: 'x' }) : ok({ enabled }),
    ),
  };
  return shallowMount(EditTabView, {
    global: {
      plugins: [createPinia()],
      provide: { [REPOS_KEY as symbol]: { templates, history: {} } },
    },
  });
}

describe('EditTabView report button', () => {
  it('hides button when report disabled', async () => {
    const w = mountWith(false);
    await flushPromises();
    expect(w.text()).not.toContain('新しい基準日で開く');
  });

  it('hides button when status lookup fails', async () => {
    const w = mountWith('error');
    await flushPromises();
    expect(w.text()).not.toContain('新しい基準日で開く');
  });

  it('shows button when report enabled', async () => {
    const w = mountWith(true);
    await flushPromises();
    expect(w.text()).toContain('新しい基準日で開く');
  });
});
