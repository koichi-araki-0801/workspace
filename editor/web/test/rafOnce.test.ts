import { afterEach, describe, expect, it, vi } from 'vitest';
import { rafOnce } from '@/lib/rafOnce';

/** rAF を手動で流せるようにする。`flush()` で保留中のコールバックを 1 フレーム分実行する。 */
function stubRaf() {
  let queue: FrameRequestCallback[] = [];
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    queue.push(cb);
    return queue.length;
  });
  return () => {
    const due = queue;
    queue = [];
    for (const cb of due) cb(0);
  };
}

describe('rafOnce', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('フレームが来るまでの連続呼び出しを 1 回に集約する', () => {
    const flush = stubRaf();
    const fn = vi.fn();
    const schedule = rafOnce(fn);
    schedule();
    schedule();
    schedule();
    expect(fn).not.toHaveBeenCalled();
    flush();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('次のフレームでは再び予約できる', () => {
    const flush = stubRaf();
    const fn = vi.fn();
    const schedule = rafOnce(fn);
    schedule();
    flush();
    schedule();
    schedule();
    flush();
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
