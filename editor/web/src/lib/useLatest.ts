// =============================================================================
// useLatest.ts — 後着の古い応答を捨てる世代ガード
// =============================================================================
// 役割: 非同期取得を撃つたびに世代を採番し、応答が届いた時点でそれが最新の要求のもので
// あるかを判定できるようにする。検索条件を素早く変えると、前の条件の応答が後から届いて
// 画面を上書きしうる(表示中の条件と内容が食い違う)ため、取得結果の反映はこの述語で守る。

/**
 * 世代ガードの生成器。`begin` は新しい世代を開始し、「自分がまだ最新か」を返す述語を渡す。
 * 呼び出し側は await の直後にその述語で判定し、偽なら反映せず捨てる。
 *
 * ```ts
 * const latest = useLatest();
 * async function search() {
 *   const isLatest = latest.begin();
 *   const res = await repo.list();
 *   if (!isLatest()) return; // 後発の検索が既に走っている
 *   rows.value = res.value;
 * }
 * ```
 */
export function useLatest() {
  let generation = 0;

  /** 新しい世代を開始し、その世代がまだ最新かを返す述語を得る。 */
  function begin(): () => boolean {
    const mine = ++generation;
    return () => mine === generation;
  }

  return { begin };
}
