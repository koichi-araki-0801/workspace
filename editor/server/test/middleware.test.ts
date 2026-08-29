import { type AppErrorKind, appError, DEFAULT_ERROR_MESSAGE } from '@editor/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { errorHandler, statusForKind } from '../src/middleware/errorHandler.js';
import { validate } from '../src/middleware/validate.js';

// --- fakes ------------------------------------------------------------------

/** 集中エラーハンドラが触る reply の最小モック(code/send + headersSent 判定)。 */
function fakeReply(headersSent = false) {
  const reply = {
    sent: false,
    raw: { headersSent },
    statusCode: 200,
    body: undefined as unknown,
    code(c: number) {
      this.statusCode = c;
      return this;
    },
    send(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return reply;
}

const fakeReq = () => ({ log: { error: vi.fn() } }) as unknown as FastifyRequest;

function runErrorHandler(err: unknown, reply: ReturnType<typeof fakeReply>) {
  const req = fakeReq();
  errorHandler(err as never, req, reply as unknown as FastifyReply);
  return req;
}

// --- validate ---------------------------------------------------------------

describe('validate', () => {
  const schema = z.object({ name: z.string() });

  it('replaces request.body with the parsed value and resolves', async () => {
    const request = { body: { name: 'x', extra: 'dropped' } } as FastifyRequest;
    await validate(schema)(request, {} as FastifyReply, () => {});

    expect(request.body).toEqual({ name: 'x' });
  });

  it('throws a validation AppError when the body is invalid', async () => {
    const request = { body: { name: 123 } } as FastifyRequest;
    await expect(validate(schema)(request, {} as FastifyReply, () => {})).rejects.toMatchObject({
      kind: 'validation',
      message: 'リクエスト内容が不正です',
    });
  });
});

// --- errorHandler -----------------------------------------------------------

describe('errorHandler', () => {
  it('maps each AppError kind to the right HTTP status', () => {
    const cases: Array<[AppErrorKind, number]> = [
      ['validation', 400],
      ['unauthorized', 401],
      ['forbidden', 403],
      ['not_found', 404],
      ['conflict', 409],
      ['network', 502],
      ['unexpected', 500],
    ];
    for (const [kind, status] of cases) {
      expect(statusForKind(kind)).toBe(status);
      const reply = fakeReply();
      runErrorHandler(appError(kind, 'msg'), reply);
      expect(reply.statusCode).toBe(status);
    }
  });

  it('normalizes a non-AppError throw to 500 with the default safe message', () => {
    const reply = fakeReply();
    runErrorHandler(new Error('low-level boom with secrets'), reply);

    expect(reply.statusCode).toBe(500);
    expect(reply.body).toEqual({ kind: 'unexpected', message: DEFAULT_ERROR_MESSAGE });
  });

  it('never leaks cause to the client but passes machine-readable code through', () => {
    const reply = fakeReply();
    runErrorHandler(
      appError('conflict', '競合', { cause: 'secret detail', code: 'USER_DISABLED' }),
      reply,
    );

    expect(reply.body).toEqual({ kind: 'conflict', message: '競合', code: 'USER_DISABLED' });
    expect(JSON.stringify(reply.body)).not.toContain('secret detail');
  });

  it('does not send when headers were already sent (logs only)', () => {
    const reply = fakeReply(true);
    const req = runErrorHandler(new Error('mid-stream'), reply);

    expect(reply.body).toBeUndefined();
    expect(reply.statusCode).toBe(200);
    expect(req.log.error as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
  });
});
