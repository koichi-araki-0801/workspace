import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, nextTick, reactive, ref } from 'vue';
import { useUrlQuerySync } from '@/lib/useUrlQuerySync';

// vue-router を丸ごとモックして router なしでマウントする。`route.query` は hydrate の入力、
// `router.replace` は persist の出力。replace は currentRoute へ反映し, 後続マージが最新を読む。
const { routeQuery, router } = vi.hoisted(() => {
  const routeQuery: Record<string, unknown> = {};
  const router = {
    currentRoute: { value: { query: {} as Record<string, unknown> } },
    replace: vi.fn((loc: { query: Record<string, unknown> }) => {
      router.currentRoute.value.query = loc.query;
      return Promise.resolve();
    }),
  };
  return { routeQuery, router };
});
vi.mock('vue-router', () => ({
  useRoute: () => ({ query: routeQuery }),
  useRouter: () => router,
}));

beforeEach(() => {
  for (const k of Object.keys(routeQuery)) delete routeQuery[k];
  router.currentRoute.value.query = {};
  router.replace.mockClear();
});

// vue の watch(非同期 flush)→ scheduleWrite の queueMicrotask の二段を流し切る。
async function flush() {
  await nextTick();
  await Promise.resolve();
  await Promise.resolve();
}

type Q = Record<string, string | undefined>;

function mountSync(query: Q, config: Parameters<typeof useUrlQuerySync<Q>>[1]) {
  let api!: ReturnType<typeof useUrlQuerySync>;
  const Host = defineComponent({
    setup() {
      api = useUrlQuerySync(query, config);
      return () => null;
    },
  });
  mount(Host);
  return api;
}

describe('useUrlQuerySync', () => {
  it('hydrates query from the URL (no prefix)', () => {
    routeQuery.companyCode = 'C1';
    routeQuery.fundCode = 'F1';
    const query = reactive<Q>({});
    const api = mountSync(query, { keys: ['companyCode', 'fundCode', 'baseDate'] });

    expect(query.companyCode).toBe('C1');
    expect(query.fundCode).toBe('F1');
    expect(query.baseDate).toBeUndefined();
    expect(api.hydrated).toBe(true);
  });

  it('hydrates with a prefix and an extra scalar', () => {
    routeQuery.a_companyCode = 'CA';
    routeQuery.a_q = 'foo';
    const query = reactive<Q>({});
    const search = ref('');
    const api = mountSync(query, {
      keys: ['companyCode'],
      prefix: 'a',
      extra: [{ key: 'q', ref: search }],
    });

    expect(query.companyCode).toBe('CA');
    expect(search.value).toBe('foo');
    expect(api.hydrated).toBe(true);
  });

  it('reports hydrated=false when the URL has no matching keys', () => {
    const query = reactive<Q>({});
    const api = mountSync(query, { keys: ['companyCode'] });
    expect(api.hydrated).toBe(false);
  });

  it('persists changes to the URL and drops emptied keys', async () => {
    const query = reactive<Q>({});
    mountSync(query, { keys: ['companyCode', 'fundCode'], prefix: 'a' });

    query.companyCode = 'X';
    await flush();
    expect(router.replace).toHaveBeenLastCalledWith({ query: { a_companyCode: 'X' } });

    query.companyCode = undefined;
    await flush();
    expect(router.replace).toHaveBeenLastCalledWith({ query: {} });
  });

  it('merges sibling prefixes without clobbering each other', async () => {
    const a = reactive<Q>({});
    const b = reactive<Q>({});
    mountSync(a, { keys: ['companyCode'], prefix: 'a' });
    mountSync(b, { keys: ['companyCode'], prefix: 'b' });

    a.companyCode = 'AA';
    b.companyCode = 'BB';
    await flush();

    expect(router.currentRoute.value.query).toEqual({ a_companyCode: 'AA', b_companyCode: 'BB' });
  });
});
