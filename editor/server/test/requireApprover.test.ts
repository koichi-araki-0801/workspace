// =============================================================================
// requireApprover.test.ts — 確定保存の承認を施錠する認可ミドルウェアの単体テスト
// =============================================================================
// `requireApprover` は approver|admin のみ通し、editor/viewer は 403、未認証は 401。
// config を import する前に `AUTH_REQUIRED=true` を立て、認可を有効化した状態で検証する。
import type { FastifyReply, FastifyRequest } from 'fastify';
import { beforeAll, describe, expect, it } from 'vitest';

process.env.AUTH_REQUIRED = 'true';

const reply = {} as FastifyReply;
const reqWith = (role?: string): FastifyRequest =>
  (role ? { user: { role } } : {}) as unknown as FastifyRequest;

describe('requireApprover', () => {
  let requireApprover: typeof import('../src/middleware/auth.js').requireApprover;

  beforeAll(async () => {
    requireApprover = (await import('../src/middleware/auth.js')).requireApprover;
  });

  it('allows approver and admin', async () => {
    await expect(requireApprover(reqWith('approver'), reply)).resolves.toBeUndefined();
    await expect(requireApprover(reqWith('admin'), reply)).resolves.toBeUndefined();
  });

  it('forbids editor and viewer (403)', async () => {
    await expect(requireApprover(reqWith('editor'), reply)).rejects.toMatchObject({
      kind: 'forbidden',
    });
    await expect(requireApprover(reqWith('viewer'), reply)).rejects.toMatchObject({
      kind: 'forbidden',
    });
  });

  it('rejects an unauthenticated request (401)', async () => {
    await expect(requireApprover(reqWith(), reply)).rejects.toMatchObject({
      kind: 'unauthorized',
    });
  });
});
