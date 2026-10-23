import type { FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import { actorOf, pickQuery } from '../src/routes/routeHelpers.js';

describe('actorOf', () => {
  it('認証済みならユーザー名、user 未設定なら system を返す', () => {
    expect(actorOf({ user: { username: 'alice' } } as unknown as FastifyRequest)).toBe('alice');
    expect(actorOf({} as FastifyRequest)).toBe('system');
  });
});

describe('pickQuery', () => {
  it('非空の文字列だけを拾い、空文字・非文字列・欠落は undefined にする', () => {
    const r = pickQuery({ a: 'x', b: '', c: 3, d: ['y'] }, ['a', 'b', 'c', 'd', 'e'] as const);
    expect(r).toEqual({ a: 'x', b: undefined, c: undefined, d: undefined, e: undefined });
  });
});
