import { err, ok, unauthorized } from '@editor/shared';
import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineComponent } from 'vue';
import { useAutosave } from '@/features/editor/useAutosave';

type Autosave = ReturnType<typeof useAutosave>;

/** Mount a host component so the composable's onUnmounted hook is active. */
function host(save: Parameters<typeof useAutosave>[0], debounceMs?: number) {
  let api!: Autosave;
  const Comp = defineComponent({
    setup() {
      api = useAutosave(save, debounceMs);
      return () => null;
    },
  });
  const wrapper = mount(Comp);
  return { api, wrapper };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('useAutosave', () => {
  it('debounces trigger() and saves once after the delay', async () => {
    vi.useFakeTimers();
    const save = vi.fn(async () => ok(undefined));
    const { api } = host(save, 800);

    api.trigger();
    expect(save).not.toHaveBeenCalled();
    expect(api.state.value).toBe('idle');

    await vi.advanceTimersByTimeAsync(800);
    expect(save).toHaveBeenCalledTimes(1);
    expect(api.state.value).toBe('saved');
    expect(api.lastSavedAt.value).toBeInstanceOf(Date);
  });

  it('resets the timer on a second trigger (only one save)', async () => {
    vi.useFakeTimers();
    const save = vi.fn(async () => ok(undefined));
    const { api } = host(save, 800);

    api.trigger();
    await vi.advanceTimersByTimeAsync(400);
    api.trigger(); // restart the debounce
    await vi.advanceTimersByTimeAsync(400); // 800 since first, but only 400 since second
    expect(save).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(400); // now 800 since the second trigger
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('flush() reports saving then saved on success', async () => {
    const save = vi.fn(async () => ok(undefined));
    const { api } = host(save);
    const p = api.flush();
    expect(api.state.value).toBe('saving');
    await p;
    expect(api.state.value).toBe('saved');
  });

  it('goes to error when the save returns Err', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const save = vi.fn(async () => err(unauthorized('だめ')));
    const { api } = host(save);
    await api.flush();
    expect(api.state.value).toBe('error');
  });

  it('goes to error when the save throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const save = vi.fn(async () => {
      throw new Error('boom');
    });
    const { api } = host(save as unknown as Parameters<typeof useAutosave>[0]);
    await api.flush();
    expect(api.state.value).toBe('error');
  });

  it('clears a pending timer on unmount', async () => {
    vi.useFakeTimers();
    const save = vi.fn(async () => ok(undefined));
    const { api, wrapper } = host(save, 800);
    api.trigger();
    wrapper.unmount();
    await vi.advanceTimersByTimeAsync(800);
    expect(save).not.toHaveBeenCalled();
  });
});
