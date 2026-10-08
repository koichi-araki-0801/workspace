// =============================================================================
// mapLimit.ts — 同時実行数を制限した写像
// =============================================================================
// `Promise.all` の全件同時実行は fd やメモリを枯渇させる。外部依存(p-limit 等)を増やさない
// ための最小実装。

/**
 * `xs` を最大 `limit` 並列で `fn` に通す。結果は入力順。
 *
 * 失敗したときは返る Promise が reject する。既定では他の worker は残りを走らせ続ける。
 * `stopOnError` を立てると、失敗の後は未着手の要素を始めない(走行中のタスクは、返った Promise の reject 後もバックグラウンドで最後まで走る)。
 */
export async function mapLimit<T, R>(
  xs: readonly T[],
  limit: number,
  fn: (x: T, i: number) => Promise<R>,
  opts: { stopOnError?: boolean } = {},
): Promise<R[]> {
  const out = new Array<R>(xs.length);
  let next = 0;
  let failed = false;
  const run = async (): Promise<void> => {
    while (next < xs.length && !(opts.stopOnError && failed)) {
      const i = next;
      next += 1;
      try {
        out[i] = await fn(xs[i], i);
      } catch (e) {
        failed = true;
        throw e;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, xs.length) }, run));
  return out;
}
