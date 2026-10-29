// =============================================================================
// useAsyncResult.ts — `Result` 返却の非同期処理を共通 loading + error 処理で実行
// =============================================================================
import { type AppError, err, isErr, type Result, toAppError } from '@editor/shared';
import { computed, ref } from 'vue';
import { toastError } from '@/components/ui/toast';
import { logError } from '@/lib/appError';

interface RunOptions {
  /**
   * トーストを出さない `code`。呼び出し側がその失敗を自分の文言で知らせるとき(読み直して
   * 「すでに処理されています」と出すなど)に渡し、サーバの文言と二重に出さない。ログは残す。
   */
  quietCodes?: readonly string[];
  /** トーストに出す文言の読み替え(サーバの文言の識別子を利用者の言葉にするなど)。ログは原文。 */
  describe?: (message: string) => string;
}

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

  async function run<T>(fn: () => Promise<Result<T>>, opts: RunOptions = {}): Promise<Result<T>> {
    const report = (e: AppError) => {
      logError(e);
      if (e.code === undefined || !opts.quietCodes?.includes(e.code)) {
        toastError(opts.describe ? opts.describe(e.message) : e.message);
      }
    };
    pending.value++;
    try {
      const res = await fn();
      if (isErr(res)) report(res.error);
      return res;
    } catch (e) {
      const ae = toAppError(e);
      report(ae);
      return err(ae);
    } finally {
      pending.value--;
    }
  }

  return { loading, run };
}
