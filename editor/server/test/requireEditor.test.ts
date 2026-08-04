// =============================================================================
// requireEditor.test.ts — viewer を変更系から締め出す認可ミドルウェアの単体テスト
// =============================================================================
// `requireEditor` は editor|approver|admin のみ通し、viewer は 403、未認証は 401。
// 併せて `requireIdentifiedUser`(`config.requireAuth` を見ないガード)も検証する —
// パスワード変更の本人確認は「設定が倒れると検査ごと消える」形で書かれていたため、
// **設定値に従属しない**ことをテストで固定する。
import type { FastifyReply, FastifyRequest } from 'fastify';
import { beforeAll, describe, expect, it } from 'vitest';

process.env.AUTH_REQUIRED = 'true';

const reply = {} as FastifyReply;
const reqWith = (role?: string): FastifyRequest =>
  (role ? { user: { role, username: role } } : {}) as unknown as FastifyRequest;

describe('requireEditor', () => {
  let requireEditor: typeof import('../src/middleware/auth.js').requireEditor;

  beforeAll(async () => {
    requireEditor = (await import('../src/middleware/auth.js')).requireEditor;
  });

  it('allows editor, approver and admin', async () => {
    for (const role of ['editor', 'approver', 'admin']) {
      await expect(requireEditor(reqWith(role), reply)).resolves.toBeUndefined();
    }
  });

  it('forbids viewer (403)', async () => {
    await expect(requireEditor(reqWith('viewer'), reply)).rejects.toMatchObject({
      kind: 'forbidden',
    });
  });

  // 許可リストで書いてあることの確認。`role !== 'viewer'` の denylist だと、台帳へ
  // 新しいロールを増やした瞬間に既定で通ってしまう。
  it('forbids a role that is not on the allowlist (403)', async () => {
    for (const role of ['superuser', 'VIEWER', 'editor ', '']) {
      await expect(requireEditor(reqWith(role || undefined), reply)).rejects.toMatchObject({
        kind: role ? 'forbidden' : 'unauthorized',
      });
    }
  });

  it('rejects an unauthenticated request (401)', async () => {
    await expect(requireEditor(reqWith(), reply)).rejects.toMatchObject({
      kind: 'unauthorized',
    });
  });
});

describe('requireIdentifiedUser', () => {
  let requireIdentifiedUser: typeof import('../src/middleware/auth.js').requireIdentifiedUser;

  beforeAll(async () => {
    requireIdentifiedUser = (await import('../src/middleware/auth.js')).requireIdentifiedUser;
  });

  it('passes an authenticated request through regardless of role', async () => {
    for (const role of ['viewer', 'editor', 'admin']) {
      await expect(requireIdentifiedUser(reqWith(role), reply)).resolves.toBeUndefined();
    }
  });

  it('rejects a request with no resolved user (401)', async () => {
    await expect(requireIdentifiedUser(reqWith(), reply)).rejects.toMatchObject({
      kind: 'unauthorized',
    });
  });
});
