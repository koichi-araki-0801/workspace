// =============================================================================
// EditTabView.createOpen.dom.test.ts — 編集タブの 0 件時の空表示と「作成して開く」
// =============================================================================
// 4 段そろいで検索して 0 件、かつ連携が有効で編集者(または無認証)のときだけ、一覧の代わりに
// 空表示と「作成して開く」を出す。押すと検索した時点の 4 段で id を組み、`fillTemplate` を
// 待ってから編集経路で開く。
import { type DropdownQuery, err, ok, type TemplateMeta, type User } from '@editor/shared';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineComponent } from 'vue';
import { REPOS_KEY } from '@/api/repositories';
import EditTabView from '@/features/templates/EditTabView.vue';

const { push } = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('vue-router', () => ({
  useRouter: () => ({ push }),
  useRoute: () => ({ query: {} }),
}));

const SearchFiltersStub = defineComponent({
  name: 'SearchFilters',
  props: {
    dropdownScope: { type: String, default: undefined },
    newBaseDate: { type: String, default: undefined },
    unknownDateText: { type: String, default: undefined },
  },
  emits: ['search', 'restore', 'update'],
  template: '<div />',
});

const FULL: DropdownQuery = {
  companyCode: 'XX01',
  fundCode: '910024',
  baseDate: '20261110',
  editionType: '交付版',
};
const ID = 'XX01_910024_20261110_交付版';

const USER: User = {
  id: 'u1',
  username: 'u1',
  displayName: 'u1',
  role: 'editor',
  disabled: false,
  mustChangePassword: false,
};

type Fill = (id: string) => Promise<unknown>;

interface MountOpts {
  enabled?: boolean | 'error';
  role?: User['role'];
  rows?: TemplateMeta[];
  fill?: Fill;
  /** 利用者の取得が済んだか。既定は済み。 */
  ready?: boolean;
}

function mountWith(opts: MountOpts = {}) {
  const {
    enabled = true,
    role,
    rows = [],
    fill = async () => ok({ created: true }),
    ready = true,
  } = opts;
  const pinia = createPinia();
  // auth ストアは作るときに Repositories を要るので、作る前の状態として利用者と準備状態を入れる。
  // 利用者が居ない(`role` 省略)のは無認証モード。
  pinia.state.value.auth = { ready, user: role ? { ...USER, role } : null };
  const templates = {
    getReportStatus: vi.fn(async () =>
      enabled === 'error' ? err({ message: 'x' }) : ok({ enabled }),
    ),
    listTemplates: vi.fn(async () => ok(rows)),
    fillTemplate: vi.fn(fill),
  };
  const history = { listVersions: vi.fn(async () => ok([])) };
  const w = mount(EditTabView, {
    global: {
      plugins: [pinia],
      provide: { [REPOS_KEY as symbol]: { templates, history } },
      stubs: { SearchFilters: SearchFiltersStub, TemplateTable: true },
    },
  });
  return { w, templates, pinia };
}

function filters(w: ReturnType<typeof mountWith>['w']) {
  return w.findComponent(SearchFiltersStub);
}

async function searchWith(w: ReturnType<typeof mountWith>['w'], q: DropdownQuery = FULL) {
  await flushPromises();
  filters(w).vm.$emit('search', { ...q });
  await flushPromises();
}

function createButton(w: ReturnType<typeof mountWith>['w']) {
  return w.findAll('button').find((b) => /作成して開く|再試行/.test(b.text()));
}

const EMPTY_TEXT = 'この基準日の帳票はまだありません';

afterEach(() => {
  push.mockReset();
});

describe('EditTabView create and open', () => {
  it('shows create button only when enabled and editor', async () => {
    const shown: [MountOpts, boolean][] = [
      [{ enabled: true, role: 'editor' }, true],
      [{ enabled: true }, true],
      [{ enabled: true, role: 'viewer' }, false],
      [{ enabled: false, role: 'editor' }, false],
      [{ enabled: 'error', role: 'editor' }, false],
    ];
    for (const [opts, expected] of shown) {
      const { w } = mountWith(opts);
      await searchWith(w);
      expect(w.text().includes(EMPTY_TEXT)).toBe(expected);
      expect(createButton(w) !== undefined).toBe(expected);
      w.unmount();
    }

    // 4 段がそろっていなければ id を組めないので出さない。
    const { w } = mountWith({ enabled: true, role: 'editor' });
    await searchWith(w, { companyCode: 'XX01', fundCode: '910024', baseDate: '20261110' });
    expect(w.text()).not.toContain(EMPTY_TEXT);
  });

  it('not shown with rows', async () => {
    const rows = [{ id: ID } as TemplateMeta];
    const { w } = mountWith({ role: 'editor', rows });
    await searchWith(w);
    expect(w.text()).not.toContain(EMPTY_TEXT);
    expect(createButton(w)).toBeUndefined();
  });

  it('fills and opens', async () => {
    let release: (v: unknown) => void = () => {};
    const { w, templates } = mountWith({
      role: 'editor',
      fill: () =>
        new Promise((r) => {
          release = r;
        }),
    });
    await searchWith(w);
    await createButton(w)?.trigger('click');
    await flushPromises();
    expect(templates.fillTemplate).toHaveBeenCalledWith(ID);
    expect(w.text()).toContain('値入り HTML を作成しています');
    expect(createButton(w)?.attributes('disabled')).toBeDefined();

    release(ok({ created: true }));
    await flushPromises();
    expect(push).toHaveBeenCalledWith({ name: 'editor', params: { id: ID } });
  });

  it('builds id with digits-only base date', async () => {
    // 既存の値入り HTML がハイフン表記の基準日でも、server は 8 桁の数字だけを基準日として読む。
    const { w, templates } = mountWith({ role: 'editor' });
    await searchWith(w, { ...FULL, baseDate: '2024-05-17', editionType: '全体版' });
    await createButton(w)?.trigger('click');
    await flushPromises();
    expect(templates.fillTemplate).toHaveBeenCalledWith('XX01_910024_20240517_全体版');
  });

  it('shows failure text and retries', async () => {
    const cases: [string, string][] = [
      ['GENERATE_QUEUE_FULL', '作成処理が混み合っています。しばらくしてから再試行してください'],
      ['REPORT_TIMEOUT', '時間内に作成が終わりませんでした'],
      ['REPORT_COMPANY_UNKNOWN', '委託会社コードが見つかりません'],
      ['OTHER', 'サーバの理由'],
    ];
    for (const [code, text] of cases) {
      const { w, templates } = mountWith({
        role: 'editor',
        fill: async () => err({ code, message: 'サーバの理由' }),
      });
      await searchWith(w);
      await createButton(w)?.trigger('click');
      await flushPromises();
      expect(w.text()).toContain(text);
      expect(createButton(w)?.text()).toContain('再試行');
      expect(push).not.toHaveBeenCalled();

      await createButton(w)?.trigger('click');
      await flushPromises();
      expect(templates.fillTemplate).toHaveBeenCalledTimes(2);
      w.unmount();
    }
  });

  it('ignores stale fill result', async () => {
    let release: (v: unknown) => void = () => {};
    const { w, templates } = mountWith({
      role: 'editor',
      fill: () =>
        new Promise((r) => {
          release = r;
        }),
    });
    await searchWith(w);
    await createButton(w)?.trigger('click');
    expect(templates.fillTemplate).toHaveBeenCalledWith(ID);
    filters(w).vm.$emit('update', { ...FULL, editionType: '全体版' });
    await flushPromises();

    release(ok({ created: true }));
    await flushPromises();
    expect(push).not.toHaveBeenCalled();
  });

  it('clears on query change', async () => {
    const { w } = mountWith({
      role: 'editor',
      fill: async () => err({ code: 'REPORT_TIMEOUT', message: 'x' }),
    });
    await searchWith(w);
    await createButton(w)?.trigger('click');
    await flushPromises();
    expect(w.text()).toContain('時間内に作成が終わりませんでした');

    filters(w).vm.$emit('update', { ...FULL, baseDate: '20261111' });
    await flushPromises();
    expect(w.text()).not.toContain(EMPTY_TEXT);
    expect(w.text()).not.toContain('時間内に作成が終わりませんでした');
    expect(createButton(w)).toBeUndefined();
  });

  it('drops create for a search whose query changed before the list arrived', async () => {
    const { w } = mountWith({ role: 'editor' });
    await flushPromises();
    filters(w).vm.$emit('search', { ...FULL });
    filters(w).vm.$emit('update', { ...FULL, editionType: '全体版' });
    await flushPromises();
    expect(w.text()).not.toContain(EMPTY_TEXT);

    // 同じ組み立てで条件が変わらなければ空表示が出る(上の否定が空振りでないことの確認)。
    filters(w).vm.$emit('search', { ...FULL });
    await flushPromises();
    expect(w.text()).toContain(EMPTY_TEXT);
  });

  it('no auto fill on restore', async () => {
    const { w, templates } = mountWith({ role: 'editor' });
    await flushPromises();
    filters(w).vm.$emit('restore', { ...FULL });
    await flushPromises();
    expect(templates.listTemplates).toHaveBeenCalled();
    expect(w.text()).toContain(EMPTY_TEXT);
    expect(templates.fillTemplate).not.toHaveBeenCalled();
  });

  it('opens editor and review from rows', async () => {
    const row = { id: ID, status: 'published' } as TemplateMeta;
    const { w } = mountWith({ role: 'editor', rows: [row] });
    await searchWith(w);
    const table = w.findComponent({ name: 'TemplateTable' });
    table.vm.$emit('action', row);
    table.vm.$emit('open-review', row);
    expect(push).toHaveBeenNthCalledWith(1, { name: 'editor', params: { id: ID } });
    expect(push).toHaveBeenNthCalledWith(2, { name: 'reviews', query: { template: ID } });
  });

  it('waits for status and user before rendering filters', async () => {
    // 状態の応答前に検索欄を描くと、`reject` のまま URL の新しい基準日を止めてしまう。
    let answer: (v: unknown) => void = () => {};
    const pinia = createPinia();
    pinia.state.value.auth = { ready: true, user: { ...USER } };
    const templates = {
      getReportStatus: vi.fn(
        () =>
          new Promise((r) => {
            answer = r;
          }),
      ),
      listTemplates: vi.fn(async () => ok([])),
      fillTemplate: vi.fn(async () => ok({ created: true })),
    };
    const history = { listVersions: vi.fn(async () => ok([])) };
    const w = mount(EditTabView, {
      global: {
        plugins: [pinia],
        provide: { [REPOS_KEY as symbol]: { templates, history } },
        stubs: { SearchFilters: SearchFiltersStub, TemplateTable: true },
      },
    });
    await flushPromises();
    expect(filters(w).exists()).toBe(false);

    answer(ok({ enabled: true }));
    await flushPromises();
    expect(filters(w).props('newBaseDate')).toBe('allow');
    filters(w).vm.$emit('restore', { ...FULL });
    await flushPromises();
    expect(w.text()).toContain(EMPTY_TEXT);
  });

  it('waits for user ready before rendering filters', async () => {
    // 利用者の取得中は閲覧者かどうか分からないので、検索欄も空表示もまだ出さない。
    const { w, pinia } = mountWith({ role: 'editor', ready: false });
    await flushPromises();
    expect(filters(w).exists()).toBe(false);
    expect(w.text()).not.toContain(EMPTY_TEXT);

    pinia.state.value.auth.ready = true;
    await flushPromises();
    expect(filters(w).props('newBaseDate')).toBe('allow');
  });

  it('renders filters as reject when status fails', async () => {
    const { w } = mountWith({ enabled: 'error', role: 'editor' });
    await flushPromises();
    expect(filters(w).props('newBaseDate')).toBe('reject');
  });

  it('passes newBaseDate', async () => {
    const allowed = mountWith({ enabled: true, role: 'editor' }).w;
    await flushPromises();
    expect(filters(allowed).props('newBaseDate')).toBe('allow');

    for (const opts of [
      { enabled: true, role: 'viewer' },
      { enabled: false, role: 'editor' },
    ] satisfies MountOpts[]) {
      const { w } = mountWith(opts);
      await flushPromises();
      expect(filters(w).props('newBaseDate')).toBe('reject');
      expect(filters(w).props('unknownDateText')).toBe('この基準日のテンプレートはありません');
      w.unmount();
    }
  });
});
