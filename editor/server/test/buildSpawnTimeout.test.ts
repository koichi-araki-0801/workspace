// =============================================================================
// buildSpawnTimeout.test.ts — ジョブ毎 spawn 経路の timeout がプロセスツリーごと止めること
// =============================================================================
// 子(node)は `@vivliostyle/cli` 経由で headless chromium を孫として起こす。timeout で子だけを
// 殺すと Windows では孫が残るので、プール経路と同じ `killProcessTree` で止めることを固定する。

import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

type ExecCallback = (err: Error | null, stdout: string, stderr: string) => void;
const { state } = vi.hoisted(() => ({
  state: {
    callback: undefined as ExecCallback | undefined,
    execOptions: undefined as Record<string, unknown> | undefined,
    killed: [] as unknown[],
  },
}));
const fakeChild = { pid: 4242 };

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFile: (
      _file: string,
      _args: string[],
      options: Record<string, unknown>,
      cb: ExecCallback,
    ) => {
      state.execOptions = options;
      state.callback = cb;
      return fakeChild;
    },
  };
});
vi.mock('../src/vivliostyle/buildWorkerServer.js', () => ({
  buildWorkerPool: { withSlot: () => Promise.reject(new Error('pool must not be used')) },
  killProcessTree: (child: unknown) => {
    state.killed.push(child);
    // 実物はツリーを止め、その結果 `execFile` のコールバックが kill 由来のエラーで呼ばれる。
    const err = Object.assign(new Error('killed'), { killed: true, signal: 'SIGTERM' });
    state.callback?.(err, '', '');
  },
}));

process.env.VIVLIO_BUILD_POOL = '0';
process.env.VIVLIO_BUILD_TIMEOUT_MS = '30';
process.env.TMP_DIR = path.join(os.tmpdir(), 'editor-build-spawn-timeout');
process.env.LOG_DIR = path.join(os.tmpdir(), 'editor-build-spawn-timeout-logs');

describe('runBuildWorkerSpawn — timeout', () => {
  it('timeout で子のプロセスツリーを止め、タイムアウトとして reject する', async () => {
    const build = await import('../src/vivliostyle/build.js');
    await expect(build.withBuildSlot((run) => run({}))).rejects.toThrow('タイムアウト(30ms)');
    expect(state.killed).toEqual([fakeChild]);
    // 子だけを殺す `execFile` 組み込みの timeout には任せない(孫の chromium が残る)。
    expect(state.execOptions).not.toHaveProperty('timeout');
  });
});
