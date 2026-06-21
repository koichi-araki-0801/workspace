// =============================================================================
// auth.routes.ts — 認証ルート(login / logout / me / init-password)
// =============================================================================
// login と init-password は公開(OpenAPI の `security: []`)。logout と me は cookie の
// 読み取り後に動く。
import { Router } from 'express';
import type { z } from 'zod';
import { cookieOptions, sessionIdFrom } from '../auth/session.js';
import { config } from '../config.js';
import { actorFromReq, audit } from '../logger.js';
import { loadUser } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { LoginRequest, PasswordInitRequest } from '../openapi/schemas.js';
import * as auth from '../repositories/authRepo.js';

export const authRouter = Router();

authRouter.post('/auth/login', validate(LoginRequest), async (req, res) => {
  const body = req.body as z.infer<typeof LoginRequest>;
  try {
    const { result, sessionId } = await auth.login(body);
    res.cookie(config.auth.cookieName, sessionId, cookieOptions);
    audit({ event: 'auth.login', outcome: 'success', actor: result.user.username, ip: req.ip });
    res.json(result);
  } catch (e) {
    audit({
      event: 'auth.login',
      outcome: 'failure',
      actor: body.username,
      ip: req.ip,
      error: e instanceof Error ? e.message : 'login failed',
    });
    throw e;
  }
});

authRouter.post('/auth/logout', async (req, res) => {
  await auth.logout(sessionIdFrom(req.headers.cookie));
  res.clearCookie(config.auth.cookieName, { ...cookieOptions, maxAge: undefined });
  res.status(204).end();
});

authRouter.get('/auth/me', async (req, res) => {
  res.json(await loadUser(req));
});

authRouter.post('/auth/init-password', validate(PasswordInitRequest), async (req, res) => {
  const body = req.body as z.infer<typeof PasswordInitRequest>;
  await auth.initPassword(body);
  audit({
    event: 'auth.init-password',
    outcome: 'success',
    ...actorFromReq(req),
    resource: { username: body.username },
  });
  res.status(204).end();
});
