// =============================================================================
// rafOnce.ts — 同じ処理の連続予約を次の描画フレーム 1 回へ集約する
// =============================================================================

/**
 * `fn` を次の `requestAnimationFrame` で走らせる関数にする。フレームが来るまでの再呼び出しは
 * 1 回に畳む(予約済みなら何もしない)。高頻度で発火する変更通知から、重い再計測を間引くのに使う。
 */
export function rafOnce(fn: () => void): () => void {
  let scheduled = false;
  return () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      fn();
    });
  };
}
