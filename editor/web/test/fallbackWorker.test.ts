// fallbackWorker.test.ts — Worker RPC が失敗/ハングしたとき main-thread へ倒すことを検証する。
// 「プレビューが白紙のまま進まない」(Worker チャンクがオフラインで読めず RPC が永久に解決しない)
// 退行を防ぐ要のテスト。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AsyncHtmlWorker } from '../src/workers';
import { createFallbackWorker } from '../src/workers/fallback';

/** 5 メソッドの既定実装を持つダミー Worker。`impl` で必要なものだけ差し替える。 */
function makeWorker(impl: Partial<AsyncHtmlWorker> = {}): AsyncHtmlWorker {
  return {
    // biome-ignore lint/suspicious/noExplicitAny: テスト用ダミー戻り値(型は本質でない)
    buildHtmlDiff: async () => ({}) as any,
    // biome-ignore lint/suspicious/noExplicitAny: 同上
    buildHtmlDiffAligned: async () => ({}) as any,
    toTemplate: async () => 'tpl',
    toFilled: async () => 'filled',
    // biome-ignore lint/suspicious/noExplicitAny: 同上
    renderJinja: async () => ({ html: '', error: undefined }) as any,
    ...impl,
  };
}

describe('createFallbackWorker', () => {
  beforeEach(() => {
    // 失敗経路は logError が console.error を呼ぶ。テスト出力を汚さないよう黙らせる。
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('Worker が正常なら全メソッドを remote へ委譲する', async () => {
    const remote = makeWorker({
      // biome-ignore lint/suspicious/noExplicitAny: ダミー
      buildHtmlDiff: async () => ({ remote: true }) as any,
      // biome-ignore lint/suspicious/noExplicitAny: ダミー
      buildHtmlDiffAligned: async () => ({ remote: true }) as any,
      toTemplate: async () => 'remote-tpl',
      toFilled: async () => 'remote-filled',
      // biome-ignore lint/suspicious/noExplicitAny: ダミー
      renderJinja: async () => ({ html: 'remote', error: undefined }) as any,
    });
    const fallback = makeWorker();
    const { worker } = createFallbackWorker(remote, fallback);

    expect(await worker.toFilled('x', {})).toBe('remote-filled');
    expect(await worker.toTemplate('x')).toBe('remote-tpl');
    expect((await worker.renderJinja('x', {})).html).toBe('remote');
    expect(await worker.buildHtmlDiff('a', 'b')).toEqual({ remote: true });
    expect(await worker.buildHtmlDiffAligned('a', 'b', undefined, undefined, [])).toEqual({
      remote: true,
    });
  });

  it('remote が reject したら fallback へ落とし、以降は remote を呼ばない', async () => {
    const remoteFn = vi.fn(async () => {
      throw new Error('boom');
    });
    const fallbackFn = vi.fn(async () => 'from-fallback');
    const remote = makeWorker({ toFilled: remoteFn });
    const fallback = makeWorker({ toFilled: fallbackFn });
    const { worker } = createFallbackWorker(remote, fallback);

    expect(await worker.toFilled('x', {})).toBe('from-fallback');
    // 一度壊れたら 2 回目以降は remote を素通りして即フォールバックする。
    expect(await worker.toFilled('y', {})).toBe('from-fallback');
    expect(remoteFn).toHaveBeenCalledTimes(1);
    expect(fallbackFn).toHaveBeenCalledTimes(2);
  });

  it('remote がハングしたらタイムアウトで fallback へ落とす', async () => {
    vi.useFakeTimers();
    const remote = makeWorker({ toFilled: () => new Promise<string>(() => {}) }); // 永久に未解決
    const fallback = makeWorker({ toFilled: async () => 'from-fallback' });
    const { worker } = createFallbackWorker(remote, fallback, 1000);

    const p = worker.toFilled('x', {});
    await vi.advanceTimersByTimeAsync(1000);
    expect(await p).toBe('from-fallback');
  });

  it('markBroken で in-flight 呼び出しを即フォールバックし、以降も fallback を使う', async () => {
    const remote = makeWorker({ toFilled: () => new Promise<string>(() => {}) }); // ハング
    const fallback = makeWorker({ toFilled: async () => 'from-fallback' });
    const { worker, markBroken } = createFallbackWorker(remote, fallback, 1_000_000);

    const p = worker.toFilled('x', {});
    markBroken(new Error('worker error event'));
    expect(await p).toBe('from-fallback');
    // 壊れた後は remote(ハング)へ行かず即座にフォールバックが返る。
    expect(await worker.toFilled('y', {})).toBe('from-fallback');
  });
});
