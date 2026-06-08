import { isErr, type Result, toAppError } from '@editor/shared';
import { onUnmounted, ref } from 'vue';
import { logError } from '@/lib/appError';

export type SaveState = 'idle' | 'saving' | 'saved' | 'error';

/**
 * Always-on autosave: debounce a `Result`-returning save and expose its state.
 *
 * On failure the cause is always logged (never swallowed) and the state goes to
 * `error` — which the editor surfaces prominently (status line, retry button,
 * navigation guard), so we deliberately don't also toast on every debounced
 * failure.
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
