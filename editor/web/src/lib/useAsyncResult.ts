// =============================================================================
// useAsyncResult.ts — `Result` 返却の非同期処理を共通 loading + error 処理で実行
// =============================================================================
import { err, isErr, type Result, toAppError } from '@editor/shared';
import { computed, ref } from 'vue';
import { toastError } from '@/components/ui/toast';
import { logError } from '@/lib/appError';

/**
 * `Result` を返す非同期アクションを, 共通の loading + error 処理付きで実行する。
 *
 * `Err` 時は cause をログ出力し, (安全な)`message` を toast 表示してから Result を
 * 返すため, 呼び出し側は引き続き `isOk` で分岐できる。想定外の throw は
 * `Err(AppError)` へ変換する — 決して握り潰さない。
 *
 * `loading` は参照カウント方式。同一インスタンスへの並行 `run` 呼び出し
 * (例 `Promise.all([run(...), run(...)])`)は *全て* settle して初めて idle を報告
 * する — 単一の `finally` では兄弟が pending 中に off へ倒せないため。
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
