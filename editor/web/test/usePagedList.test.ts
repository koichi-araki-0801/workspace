import { describe, expect, it } from 'vitest';
import { nextTick, ref } from 'vue';
import { usePagedList } from '../src/lib/usePagedList';

const range = (n: number) => Array.from({ length: n }, (_, i) => i);

describe('usePagedList', () => {
  it('reveals only the first page initially', () => {
    const source = ref(range(120));
    const paged = usePagedList(source, 50);
    expect(paged.visible).toHaveLength(50);
    expect(paged.hasMore).toBe(true);
    expect(paged.remaining).toBe(70);
  });

  it('loadMore() grows the visible window by one page until exhausted', () => {
    const source = ref(range(120));
    const paged = usePagedList(source, 50);

    paged.loadMore();
    expect(paged.visible).toHaveLength(100);
    expect(paged.remaining).toBe(20);
    expect(paged.hasMore).toBe(true);

    paged.loadMore();
    expect(paged.visible).toHaveLength(120);
    expect(paged.remaining).toBe(0);
    expect(paged.hasMore).toBe(false);
  });

  it('does not paginate when the source fits in one page', () => {
    const source = ref(range(10));
    const paged = usePagedList(source, 50);
    expect(paged.visible).toHaveLength(10);
    expect(paged.hasMore).toBe(false);
    expect(paged.remaining).toBe(0);
  });

  it('resets the window to the top when the source changes (e.g. a filter)', async () => {
    const source = ref(range(120));
    const paged = usePagedList(source, 50);
    paged.loadMore(); // window grown to 100
    expect(paged.visible).toHaveLength(100);

    source.value = range(8);
    await nextTick();

    expect(paged.visible).toHaveLength(8);
    expect(paged.hasMore).toBe(false);
  });
});
