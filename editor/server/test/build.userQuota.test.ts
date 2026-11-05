// =============================================================================
// build.userQuota.test.ts — `withBuildSlot` が人ごとの上限を、プール経路と代替経路の両方で数える
// =============================================================================
// 人ごとの上限は `withBuildSlot` の層に置く(PDF のビルド・結合・プロジェクト・プレビューの展開が
// 全部ここを通る)。プールが 0 台のときの代替経路(ジョブ毎 spawn)も同じ層の下なので、経路で
// 抜け道ができないことを確かめる。共有の行列で断られたとき・時間切れのときに人ごとの数が
// 戻ることも、本物のプール(ワーカーだけ偽物)で見る。
import { BUILD_BUSY_USER } from '@editor/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

// ワーカーは実プロセスの代役で、ジョブを終わらせない(時間切れの経路を通すため)。
vi.mock('../src/vivliostyle/buildWorkerServer.js', async () => {
  const { BuildWorkerPool } = await import('../src/vivliostyle/buildWorkerPool.js');
  return {
    killProcessTree: () => {},
    buildWorkerPool: new BuildWorkerPool({
      poolSize: 1,
      idleTtlMs: 60_000,
      timeoutMs: 200,
      maxQueue: 1,
      factory: () => ({
        run: () => new Promise<void>(() => {}),
        kill: () => {},
        onExit: () => {},
      }),
    }),
  };
});

const { withBuildSlot, buildLoadOf } = await import('../src/vivliostyle/build.js');
const { config } = await import('../src/config.js');

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

afterEach(() => {
  config.vivliostyle.build.poolSize = 1;
});

describe('withBuildSlot の人ごとの上限', () => {
  it('プール経路: 同じ人の 3 件目は 503、別の人は通る', async () => {
    const hold = deferred();
    const a1 = withBuildSlot(() => hold.promise, 'alice');
    const a2 = withBuildSlot(async () => 'a2', 'alice');
    await expect(withBuildSlot(async () => 'a3', 'alice')).rejects.toMatchObject({
      code: BUILD_BUSY_USER,
      statusCode: 503,
    });
    // bob は alice の数に関係なく受け付けられる(共有の行列に並ぶ)。
    const b1 = withBuildSlot(async () => 'b1', 'bob');
    hold.resolve();
    await expect(Promise.all([a1, a2, b1])).resolves.toEqual([undefined, 'a2', 'b1']);
    expect(buildLoadOf('alice')).toBe(0);
    expect(buildLoadOf('bob')).toBe(0);
  });

  it('プール経路: 共有の行列が一杯で断られても、人ごとの数は戻る', async () => {
    const hold = deferred();
    // 共有の枠 1 台 + 待ち 1 を、別の 2 人で埋める。
    const running = withBuildSlot(() => hold.promise, 'bob');
    const queued = withBuildSlot(async () => {}, 'carol');
    await expect(withBuildSlot(async () => {}, 'alice')).rejects.toThrow(/混み合っています/);
    expect(buildLoadOf('alice')).toBe(0);
    hold.resolve();
    await Promise.all([running, queued]);
  });

  it('プール経路: 時間切れでも人ごとの数は戻る', async () => {
    const res = withBuildSlot((runBuild) => runBuild({}), 'alice');
    await expect(res).rejects.toThrow(/タイムアウト/);
    expect(buildLoadOf('alice')).toBe(0);
  });

  it('プール経路: 展開(枠の中の準備)に失敗しても人ごとの数は戻る', async () => {
    await expect(
      withBuildSlot(async () => {
        throw new Error('zip の展開に失敗');
      }, 'alice'),
    ).rejects.toThrow('zip の展開に失敗');
    expect(buildLoadOf('alice')).toBe(0);
  });

  it('代替経路(プール 0 台)でも同じ人の 3 件目は 503 で、終われば数が戻る', async () => {
    config.vivliostyle.build.poolSize = 0;
    const hold = deferred();
    const a1 = withBuildSlot(() => hold.promise, 'alice');
    const a2 = withBuildSlot(async () => 'a2', 'alice');
    await expect(withBuildSlot(async () => 'a3', 'alice')).rejects.toMatchObject({
      code: BUILD_BUSY_USER,
    });
    expect(buildLoadOf('alice')).toBe(2);
    hold.resolve();
    await expect(Promise.all([a1, a2])).resolves.toEqual([undefined, 'a2']);
    expect(buildLoadOf('alice')).toBe(0);
  });
});
