import { err, ok, type Result, unauthorized } from '@editor/shared';
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

/** 外から解決する Promise。保存の途中に別の出来事を挟むために使う。 */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
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

  // draft 破棄と autosave の競合: 破棄の直前に予約済み debounce が発火すると、破棄した
  // はずの draft がすぐ書き戻る。破棄側は `cancel` で予約を捨て `settled` で進行中を待つ。
  it('cancel() は予約中の debounce を捨てて save を飛ばさない', async () => {
    vi.useFakeTimers();
    const save = vi.fn(async () => ok(undefined));
    const { api } = host(save, 800);

    api.trigger();
    api.cancel();
    expect(api.pending.value).toBe(false);
    await vi.advanceTimersByTimeAsync(800);
    expect(save).not.toHaveBeenCalled();
  });

  it('cancel() の後の flush() も保存しない', async () => {
    const save = vi.fn(async () => ok(undefined));
    const { api } = host(save, 800);
    api.trigger();
    api.cancel();
    await api.flush();
    expect(save).not.toHaveBeenCalled();
  });

  it('flush() の並行呼び出しは同じ保存 1 回に合流する', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const save = vi.fn(async () => {
      await gate;
      return ok(undefined);
    });
    const { api } = host(save, 800);

    api.trigger();
    const a = api.flush();
    const b = api.flush();
    expect(save).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([a, b]);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('settled() は進行中の保存の完了を待つ(保存中でなければ即時解決)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const save = vi.fn(async () => {
      await gate;
      return ok(undefined);
    });
    const { api } = host(save, 800);

    await api.settled(); // 保存中でない
    api.trigger();
    const p = api.flush();
    let done = false;
    const waited = api.settled().then(() => {
      done = true;
    });
    await Promise.resolve();
    expect(done).toBe(false);
    release();
    await Promise.all([p, waited]);
    expect(done).toBe(true);
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

  it('タイマー待機中の flush は待たずに保存し、タイマーは 1 度しか発火しない', async () => {
    vi.useFakeTimers();
    const save = vi.fn(async () => ok(undefined));
    const { api } = host(save, 800);
    api.trigger();
    await api.flush();
    await vi.advanceTimersByTimeAsync(800);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('タイマー待機中の cancel と unmount は予約を捨てる', async () => {
    vi.useFakeTimers();
    const save = vi.fn(async () => ok(undefined));
    const a = host(save, 800);
    a.api.trigger();
    a.api.cancel();
    const b = host(save, 800);
    b.api.trigger();
    b.wrapper.unmount();
    await vi.advanceTimersByTimeAsync(800);
    expect(save).not.toHaveBeenCalled();
  });

  it('trigger() 前の cancel() / unmount は保存を起こさない', async () => {
    vi.useFakeTimers();
    const save = vi.fn(async () => ok(undefined));
    const a = host(save, 800);
    a.api.cancel();
    const b = host(save, 800);
    b.wrapper.unmount();
    // 予約が無い状態で cancel / unmount しても、待ち時間を進めて保存が起きないことまで見る
    // (例外が出ないことだけでは、誤って保存を走らせる実装を捕まえられない)。
    await vi.advanceTimersByTimeAsync(1600);
    expect(save).not.toHaveBeenCalled();
  });
  it('保存中に来た変更は完了後に保存し直し、その間の flush はそこまで待つ', async () => {
    vi.useFakeTimers();
    const d1 = deferred<Result<void>>();
    const save = vi
      .fn<() => Promise<Result<void>>>()
      .mockReturnValueOnce(d1.promise)
      .mockResolvedValue(ok(undefined));
    const { api } = host(save, 800);

    api.trigger();
    await vi.advanceTimersByTimeAsync(800); // 1 回目の保存開始
    expect(save).toHaveBeenCalledTimes(1);
    api.trigger(); // 保存中の変更
    expect(api.state.value).toBe('saving');
    const f = api.flush();
    d1.resolve(ok(undefined));
    await expect(f).resolves.toBe(true);
    expect(save).toHaveBeenCalledTimes(2);
    expect(api.state.value).toBe('saved');
    expect(api.pending.value).toBe(false);
  });

  it('保存中の変更のタイマーが保存中に切れても、変更は失われない', async () => {
    vi.useFakeTimers();
    const d1 = deferred<Result<void>>();
    const save = vi
      .fn<() => Promise<Result<void>>>()
      .mockReturnValueOnce(d1.promise)
      .mockResolvedValue(ok(undefined));
    const { api } = host(save, 800);

    api.trigger();
    await vi.advanceTimersByTimeAsync(800);
    api.trigger();
    await vi.advanceTimersByTimeAsync(800); // 保存中にタイマーが切れる(保存は重ねない)
    expect(save).toHaveBeenCalledTimes(1);
    d1.resolve(ok(undefined));
    await api.settled();
    expect(save).toHaveBeenCalledTimes(2);
    expect(api.state.value).toBe('saved');
    await vi.advanceTimersByTimeAsync(1600); // 残ったタイマーで 3 回目が走らない
    expect(save).toHaveBeenCalledTimes(2);
  });

  it('失敗したら flush は false を返し、再度の flush(再試行)で保存し直す', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const save = vi
      .fn<() => Promise<Result<void>>>()
      .mockResolvedValueOnce(err(unauthorized('だめ')))
      .mockResolvedValue(ok(undefined));
    const { api } = host(save, 800);

    api.trigger();
    await expect(api.flush()).resolves.toBe(false);
    expect(api.state.value).toBe('error');
    await expect(api.flush()).resolves.toBe(true);
    expect(save).toHaveBeenCalledTimes(2);
    expect(api.state.value).toBe('saved');
  });

  it('保存済みのあとに編集すると saved から idle へ下ろす。error は下ろさない', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const ok1 = host(
      vi.fn(async () => ok(undefined)),
      800,
    ).api;
    ok1.trigger();
    await ok1.flush();
    expect(ok1.state.value).toBe('saved');
    ok1.trigger();
    expect(ok1.state.value).toBe('idle');

    const ng = host(
      vi.fn(async () => err(unauthorized('だめ'))),
      800,
    ).api;
    ng.trigger();
    await ng.flush();
    expect(ng.state.value).toBe('error');
    ng.trigger();
    expect(ng.state.value).toBe('error');
  });

  it('flush は保存するものが無ければ true を返す', async () => {
    const save = vi.fn(async () => ok(undefined));
    const { api } = host(save, 800);
    await expect(api.flush()).resolves.toBe(true);
    expect(save).not.toHaveBeenCalled();
  });

  it('cancel は実行中の保存を止めないが、次の周回をさせない', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const d1 = deferred<Result<void>>();
    const save = vi
      .fn<() => Promise<Result<void>>>()
      .mockReturnValueOnce(d1.promise)
      .mockResolvedValue(ok(undefined));
    const { api } = host(save, 800);

    api.trigger();
    const f = api.flush();
    api.trigger();
    api.cancel();
    d1.resolve(ok(undefined));
    await expect(f).resolves.toBe(true);
    expect(save).toHaveBeenCalledTimes(1);

    // 失敗した保存の途中で cancel したら、破棄した変更を再試行の対象へ戻さない。
    const d2 = deferred<Result<void>>();
    const save2 = vi.fn<() => Promise<Result<void>>>().mockReturnValueOnce(d2.promise);
    const b = host(save2, 800).api;
    b.trigger();
    const g = b.flush();
    b.cancel();
    d2.resolve(err(unauthorized('だめ')));
    await expect(g).resolves.toBe(false);
    await expect(b.flush()).resolves.toBe(true);
    expect(save2).toHaveBeenCalledTimes(1);
  });

  it('settled は保存し直しまで含めて待つ', async () => {
    const d1 = deferred<Result<void>>();
    const d2 = deferred<Result<void>>();
    const save = vi
      .fn<() => Promise<Result<void>>>()
      .mockReturnValueOnce(d1.promise)
      .mockReturnValueOnce(d2.promise);
    const { api } = host(save, 800);

    api.trigger();
    void api.flush();
    api.trigger();
    let done = false;
    const waited = api.settled().then(() => {
      done = true;
    });
    d1.resolve(ok(undefined));
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(done).toBe(false);
    d2.resolve(ok(undefined));
    await waited;
    expect(done).toBe(true);
  });
});
