// =============================================================================
// users.routes.ts — ユーザ管理のルート(admin 限定)
// =============================================================================
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

  app.post(
    apiPaths.users,
    { preHandler: [requireAuth, requireAdmin, validate(CreateUserRequest)] },
    async (request, reply) => {
      const body = request.body as z.infer<typeof CreateUserRequest>;
      const user = await users.createUser(body);
      audit({
        event: 'user.create',
        outcome: 'success',
        ...actorFromReq(request),
        resource: { id: user.id, username: user.username },
      });
      return reply.code(201).send(user);
    },
  );

  app.patch(
    apiPaths.userById,
    { preHandler: [requireAuth, requireAdmin, validate(UpdateUserRequest)] },
    async (request) => {
      const body = request.body as z.infer<typeof UpdateUserRequest>;
      return users.updateUser(String((request.params as { id: string }).id), body);
    },
  );

  app.post(
    apiPaths.userResetPassword,
    { preHandler: [requireAuth, requireAdmin] },
    async (request, reply) => {
      const id = String((request.params as { id: string }).id);
      await users.resetUserPassword(id);
      audit({
        event: 'user.reset-password',
        outcome: 'success',
        ...actorFromReq(request),
        resource: { id },
      });
      return reply.code(204).send();
    },
  );
}
