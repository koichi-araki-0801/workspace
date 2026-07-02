import { describe, expect, it } from 'vitest';
import { andThen, err, isErr, isOk, map, ok, type Result } from '../src/result';

describe('ok / err / isOk / isErr', () => {
  it('constructs and narrows a success', () => {
    const r = ok(5);
    expect(isOk(r)).toBe(true);
    expect(isErr(r)).toBe(false);
    if (isOk(r)) expect(r.value).toBe(5);
  });

  it('constructs and narrows an error', () => {
    const r = err('boom');
    expect(isErr(r)).toBe(true);
    expect(isOk(r)).toBe(false);
    if (isErr(r)) expect(r.error).toBe('boom');
  });
});

describe('map', () => {
  it('map transforms a success only', () => {
    expect(map(ok(2), (n) => n * 3)).toEqual(ok(6));
    const e: Result<number, string> = err('x');
    // union からの推論では `n` が unknown に落ちるため注釈する(typecheck モードで検出)。
    expect(map(e, (n: number) => n * 3)).toEqual(err('x'));
  });
});

describe('andThen', () => {
  it('chains on success and short-circuits on error', () => {
    const half = (n: number): Result<number, string> => (n % 2 === 0 ? ok(n / 2) : err('odd'));
    expect(andThen(ok(8), half)).toEqual(ok(4));
    expect(andThen(ok(7), half)).toEqual(err('odd'));
    expect(andThen(err<string>('first'), half)).toEqual(err('first'));
  });
});
