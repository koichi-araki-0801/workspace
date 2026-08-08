// =============================================================================
// users.routes.ts — ユーザ管理のルート(admin 限定)
// =============================================================================
// 作成(201)とリセット(200)は一時パスワードの平文を応答ボディで返す。監査ログには
// **絶対に載せない** — 監査ログは長期保存されるため、載せた瞬間に「保存しない」前提が崩れる。
import { apiPaths } from '@editor/shared';
import type { FastifyInstance } from 'fastify';
import type { z } from 'zod';
import { actorFromReq, audit } from '../logger.js';
import { requireAdmin, requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { CreateUserRequest, UpdateUserRequest } from '../openapi/schemas.js';
import * as users from '../repositories/userRepo.js';

export async function usersRoutes(app: FastifyInstance): Promise<void> {
  app.get(apiPaths.users, { preHandler: [requireAuth, requireAdmin] }, async () => {
    return users.listUsers();
  });

  app.post<{ Body: z.infer<typeof CreateUserRequest> }>(
    apiPaths.users,
    { preHandler: [requireAuth, requireAdmin, validate(CreateUserRequest)] },
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
    { preHandler: [requireAuth, requireAdmin, validate(UpdateUserRequest)] },
    async (request) => {
      return users.updateUser(request.params.id, request.body);
    },
  );

  app.post<{ Params: { id: string } }>(
    apiPaths.userResetPassword,
    { preHandler: [requireAuth, requireAdmin] },
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
}
