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
 * された失敗ごとに toast を重ねて出すことは敢えてしない(画面側が error への遷移
 * エッジで 1 回だけ toast する — `useTemplateEditor.ts` を見よ)。
 */
export function useAutosave(save: () => Promise<Result<void>>, debounceMs = 800) {
  const state = ref<SaveState>('idle');
  const lastSavedAt = ref<Date | null>(null);
  // debounce 待機中(trigger 済み・未 flush)か。この窓の間はまだ何も保存されておらず、
  // タブを閉じると直近の編集が失われるため、beforeunload 警告の判定に使う
  // (state は待機中も 'idle'/'saved' のままなので state だけでは検知できない)。
  const pending = ref(false);
  let timer: ReturnType<typeof setTimeout> | null = null;
  // 前回の保存開始以降に `trigger` が来たか(= 保存すべき変更があるか)。
  let unsaved = false;
  // 進行中の保存。並行呼び出しの合流点であり、`settled` が待つ対象でもある。
  let inFlight: Promise<void> | null = null;

  async function flush(): Promise<void> {
    // 進行中の保存があれば同じ Promise を返す(手動 flush と debounce 発火の二重保存を防ぐ)。
    if (inFlight) return inFlight;
    // 保存すべき変更が無い flush は何もしない。手動 flush は画面遷移のたびに呼ばれるため、
    // 素通しすると何も編集していないのに draft が生成される。
    if (!pending.value && !unsaved) return;
    // 待機中のタイマーはここで確定させる。
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    pending.value = false;
    unsaved = false;
    state.value = 'saving';
    inFlight = (async () => {
      try {
        const res = await save();
        if (isErr(res)) throw res.error;
        state.value = 'saved';
        lastSavedAt.value = new Date();
      } catch (e) {
        logError(toAppError(e));
        state.value = 'error';
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  }

  /**
   * 予約中の debounce を捨て、未保存の変更も「保存しない」と決める。draft を破棄する側が
   * 呼ぶ — 破棄の直後に予約分が発火すると、破棄したはずの draft が書き戻るため。
   */
  function cancel(): void {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    pending.value = false;
    unsaved = false;
  }

  /** 進行中の保存の完了を待つ(保存中でなければ即時解決)。 */
  function settled(): Promise<void> {
    return inFlight ?? Promise.resolve();
  }

  function trigger() {
    pending.value = true;
    unsaved = true;
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, debounceMs);
  }

  onUnmounted(() => {
    if (timer) clearTimeout(timer);
  });

  return { state, lastSavedAt, pending, trigger, flush, cancel, settled };
}
