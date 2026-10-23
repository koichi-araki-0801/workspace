// =============================================================================
// useAutosave.ts — 常時 autosave の composable(debounce + save state)
// =============================================================================
// 役割: `Result` を返す save 関数を debounce し、その進行状態を ref で公開する。
//
// 状態(`state`)と出来事:
//   idle / saved + trigger … タイマーを掛け直し idle へ(saved は未保存が無いときだけ)
//   error        + trigger … タイマーを掛け直し error のまま(再試行の導線を消さない)
//   saving       + trigger … タイマーを掛け直す。保存は止めず、終わったら続けて保存し直す
//   タイマー発火 / flush   … 実行中の流れ(`drain`)があればそれを待つ。未保存があれば流れを始める
//   保存の成功             … 未保存が残っていればもう一度保存、無ければ saved
//   保存の失敗             … 未保存へ戻して error。自動では再試行しない(flush で保存し直す)
//   cancel                 … タイマーと未保存を捨てる。実行中の保存は止めないが次の周回はしない

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
  // まだどの保存にも渡していない変更があるか。保存の開始で落とし、失敗で戻す。
  let unsaved = false;
  // `cancel` のたびに進める。失敗した保存が、その途中で破棄された変更を未保存へ戻さないための目印。
  let cancelGen = 0;
  // 実行中の「保存の流れ」(未保存が無くなるまで保存を繰り返す)。並行呼び出しの合流点であり、
  // `settled` が待つ対象でもある。結果は「流れの終わりに未保存が残っていないか」。
  let drain: Promise<boolean> | null = null;

  function clearTimer(): void {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  async function saveOnce(): Promise<boolean> {
    clearTimer();
    pending.value = false;
    unsaved = false;
    state.value = 'saving';
    const gen = cancelGen;
    try {
      const res = await save();
      if (isErr(res)) throw res.error;
      lastSavedAt.value = new Date();
      return true;
    } catch (e) {
      logError(toAppError(e));
      // 失敗した変更は未保存へ戻す。戻さないと再試行(`flush`)が保存するものが無いと判断する。
      if (gen === cancelGen) unsaved = true;
      state.value = 'error';
      return false;
    }
  }

  /**
   * 呼んだ時点までの変更を保存し、保存できたかを返す(保存するものが無ければ `true`)。
   * 保存中に呼ぶと、保存中に入った変更の保存し直しまで含めて待つ。
   */
  function flush(): Promise<boolean> {
    if (drain) return drain;
    // 保存すべき変更が無い flush は何もしない。手動 flush は画面遷移のたびに呼ばれるため、
    // 素通しすると何も編集していないのに draft が生成される。
    if (!pending.value && !unsaved) return Promise.resolve(true);
    drain = (async () => {
      try {
        while (await saveOnce()) {
          if (!unsaved) {
            state.value = 'saved';
            return true;
          }
        }
        return false;
      } finally {
        drain = null;
      }
    })();
    return drain;
  }

  /**
   * 予約中の debounce を捨て、未保存の変更も「保存しない」と決める。draft を破棄する側が
   * 呼ぶ — 破棄の直後に予約分が発火すると、破棄したはずの draft が書き戻るため。
   */
  function cancel(): void {
    clearTimer();
    pending.value = false;
    unsaved = false;
    cancelGen++;
  }

  /** 実行中の保存の流れ(保存し直しを含む)の終わりを待つ(保存中でなければ即時解決)。 */
  async function settled(): Promise<void> {
    if (drain) await drain;
  }

  function trigger() {
    pending.value = true;
    unsaved = true;
    // saved は「未保存が無い」の意味なので下ろす。error は再試行の導線なので残す。
    if (state.value === 'saved') state.value = 'idle';
    clearTimer();
    timer = setTimeout(flush, debounceMs);
  }

  onUnmounted(clearTimer);

  return { state, lastSavedAt, pending, trigger, flush, cancel, settled };
}
