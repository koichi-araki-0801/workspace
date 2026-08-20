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
    api.trigger();
    const p = api.flush();
    expect(api.state.value).toBe('saving');
    await p;
    expect(api.state.value).toBe('saved');
  });

  it('goes to error when the save returns Err', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const save = vi.fn(async () => err(unauthorized('だめ')));
    const { api } = host(save);
    api.trigger();
    await api.flush();
    expect(api.state.value).toBe('error');
  });

  it('goes to error when the save throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const save = vi.fn(async () => {
      throw new Error('boom');
    });
    const { api } = host(save as unknown as Parameters<typeof useAutosave>[0]);
    api.trigger();
    await api.flush();
    expect(api.state.value).toBe('error');
  });

  it('pending is true while debouncing and false after the flush', async () => {
    vi.useFakeTimers();
    const save = vi.fn(async () => ok(undefined));
    const { api } = host(save, 800);

    expect(api.pending.value).toBe(false);
    api.trigger();
    expect(api.pending.value).toBe(true); // beforeunload 警告の対象になる窓
    await vi.advanceTimersByTimeAsync(800);
    expect(api.pending.value).toBe(false);
  });

  it('a manual flush() settles the pending debounce without a duplicate save', async () => {
    vi.useFakeTimers();
    const save = vi.fn(async () => ok(undefined));
    const { api } = host(save, 800);

    api.trigger();
    await api.flush();
    expect(api.pending.value).toBe(false);
    await vi.advanceTimersByTimeAsync(800); // 元の debounce 予定時刻を過ぎても再保存しない
    expect(save).toHaveBeenCalledTimes(1);
  });

  // 未編集で編集画面を離れる(プレビュー/精査への遷移)たびに保存が走ると、何も編集して
  // いないのに draft が生成される。保存すべき変更が無い flush は何もしない。
  it('flush() は保存すべき変更が無ければ save を呼ばない', async () => {
    const save = vi.fn(async () => ok(undefined));
    const { api } = host(save);
    await api.flush();
    expect(save).not.toHaveBeenCalled();
    expect(api.state.value).toBe('idle');
  });

  it('flush() は保存完了後に再度呼んでも save を重ねない', async () => {
    vi.useFakeTimers();
    const save = vi.fn(async () => ok(undefined));
    const { api } = host(save, 800);
    api.trigger();
    await vi.advanceTimersByTimeAsync(800);
    expect(save).toHaveBeenCalledTimes(1);

    await api.flush(); // 以後の編集が無いので何もしない
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('保存後に再編集すれば flush() は再び保存する', async () => {
    const save = vi.fn(async () => ok(undefined));
    const { api } = host(save, 800);
    api.trigger();
    await api.flush();
    api.trigger();
    await api.flush();
    expect(save).toHaveBeenCalledTimes(2);
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
