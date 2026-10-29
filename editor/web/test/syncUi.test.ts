import { describe, expect, it, vi } from 'vitest';
import { nextTick, ref } from 'vue';
import { syncUi } from '@/features/editor/syncUi';

describe('syncUi', () => {
  it('ref の変更を ui[key] へ写し、永続を 1 回呼ぶ。setup 時は発火しない', async () => {
    const ui = { zoom: 1 as number | null };
    const persistUi = vi.fn();
    const store = { ensure: () => ({ ui }), persistUi } as never;
    const zoom = ref<number | null>(1);
    syncUi(store, 't1', zoom as never, 'zoom');
    await nextTick();
    expect(persistUi).not.toHaveBeenCalled();
    zoom.value = 1.5;
    await nextTick();
    expect(ui.zoom).toBe(1.5);
    expect(persistUi).toHaveBeenCalledTimes(1);
    expect(persistUi).toHaveBeenCalledWith('t1');
  });
});
