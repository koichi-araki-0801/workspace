// =============================================================================
// auth.routes.ts — 認証ルート(login / logout / me / init-password)
// =============================================================================
// login と init-password は公開(OpenAPI の `security: []`)。logout と me は cookie の
// 読み取り後に動く。
import { apiPaths } from '@editor/shared';
import type { FastifyInstance } from 'fastify';
import type { z } from 'zod';
import { cookieOptions, sessionIdFrom } from '../auth/session.js';
import { config } from '../config.js';
import { actorFromReq, audit } from '../logger.js';
import { loadUser } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { LoginRequest, PasswordInitRequest } from '../openapi/schemas.js';
import * as auth from '../repositories/authRepo.js';

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: z.infer<typeof LoginRequest> }>(
    apiPaths.authLogin,
    { preHandler: validate(LoginRequest) },
    async (request, reply) => {
      const body = request.body;
      try {
        const { result, sessionId } = await auth.login(body);
        reply.setCookie(config.auth.cookieName, sessionId, cookieOptions);
        audit({
          event: 'auth.login',
          outcome: 'success',
          actor: result.user.username,
          ip: request.ip,
        });
        return result;
      } catch (e) {
        audit({
          event: 'auth.login',
          outcome: 'failure',
          actor: body.username,
          ip: request.ip,
          error: e instanceof Error ? e.message : 'login failed',
        });
        throw e;
      }
    },
  );

  app.post(apiPaths.authLogout, async (request, reply) => {
    await auth.logout(sessionIdFrom(request.headers.cookie));
    // クリアは Set-Cookie の属性(path 等)が発行時と一致する必要がある。maxAge は付けない。
    reply.clearCookie(config.auth.cookieName, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: config.auth.cookieSecure,
    });
    return reply.code(204).send();
  });

  app.get(apiPaths.authMe, async (request, reply) => {
    // 認証状態はキャッシュさせない(再起動/失効後に旧 200 が返るのを防ぐ)。
    reply.header('Cache-Control', 'no-store');
    return loadUser(request);
  });

  app.post<{ Body: z.infer<typeof PasswordInitRequest> }>(
    apiPaths.authInitPassword,
    { preHandler: validate(PasswordInitRequest) },
    async (request, reply) => {
      const body = request.body;
      await auth.initPassword(body);
      audit({
        event: 'auth.init-password',
        outcome: 'success',
        ...actorFromReq(request),
        resource: { username: body.username },
      });
      return reply.code(204).send();
    },
  );
}
