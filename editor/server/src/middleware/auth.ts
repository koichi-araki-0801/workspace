// =============================================================================
// auth.ts — 認証 / 認可ミドルウェア(phase 2)
// =============================================================================
// `requireAuth` はセッション cookie → DB セッション → `req.user` を解決する(無ければ 401)。
// `requireAdmin` はさらに admin ロールを強制する(403 = forbidden)。
// 公開ルート(login / health / init-password)はこれらをスキップする。OpenAPI の
// `security: []` 指定(`document.ts`)と対応する。
import { forbidden, type User, unauthorized } from '@editor/shared';
import type { NextFunction, Request, Response } from 'express';
import { getSessionUser, sessionIdFrom } from '../auth/session.js';
import { config } from '../config.js';

declare global {
  namespace Express {
    interface Request {
      /** `requireAuth` がセッション cookie から解決して埋める。 */
      user?: User;
    }
  }
}

/** ログイン中ユーザをセッション cookie から解決する(未ログイン/失効時は null)。 */
export async function loadUser(req: Request): Promise<User | null> {
  const sid = sessionIdFrom(req.headers.cookie);
  if (!sid) return null;
  return getSessionUser(sid);
}

export async function requireAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  // ローカルモード(DB/セッション無し)ではデータ系ルートを開放する。web は
  // localStorage を使い呼び出さないため。PDF/generate はそのまま動く。
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

/** `requireAuth` の後に実行する前提。admin ロールを強制する。 */
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
