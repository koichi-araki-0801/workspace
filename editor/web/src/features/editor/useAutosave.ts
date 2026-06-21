// =============================================================================
// useAutosave.ts — 常時 autosave の composable(debounce + save state)
// =============================================================================
// 役割: `Result` を返す save 関数を debounce し、その進行状態を ref で公開する。

import { isErr, type Result, toAppError } from '@editor/shared';
import { onUnmounted, ref } from 'vue';
import { logError } from '@/lib/appError';

export type SaveState = 'idle' | 'saving' | 'saved' | 'error';

/**
 * 常時 autosave: `Result` を返す save を debounce し、その state を公開する。
 *
 * 失敗時は原因を必ず log する(握り潰さない)。state は `error` へ移り、editor が
 * 目立つ形(status line / 再試行ボタン / navigation guard)で見せるため、debounce
 * された失敗ごとに toast を重ねて出すことは敢えてしない。
 */
export function useAutosave(save: () => Promise<Result<void>>, debounceMs = 800) {
  const state = ref<SaveState>('idle');
  const lastSavedAt = ref<Date | null>(null);
  let timer: ReturnType<typeof setTimeout> | null = null;

  async function flush() {
    state.value = 'saving';
    try {
      const res = await save();
      if (isErr(res)) throw res.error;
      state.value = 'saved';
      lastSavedAt.value = new Date();
    } catch (e) {
      logError(toAppError(e));
      state.value = 'error';
    }
  }

  function trigger() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, debounceMs);
  }

  onUnmounted(() => {
    if (timer) clearTimeout(timer);
  });

  return { state, lastSavedAt, trigger, flush };
}
