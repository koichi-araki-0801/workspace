// =============================================================================
// mapLimit.test.ts — 並列数の上限・入力順の結果・失敗時の打ち切り
// =============================================================================
import { describe, expect, it } from 'vitest';
import { mapLimit } from '../src/util/mapLimit.js';

const tick = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe('mapLimit', () => {
  it('結果は入力順で、同時実行数は limit を超えない', async () => {
    let running = 0;
    let max = 0;
    const out = await mapLimit([1, 2, 3, 4, 5, 6], 2, async (x, i) => {
      running += 1;
      max = Math.max(max, running);
      await tick(6 - x);
      running -= 1;
      return `${i}:${x * 10}`;
    });
    expect(out).toEqual(['0:10', '1:20', '2:30', '3:40', '4:50', '5:60']);
    expect(max).toBe(2);
  });

  it('空配列は空を返す', async () => {
    expect(await mapLimit([], 4, async (x: number) => x)).toEqual([]);
  });

  it('既定では失敗した worker だけが止まり、他の worker は残りを走らせ続ける', async () => {
    const seen: number[] = [];
    await expect(
      mapLimit([1, 2, 3, 4], 2, async (x) => {
        seen.push(x);
        await tick(x === 1 ? 1 : 5);
        if (x === 1) throw new Error('boom');
        return x;
      }),
    ).rejects.toThrow('boom');
    await tick(40);
    expect(seen).toEqual([1, 2, 3, 4]);
  });

  it('stopOnError なら失敗の後に未着手の要素を始めない', async () => {
    const seen: number[] = [];
    await expect(
      mapLimit(
        [1, 2, 3, 4, 5, 6],
        2,
        async (x) => {
          seen.push(x);
          await tick(1);
          if (x === 1) throw new Error('boom');
          return x;
        },
        { stopOnError: true },
      ),
    ).rejects.toThrow('boom');
    await tick(30);
    expect(seen.length).toBeLessThan(6);
  });
});
