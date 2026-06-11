import { type AppError, type AppErrorKind, appError, DEFAULT_ERROR_MESSAGE } from '@editor/shared';
import type { NextFunction, Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { errorHandler, statusForKind } from '../src/middleware/errorHandler.js';
import { validate } from '../src/middleware/validate.js';

// --- fakes ------------------------------------------------------------------

function fakeRes(headersSent = false) {
  const res = {
    headersSent,
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return res as unknown as Response & { statusCode: number; body: unknown };
}

const fakeReq = () => ({ log: { error: vi.fn() } }) as unknown as Request;

function runErrorHandler(err: unknown, res: ReturnType<typeof fakeRes>) {
  const next = vi.fn() as unknown as NextFunction;
  errorHandler(err, fakeReq(), res, next);
  return next;
}

// --- validate ---------------------------------------------------------------

describe('validate', () => {
  const schema = z.object({ name: z.string() });

  it('replaces req.body with the parsed value and calls next() with no error', () => {
    const req = { body: { name: 'x', extra: 'dropped' } } as Request;
    const next = vi.fn();
    validate(schema)(req, {} as Response, next);

    expect(next).toHaveBeenCalledWith();
    expect(req.body).toEqual({ name: 'x' });
  });

  it('forwards a validation AppError to next() when the body is invalid', () => {
    const req = { body: { name: 123 } } as Request;
    const next = vi.fn();
    validate(schema)(req, {} as Response, next);

    expect(next).toHaveBeenCalledTimes(1);
    const err = next.mock.calls[0][0] as AppError;
    expect(err.kind).toBe('validation');
    expect(err.message).toBe('リクエスト内容が不正です');
  });
});

// --- errorHandler -----------------------------------------------------------

describe('errorHandler', () => {
  it('maps each AppError kind to the right HTTP status', () => {
    const cases: Array<[AppErrorKind, number]> = [
      ['validation', 400],
      ['unauthorized', 401],
      ['not_found', 404],
      ['conflict', 409],
      ['network', 502],
      ['unexpected', 500],
    ];
    for (const [kind, status] of cases) {
      expect(statusForKind(kind)).toBe(status);
      const res = fakeRes();
      runErrorHandler(appError(kind, 'msg'), res);
      expect(res.statusCode).toBe(status);
    }
  });

  it('normalizes a non-AppError throw to 500 with the default safe message', () => {
    const res = fakeRes();
    runErrorHandler(new Error('low-level boom with secrets'), res);

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ kind: 'unexpected', message: DEFAULT_ERROR_MESSAGE });
  });

  it('never leaks cause to the client but passes machine-readable code through', () => {
    const res = fakeRes();
    runErrorHandler(
      appError('conflict', '競合', { cause: 'secret detail', code: 'USER_DISABLED' }),
      res,
    );

    expect(res.body).toEqual({ kind: 'conflict', message: '競合', code: 'USER_DISABLED' });
    expect(JSON.stringify(res.body)).not.toContain('secret detail');
  });

  it('delegates to next() when headers were already sent', () => {
    const res = fakeRes(true);
    const err = new Error('mid-stream');
    const next = runErrorHandler(err, res);

    expect(next).toHaveBeenCalledWith(err);
    expect(res.body).toBeUndefined();
  });
});
