// =============================================================================
// buildAdmission.test.ts — フォールバック経路の受付制御(同時実行数・行列長)
// =============================================================================
// 主張するのは「速いこと」ではなく**上限が効くこと**: 同時実行が上限を超えない・行列が
// 満杯なら処理を 1 つも始めずに断る・失敗しても枠が返る、の 3 点。実時間には依存しない
// (手動で解決する promise で進行を制御する)。
import { describe, expect, it } from 'vitest';
import { BuildAdmissionGate } from '../src/vivliostyle/buildAdmission.js';
import { BUILD_QUEUE_FULL_MESSAGE } from '../src/vivliostyle/buildWorkerPool.js';

// `config.ts` は import 時に env を 1 回だけ読むので、`build.ts` を**動的 import する前**に
// 立てる。ここで見たいのはプール非経由(`poolSize <= 0`)のフォールバック経路そのもの。
// テストファイルごとにプロセスが分かれる(vitest の既定 pool)ため、この代入は漏れない。
process.env.VIVLIO_BUILD_POOL = '0';
process.env.VIVLIO_BUILD_MAX_QUEUE = '1';

/** 外から解決できる promise(進行の制御に使う)。 */
function deferred(): { promise: Promise<void>; resolve: () => void; reject: (e: Error) => void } {
  let resolve!: () => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** マイクロタスクを 1 巡させる(待機者への引き渡しが済んだ状態を観測するため)。 */
const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

describe('BuildAdmissionGate', () => {
  it('runs at most maxConcurrent jobs and queues the rest', async () => {
    const gate = new BuildAdmissionGate({ maxConcurrent: 1, maxQueue: 4 });
    const first = deferred();
    const second = deferred();
    let started = 0;

    const a = gate.run(async () => {
      started += 1;
      await first.promise;
    });
    const b = gate.run(async () => {
      started += 1;
      await second.promise;
    });
    await tick();
    // 2 本目は「並んでいるだけ」で、処理には入っていない。
    expect(started).toBe(1);
    expect(gate.activeCount()).toBe(1);
    expect(gate.queueLength()).toBe(1);

    first.resolve();
    await a;
    await tick();
    expect(started).toBe(2);
    expect(gate.queueLength()).toBe(0);
    second.resolve();
    await b;
    expect(gate.activeCount()).toBe(0);
  });

  it('rejects without starting the job once the queue is full', async () => {
    const gate = new BuildAdmissionGate({ maxConcurrent: 1, maxQueue: 1 });
    const running = deferred();
    let started = 0;
    const inc = async (): Promise<void> => {
      started += 1;
      await running.promise;
    };

    const a = gate.run(inc); // 実行中
    const b = gate.run(inc); // 行列(1/1)
    await tick();
    // 満杯なので待たせずに断る。断った分は**準備処理を 1 つも走らせない**。
    await expect(gate.run(inc)).rejects.toThrow(BUILD_QUEUE_FULL_MESSAGE);
    expect(started).toBe(1);

    running.resolve();
    await Promise.all([a, b]);
    expect(started).toBe(2);
  });

  it('releases the slot when the job throws', async () => {
    const gate = new BuildAdmissionGate({ maxConcurrent: 1, maxQueue: 2 });
    await expect(gate.run(async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(gate.activeCount()).toBe(0);
    await expect(gate.run(async () => 'ok')).resolves.toBe('ok');
  });

  it('hands the slot to waiters in FIFO order', async () => {
    const gate = new BuildAdmissionGate({ maxConcurrent: 1, maxQueue: 4 });
    const head = deferred();
    const order: string[] = [];
    const jobs = [
      gate.run(async () => {
        order.push('head');
        await head.promise;
      }),
      gate.run(async () => {
        order.push('a');
      }),
      gate.run(async () => {
        order.push('b');
      }),
    ];
    head.resolve();
    await Promise.all(jobs);
    expect(order).toEqual(['head', 'a', 'b']);
  });

  it('never deadlocks on a non-positive maxConcurrent', async () => {
    // 0 を素通しすると誰も枠を取れず、全ビルドが timeout まで待つ「静かな全停止」になる。
    const gate = new BuildAdmissionGate({ maxConcurrent: 0, maxQueue: 1 });
    await expect(gate.run(async () => 'ok')).resolves.toBe('ok');
  });
});

// 障害調査用の安全弁(ジョブ毎 spawn)にも受付制御が効いていることを見る。渡された
// `runBuild` は**呼ばない**ので、実 CLI もワーカープロセスも起動しない。
describe('withBuildSlot with poolSize <= 0 (spawn fallback)', () => {
  it('serializes jobs and refuses once the queue is full', async () => {
    const { withBuildSlot } = await import('../src/vivliostyle/build.js');
    const head = deferred();
    let started = 0;

    const a = withBuildSlot(async () => {
      started += 1;
      await head.promise;
      return 'a';
    });
    const b = withBuildSlot(async () => {
      started += 1;
      return 'b';
    });
    await tick();
    // 2 本目は行列(`VIVLIO_BUILD_MAX_QUEUE=1`)で待っており、まだ何も準備していない。
    expect(started).toBe(1);
    // 3 本目は満杯なので即断る(プール経路と同じ文言)。
    await expect(withBuildSlot(async () => 'c')).rejects.toThrow(BUILD_QUEUE_FULL_MESSAGE);
    expect(started).toBe(1);

    head.resolve();
    expect(await a).toBe('a');
    expect(await b).toBe('b');
    expect(started).toBe(2);
  });
});
