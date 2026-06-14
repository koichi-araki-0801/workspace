/**
 * Authentication / authorization middleware (phase 2).
 *
 * `requireAuth` resolves the session cookie → DB session → `req.user` (or 401).
 * `requireAdmin` additionally enforces the admin role (403 = forbidden).
 * Public routes (login / health / init-password) skip these — matching the
 * OpenAPI `security: []` markers.
 */
import { forbidden, type User, unauthorized } from '@editor/shared';
import type { NextFunction, Request, Response } from 'express';
import { getSessionUser, sessionIdFrom } from '../auth/session.js';
import { config } from '../config.js';

declare global {
  namespace Express {
    interface Request {
      /** Populated by requireAuth from the session cookie. */
      user?: User;
    }
  }
}

/** Resolve the logged-in user from the session cookie (null when none/expired). */
export async function loadUser(req: Request): Promise<User | null> {
  const sid = sessionIdFrom(req.headers.cookie);
  if (!sid) return null;
  return getSessionUser(sid);
}

export async function requireAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  // Local mode (no DB/sessions): leave data routes open — the web uses
  // localStorage and never calls them; PDF/generate keep working.
  if (!config.requireAuth) {
    next();
    return;
  }
  try {
    const user = await loadUser(req);
    if (!user) throw unauthorized('ログインが必要です');
    if (user.disabled) throw unauthorized('このアカウントは無効化されています');
    req.user = user;
    next();
  } catch (e) {
    next(e);
  }
}

/** Must run after requireAuth. Enforces the admin role. */
export function requireAdmin(req: Request, _res: Response, next: NextFunction): void {
  if (!config.requireAuth) {
    next();
    return;
  }
  if (!req.user) {
    next(unauthorized('ログインが必要です'));
    return;
  }
  if (req.user.role !== 'admin') {
    next(forbidden('管理者権限が必要です'));
    return;
  }
  next();
}
