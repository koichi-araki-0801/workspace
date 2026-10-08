// =============================================================================
// serialQueue.test.ts — `createSerialQueue` の直列化・失敗の分離・結果の返し方
// =============================================================================
import { describe, expect, it } from 'vitest';
import { createSerialQueue } from '../src/files/fileLock.js';

const tick = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe('createSerialQueue', () => {
  it('到着順に 1 本ずつ走らせ、処理が重ならない', async () => {
    const queue = createSerialQueue();
    const log: string[] = [];
    let running = 0;
    let maxRunning = 0;
    const job = (name: string, ms: number) =>
      queue(async () => {
        running += 1;
        maxRunning = Math.max(maxRunning, running);
        log.push(`start:${name}`);
        await tick(ms);
        log.push(`end:${name}`);
        running -= 1;
      });
    await Promise.all([job('a', 15), job('b', 1), job('c', 1)]);
    expect(log).toEqual(['start:a', 'end:a', 'start:b', 'end:b', 'start:c', 'end:c']);
    expect(maxRunning).toBe(1);
  });

  it('前の処理が reject しても次は走り、reject は呼び出し元へ返る', async () => {
    const queue = createSerialQueue();
    const failed = queue(async () => {
      throw new Error('boom');
    });
    const next = queue(async () => 'ok');
    await expect(failed).rejects.toThrow('boom');
    await expect(next).resolves.toBe('ok');
  });

  it('戻り値の型を保って返す', async () => {
    const queue = createSerialQueue();
    const n: number = await queue(async () => 42);
    expect(n).toBe(42);
  });

  it('別々に作ったキューは互いを待たない', async () => {
    const a = createSerialQueue();
    const b = createSerialQueue();
    const order: string[] = [];
    const slow = a(async () => {
      await tick(20);
      order.push('a');
    });
    const fast = b(async () => {
      order.push('b');
    });
    await Promise.all([slow, fast]);
    expect(order).toEqual(['b', 'a']);
  });
});
