// =============================================================================
// useSlowIndicator.ts — 長引くローディングの「時間がかかっています」判定 composable
// =============================================================================
// vivliostyle / Worker は進捗を公開しないため determinate なプログレスは組めない。
// かわりに loading が閾値を超えたら slow を立て、呼び出し側が補足メッセージを追記して
// 無限スピナーの不安(固まった?)を和らげる。Worker フォールバックの 30 秒タイムアウト
// (`workers/fallback.ts`)より手前で出す想定の既定 8 秒。

import { onUnmounted, type Ref, ref, watch } from 'vue';

export function useSlowIndicator(loading: Ref<boolean>, thresholdMs = 8000) {
  const slow = ref(false);
  let timer: ReturnType<typeof setTimeout> | null = null;

  function clear(): void {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  watch(
    loading,
    (on) => {
      clear();
      if (on) {
        timer = setTimeout(() => {
          slow.value = true;
        }, thresholdMs);
      } else {
        slow.value = false;
      }
    },
    { immediate: true },
  );

  onUnmounted(clear);

  return { slow };
}
