import { err, isErr, type Result, toAppError } from '@editor/shared';
import { ref } from 'vue';
import { toastError } from '@/components/ui/toast';
import { logError } from '@/lib/appError';

/**
 * Run a `Result`-returning async action with shared loading + error handling.
 *
 * On `Err` it logs the cause and shows the (safe) message as a toast, then
 * returns the Result so the caller still branches with `isOk`. An unexpected
 * throw is converted to an `Err(AppError)` — never swallowed.
 */
export function useAsyncResult() {
  const loading = ref(false);

  async function run<T>(fn: () => Promise<Result<T>>): Promise<Result<T>> {
    loading.value = true;
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
      loading.value = false;
    }
  }

  return { loading, run };
}
