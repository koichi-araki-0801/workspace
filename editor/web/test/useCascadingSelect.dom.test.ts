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
