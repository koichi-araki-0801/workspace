import { err, isErr, isOk, ok, unauthorized } from '@editor/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAsyncResult } from '@/lib/useAsyncResult';

afterEach(() => vi.restoreAllMocks());

describe('useAsyncResult', () => {
  it('returns ok and toggles loading off', async () => {
    const { loading, run } = useAsyncResult();
    const p = run(async () => ok(42));
    expect(loading.value).toBe(true);
    const res = await p;
    expect(loading.value).toBe(false);
    expect(isOk(res)).toBe(true);
    if (isOk(res)) expect(res.value).toBe(42);
  });

  it('passes an Err through, logging and toasting (not swallowing)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { run } = useAsyncResult();
    const res = await run(async () => err(unauthorized('だめ')));
    expect(isErr(res)).toBe(true);
    if (isErr(res)) expect(res.error.message).toBe('だめ');
    expect(errSpy).toHaveBeenCalled();
  });

  it('converts an unexpected throw into Err(AppError)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { run } = useAsyncResult();
    const res = await run(async () => {
      throw new Error('boom');
    });
    expect(isErr(res)).toBe(true);
    if (isErr(res)) expect(res.error.kind).toBe('unexpected');
  });

  it('keeps loading true until all concurrent runs settle (ref-counted)', async () => {
    const { loading, run } = useAsyncResult();
    let resolveA: (v: ReturnType<typeof ok<number>>) => void = () => {};
    let resolveB: (v: ReturnType<typeof ok<number>>) => void = () => {};
    const pA = run(() => new Promise((r) => (resolveA = r)));
    const pB = run(() => new Promise((r) => (resolveB = r)));
    expect(loading.value).toBe(true);

    // First settles, but the second is still in flight → still loading.
    resolveA(ok(1));
    await pA;
    expect(loading.value).toBe(true);

    // Both settled → idle.
    resolveB(ok(2));
    await pB;
    expect(loading.value).toBe(false);
  });
});
