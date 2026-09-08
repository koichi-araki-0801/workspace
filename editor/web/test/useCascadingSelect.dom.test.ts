import { err, ok, unauthorized } from '@editor/shared';
import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineComponent } from 'vue';
import { useCascadingSelect } from '@/lib/useCascadingSelect';

afterEach(() => vi.restoreAllMocks());

interface Query {
  region?: string;
  country?: string;
  city?: string;
}
interface Options {
  items: string[];
}

describe('useCascadingSelect', () => {
  it('refresh fetches options and the optional list', async () => {
    const fetchOptions = vi.fn().mockResolvedValue(ok({ items: ['x'] }));
    const fetchList = vi.fn().mockResolvedValue(ok([1, 2, 3]));
    const cs = useCascadingSelect<Query, Options, number>({
      levels: ['region', 'country', 'city'],
      emptyOptions: { items: [] },
      fetchOptions,
      fetchList,
      immediate: false,
    });

    await cs.refresh();

    expect(fetchOptions).toHaveBeenCalledTimes(1);
    expect(cs.options.value.items).toEqual(['x']);
    expect(cs.list.value).toEqual([1, 2, 3]);
    expect(cs.loading.value).toBe(false);
  });

  it('selecting a level clears every lower level then refetches', async () => {
    const fetchOptions = vi.fn().mockResolvedValue(ok({ items: [] }));
    const onChange = vi.fn();
    const cs = useCascadingSelect<Query, Options>({
      levels: ['region', 'country', 'city'],
      emptyOptions: { items: [] },
      fetchOptions,
      onChange,
      immediate: false,
    });

    cs.query.region = 'asia';
    cs.query.country = 'jp';
    cs.query.city = 'tokyo';

    cs.onLevelChange('region');

    expect(cs.query.region).toBe('asia');
    expect(cs.query.country).toBeUndefined();
    expect(cs.query.city).toBeUndefined();
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ region: 'asia' }));
    await vi.waitFor(() => expect(fetchOptions).toHaveBeenCalled());
  });

  it('reset clears every level', () => {
    const fetchOptions = vi.fn().mockResolvedValue(ok({ items: [] }));
    const onChange = vi.fn();
    const cs = useCascadingSelect<Query, Options>({
      levels: ['region', 'country'],
      emptyOptions: { items: [] },
      fetchOptions,
      onChange,
      immediate: false,
    });

    cs.query.region = 'asia';
    cs.query.country = 'jp';
    cs.reset();

    expect(cs.query.region).toBeUndefined();
    expect(cs.query.country).toBeUndefined();
    expect(onChange).toHaveBeenCalled();
  });

  it('keeps the current options on a fetch error (does not swallow)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchOptions = vi.fn().mockResolvedValue(err(unauthorized('denied')));
    const cs = useCascadingSelect<Query, Options>({
      levels: ['region'],
      emptyOptions: { items: ['initial'] },
      fetchOptions,
      immediate: false,
    });

    await cs.refresh();

    expect(cs.options.value.items).toEqual(['initial']);
  });

  it('後着の旧世代応答は options に反映されない(世代ガード)', async () => {
    let release!: () => void;
    const first = new Promise<void>((r) => {
      release = r;
    });
    const fetchOptions = vi
      .fn()
      .mockImplementationOnce(async () => {
        await first;
        return ok({ items: ['old'] });
      })
      .mockResolvedValueOnce(ok({ items: ['new'] }));
    const cs = useCascadingSelect<Query, Options>({
      levels: ['region'],
      emptyOptions: { items: [] },
      fetchOptions,
      immediate: false,
    });

    const p1 = cs.refresh();
    await cs.refresh();
    release();
    await p1;

    expect(cs.options.value.items).toEqual(['new']);
  });

  it('list の取得中に次の refresh が始まったら、後から返った list は捨てる', async () => {
    // 世代ガードは options の直後と list の直後の 2 箇所にある。後者を踏むには、旧世代が
    // options の判定を通り抜けて list 取得へ入ってから次の refresh を始める必要がある。
    let releaseList!: () => void;
    const firstList = new Promise<void>((r) => {
      releaseList = r;
    });
    let markListEntered!: () => void;
    const listEntered = new Promise<void>((r) => {
      markListEntered = r;
    });
    const fetchOptions = vi.fn().mockResolvedValue(ok({ items: [] }));
    const fetchList = vi
      .fn()
      .mockImplementationOnce(async () => {
        markListEntered();
        await firstList;
        return ok([1, 1, 1]);
      })
      .mockResolvedValueOnce(ok([2, 2]));
    const cs = useCascadingSelect<Query, Options, number>({
      levels: ['region'],
      emptyOptions: { items: [] },
      fetchOptions,
      fetchList,
      immediate: false,
    });

    const p1 = cs.refresh();
    await listEntered;
    await cs.refresh();
    releaseList();
    await p1;

    // 後から返った旧世代の list は捨てられ、新世代の値が残る。
    expect(cs.list.value).toEqual([2, 2]);
    expect(fetchList).toHaveBeenCalledTimes(2);
  });

  it('fetchList の失敗は list を更新しない(options は成功分を反映する)', async () => {
    // useCascadingSelect は `error` を公開しない(loading のみ)。観測できるのは
    // options/list の状態だけなので、そこで失敗が反映されなかったことを主張する。
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const cs = useCascadingSelect<Query, Options, number>({
      levels: ['region'],
      emptyOptions: { items: [] },
      fetchOptions: vi.fn().mockResolvedValue(ok({ items: ['ok'] })),
      fetchList: vi.fn().mockResolvedValue(err(unauthorized('x'))),
      immediate: false,
    });

    await cs.refresh();

    expect(cs.options.value.items).toEqual(['ok']);
    expect(cs.list.value).toEqual([]);
  });

  it('refreshes on mount when immediate is the default', async () => {
    const fetchOptions = vi.fn().mockResolvedValue(ok({ items: ['mounted'] }));
    let cs!: ReturnType<typeof useCascadingSelect<Query, Options>>;
    const Host = defineComponent({
      setup() {
        cs = useCascadingSelect<Query, Options>({
          levels: ['region'],
          emptyOptions: { items: [] },
          fetchOptions,
        });
        return () => null;
      },
    });

    mount(Host);

    await vi.waitFor(() => expect(fetchOptions).toHaveBeenCalledTimes(1));
    expect(cs.options.value.items).toEqual(['mounted']);
  });
});
