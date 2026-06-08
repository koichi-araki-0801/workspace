import { describe, expect, it } from 'vitest';
import {
  appError,
  conflict,
  DEFAULT_ERROR_MESSAGE,
  isAppError,
  notFound,
  toAppError,
  unauthorized,
  validation,
} from '../src/errors';

describe('constructors', () => {
  it('appError carries kind/message/opts', () => {
    expect(appError('conflict', 'dup', { code: 'X', cause: 1 })).toEqual({
      kind: 'conflict',
      message: 'dup',
      code: 'X',
      cause: 1,
    });
  });

  it('shorthands set the right kind', () => {
    expect(notFound('a').kind).toBe('not_found');
    expect(validation('a').kind).toBe('validation');
    expect(unauthorized('a').kind).toBe('unauthorized');
    expect(conflict('a').kind).toBe('conflict');
  });
});

describe('isAppError', () => {
  it('recognizes AppError shapes only', () => {
    expect(isAppError(notFound('x'))).toBe(true);
    expect(isAppError(new Error('x'))).toBe(false);
    expect(isAppError({ message: 'x' })).toBe(false);
    expect(isAppError(null)).toBe(false);
    expect(isAppError('x')).toBe(false);
  });
});

describe('toAppError', () => {
  it('passes an existing AppError through unchanged', () => {
    const e = unauthorized('no');
    expect(toAppError(e)).toBe(e);
  });

  it('wraps an unknown throw with a safe generic message and preserved cause', () => {
    const raw = new Error('SQL connection refused at 10.0.0.1');
    const wrapped = toAppError(raw, 'network');
    expect(wrapped.kind).toBe('network');
    expect(wrapped.message).toBe(DEFAULT_ERROR_MESSAGE);
    expect(wrapped.cause).toBe(raw);
  });

  it('defaults the kind to unexpected', () => {
    expect(toAppError('weird').kind).toBe('unexpected');
  });
});
