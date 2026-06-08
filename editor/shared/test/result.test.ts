import { describe, expect, it } from 'vitest';
import {
  andThen,
  andThenAsync,
  err,
  isErr,
  isOk,
  map,
  mapErr,
  ok,
  type Result,
  unwrapOr,
} from '../src/result';

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

describe('map / mapErr', () => {
  it('map transforms a success only', () => {
    expect(map(ok(2), (n) => n * 3)).toEqual(ok(6));
    const e: Result<number, string> = err('x');
    expect(map(e, (n) => n * 3)).toEqual(err('x'));
  });

  it('mapErr transforms an error only', () => {
    expect(mapErr(err('x'), (s) => `${s}!`)).toEqual(err('x!'));
    expect(mapErr(ok(2), (s: string) => `${s}!`)).toEqual(ok(2));
  });
});

describe('andThen / andThenAsync', () => {
  it('chains on success and short-circuits on error', () => {
    const half = (n: number): Result<number, string> => (n % 2 === 0 ? ok(n / 2) : err('odd'));
    expect(andThen(ok(8), half)).toEqual(ok(4));
    expect(andThen(ok(7), half)).toEqual(err('odd'));
    expect(andThen(err<string>('first'), half)).toEqual(err('first'));
  });

  it('andThenAsync chains an async step', async () => {
    const load = async (n: number): Promise<Result<string, string>> => ok(`#${n}`);
    expect(await andThenAsync(ok(1), load)).toEqual(ok('#1'));
    expect(await andThenAsync(err<string>('e'), load)).toEqual(err('e'));
  });
});

describe('unwrapOr', () => {
  it('returns the value or the fallback', () => {
    expect(unwrapOr(ok(1), 9)).toBe(1);
    expect(unwrapOr(err('e'), 9)).toBe(9);
  });
});
