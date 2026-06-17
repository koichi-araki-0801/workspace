import { err, isErr, type Result, toAppError } from '@editor/shared';
import { computed, ref } from 'vue';
import { toastError } from '@/components/ui/toast';
import { logError } from '@/lib/appError';

/**
 * Run a `Result`-returning async action with shared loading + error handling.
 *
 * On `Err` it logs the cause and shows the (safe) message as a toast, then
 * returns the Result so the caller still branches with `isOk`. An unexpected
 * throw is converted to an `Err(AppError)` — never swallowed.
 *
 * `loading` is reference-counted so concurrent `run` calls on the same instance
 * (e.g. `Promise.all([run(...), run(...)])`) only report idle once *all* of them
 * settle — a single `finally` can't flip it off while a sibling is still pending.
 */
export function useAsyncResult() {
  const pending = ref(0);
  const loading = computed(() => pending.value > 0);

  async function run<T>(fn: () => Promise<Result<T>>): Promise<Result<T>> {
    pending.value++;
    try {
      const res = await fn();
      if (isErr(res)) {
        logError(res.error);
        toastError(res.error.message);
      }
      return res;
    } catch (e) {
      const ae = toAppError(e);
      logError(ae);
      toastError(ae.message);
      return err(ae);
    } finally {
      pending.value--;
    }
  }

  return { loading, run };
}
