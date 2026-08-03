// =============================================================================
// auth.routes.ts — 認証ルート(login / logout / me / init-password)
// =============================================================================
// 公開(OpenAPI の `security: []`)は login のみ。init-password はセッション必須 + 本人限定 +
// 現行パスワードによる所有証明を要する。logout と me は cookie の読み取り後に動く。
// login は唯一の未認証 KDF 到達点なので、`loginRateLimit` で (IP, ログインID) 単位に
// 試行回数を絞る — 総当たりと、PBKDF2 を空回しさせる CPU 枯渇の両方がここを通る。
import { apiPaths, forbidden } from '@editor/shared';
import type { FastifyInstance } from 'fastify';
import type { z } from 'zod';
import {
  clearLoginFailures,
  loginAttemptKey,
  loginRateLimitRejection,
  recordLoginFailure,
} from '../auth/loginRateLimit.js';
import { cookieOptions, sessionIdFrom } from '../auth/session.js';
import { config } from '../config.js';
import { actorFromReq, audit } from '../logger.js';
import { loadUser, requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { LoginRequest, PasswordInitRequest } from '../openapi/schemas.js';
import * as auth from '../repositories/authRepo.js';

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: z.infer<typeof LoginRequest> }>(
    apiPaths.authLogin,
    { preHandler: validate(LoginRequest) },
    async (request, reply) => {
      const body = request.body;
      const attemptKey = loginAttemptKey(request.ip, body.username);
      // 判定は KDF より前。拒否も攻撃の痕跡なので監査ログへ残してから返す。
      const rejection = loginRateLimitRejection(attemptKey);
      if (rejection) {
        audit({
          event: 'auth.login',
          outcome: 'failure',
          actor: body.username,
          ip: request.ip,
          error: rejection.code,
        });
        throw rejection;
      }
      try {
        const { result, sessionId } = await auth.login(body);
        clearLoginFailures(attemptKey);
        reply.setCookie(config.auth.cookieName, sessionId, cookieOptions);
        audit({
          event: 'auth.login',
          outcome: 'success',
          actor: result.user.username,
          ip: request.ip,
        });
        return result;
      } catch (e) {
        recordLoginFailure(attemptKey);
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

  // パスワード変更は「自分のパスワードを、現行パスワードを示して変える」操作に限定する。
  // 以前は未認証・所有証明なしで任意アカウントを書き換えられ、`admin` 乗っ取りが成立していた。
  // 本人が現行パスワードを忘れた場合の復旧は管理者リセット(`users.routes.ts`)だけが経路。
  app.post<{ Body: z.infer<typeof PasswordInitRequest> }>(
    apiPaths.authInitPassword,
    { preHandler: [requireAuth, validate(PasswordInitRequest)] },
    async (request, reply) => {
      const body = request.body;
      // `requireAuth` はローカルモード(認証無し)では素通りするため、`request.user` の有無で
      // 「認証が効いている構成か」を見てから他人指定を弾く。
      if (request.user && request.user.username !== body.username) {
        throw forbidden('他のユーザーのパスワードは変更できません');
      }
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
