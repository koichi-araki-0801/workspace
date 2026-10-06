// =============================================================================
// users.routes.ts — ユーザ管理のルート(admin 限定)
// =============================================================================
// 作成(201)とリセット(200)は一時パスワードの平文を応答ボディで返す。監査ログには
// **絶対に載せない** — 監査ログは長期保存されるため、載せた瞬間に「保存しない」前提が崩れる。
import { apiPaths, conflict, forbidden, notFound, type User } from '@editor/shared';
import type { FastifyPluginAsync } from 'fastify';
import type { z } from 'zod';
import type { Deps } from '../deps.js';
import { actorFromReq, audit } from '../logger.js';
import { requireAdmin, requireAuth, requireIdentifiedUser } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { CreateUserRequest, UpdateUserRequest } from '../openapi/schemas.js';
import type { UserRepo } from '../repositories/userRepo.js';

type UserPatch = z.infer<typeof UpdateUserRequest>;

/** 更新後に「ログインできる admin」であり続けるか。 */
function isActiveAdmin(user: Pick<User, 'role' | 'disabled'>): boolean {
  return user.role === 'admin' && !user.disabled;
}

// 管理者の席の検査と更新の直列化(`reviewRepo.ts` の `withReviewLock` と同型)。ロックがモジュール
// 直下に在るのは、`usersRoutes` を複数回登録しても触る台帳はプロセスに 1 つだから。台帳が
// 1 サーバにしか無い前提で、複数台構成ではプロセス間の排他にならない。作成とパスワードのリセットは
// 管理者の席を減らさないので鎖に入れない。
let userLedgerLock: Promise<unknown> = Promise.resolve();
function withUserLedgerLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = userLedgerLock.then(fn, fn);
  userLedgerLock = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * ロール・無効フラグの変更が管理者の席を失わせないことを確かめる。web の
 * `canDisableUser`(`@editor/shared`)と同じ規則をサーバでも強制する — 画面側の検査だけでは
 * API を直接叩けば素通りし、自分を締め出す・admin を 0 人にする変更が台帳へ届く。
 *
 * - 自分自身のロール・無効フラグは変えられない(現状と同じ値の指定は変更ではないので通す)。
 * - 変更後に有効な admin が 1 人も残らない変更は 409。数えるのは台帳の現況で、操作者の
 *   セッションではない(台帳側で既に無効化・降格された操作者を「残る admin」に数えない)。
 *
 * 台帳の読み取りと更新は別の sproc 呼び出しなので、検査から更新までの間に他方の更新が割り込むと
 * 2 人の admin が同時に互いを無効化できてしまう。呼び出し側が `withUserLedgerLock` で
 * 「検査 → 更新」を 1 組にして直列化するため、プロセス内では閉じる。サーバ 1 台が前提で、
 * 複数台にするなら sproc 側の同一トランザクション内の検査が要る。
 */
async function assertKeepsAdminSeat(
  users: UserRepo,
  actorId: string,
  targetId: string,
  patch: UserPatch,
): Promise<void> {
  if (patch.role === undefined && patch.disabled === undefined) return;
  const all = await users.listUsers();
  const target = all.find((u) => u.id === targetId);
  if (!target) throw notFound(`ユーザーが見つかりません: ${targetId}`);
  const next = { role: patch.role ?? target.role, disabled: patch.disabled ?? target.disabled };
  if (next.role === target.role && next.disabled === target.disabled) return;
  if (targetId === actorId) {
    throw forbidden('自分自身の権限・有効状態は変更できません', { code: 'USER_SELF_CHANGE' });
  }
  if (!isActiveAdmin(target) || isActiveAdmin(next)) return;
  const remaining = all.filter((u) => u.id !== targetId && isActiveAdmin(u));
  if (remaining.length === 0) {
    throw conflict('有効な管理者が 1 人もいなくなるため変更できません', { code: 'LAST_ADMIN' });
  }
}

export const usersRoutes: FastifyPluginAsync<{ deps: Pick<Deps, 'users'> }> = async (app, opts) => {
  const { users } = opts.deps;

  // ⚠ 資格情報・ユーザー台帳を操作する 4 ルートには `requireIdentifiedUser` を重ねる。
  // `requireAdmin` は `config.requireAuth` を見て素通りするため、`AUTH_REQUIRED=false` を
  // 明示した local 配備では role 検査が丸ごと消える。`requireIdentifiedUser` はフラグを見ず、
  // `request.user` が無ければ 401 にする(local モードにサーバ側アカウントは無いので 401 が正)。
  // この重ね掛けの網羅は `routeGuards.ts` の LOCAL_MODE_ENFORCED が起動時に強制する。
  app.get(
    apiPaths.users,
    { preHandler: [requireAuth, requireIdentifiedUser, requireAdmin] },
    async () => {
      return users.listUsers();
    },
  );

  app.post<{ Body: z.infer<typeof CreateUserRequest> }>(
    apiPaths.users,
    { preHandler: [requireAuth, requireIdentifiedUser, requireAdmin, validate(CreateUserRequest)] },
    async (request, reply) => {
      const body = request.body;
      const created = await users.createUser(body);
      audit({
        event: 'user.create',
        outcome: 'success',
        ...actorFromReq(request),
        resource: { id: created.user.id, username: created.user.username },
      });
      return reply.code(201).send(created);
    },
  );

  app.patch<{ Params: { id: string }; Body: z.infer<typeof UpdateUserRequest> }>(
    apiPaths.userById,
    { preHandler: [requireAuth, requireIdentifiedUser, requireAdmin, validate(UpdateUserRequest)] },
    async (request) => {
      // `requireIdentifiedUser` を通った後なので `request.user` は必ずある。
      const actor = request.user as NonNullable<typeof request.user>;
      return withUserLedgerLock(async () => {
        await assertKeepsAdminSeat(users, actor.id, request.params.id, request.body);
        return users.updateUser(request.params.id, request.body);
      });
    },
  );

  app.post<{ Params: { id: string } }>(
    apiPaths.userResetPassword,
    { preHandler: [requireAuth, requireIdentifiedUser, requireAdmin] },
    async (request, reply) => {
      const id = request.params.id;
      // 一時パスワードを返すため 204 ではなく 200 + ボディ。管理者がその場で本人へ渡す。
      const result = await users.resetUserPassword(id);
      audit({
        event: 'user.reset-password',
        outcome: 'success',
        ...actorFromReq(request),
        resource: { id },
      });
      return reply.code(200).send(result);
    },
  );
};
