// =============================================================================
// EditTabView.reportButton.dom.test.ts — 「新しい基準日で開く」ボタンの出し分け
// =============================================================================
import { err, ok, type User } from '@editor/shared';
import { flushPromises, shallowMount } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { describe, expect, it, vi } from 'vitest';
import { REPOS_KEY } from '@/api/repositories';
import EditTabView from '@/features/templates/EditTabView.vue';

vi.mock('vue-router', () => ({
  useRouter: () => ({ push: vi.fn() }),
  useRoute: () => ({ query: {} }),
}));

function mountWith(enabled: boolean | 'error', role?: User['role']) {
  const pinia = createPinia();
  if (role) {
    // auth ストアは作るときに Repositories を要るので、作る前の状態として利用者を入れる。
    pinia.state.value.auth = { user: { ...USER, role } };
  }
  const templates = {
    getReportStatus: vi.fn(async () =>
      enabled === 'error' ? err({ message: 'x' }) : ok({ enabled }),
    ),
  };
  return shallowMount(EditTabView, {
    global: {
      plugins: [pinia],
      provide: { [REPOS_KEY as symbol]: { templates, history: {} } },
    },
  });
}

const USER: User = {
  id: 'u1',
  username: 'u1',
  displayName: 'u1',
  role: 'editor',
  disabled: false,
  mustChangePassword: false,
};

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

  it('shows button for editor', async () => {
    const w = mountWith(true, 'editor');
    await flushPromises();
    expect(w.text()).toContain('新しい基準日で開く');
  });

  it('hides button for viewer even when report enabled', async () => {
    const w = mountWith(true, 'viewer');
    await flushPromises();
    expect(w.text()).not.toContain('新しい基準日で開く');
  });
});
