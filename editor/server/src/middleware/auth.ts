// =============================================================================
// auth.ts — 認証 / 認可ミドルウェア(phase 2, Fastify preHandler フック)
// =============================================================================
// `requireAuth` はセッション cookie → DB セッション → `request.user` を解決する(無ければ 401)。
// `requireAdmin` はさらに admin ロールを強制する(403 = forbidden)。preHandler 配列の順に
// 実行されるので `[requireAuth, requireAdmin]` の順で適用する。
// 公開ルート(login / health / init-password)はこれらをスキップする。OpenAPI の
// `security: []` 指定(`document.ts`)と対応する。
import { forbidden, type User, unauthorized } from '@editor/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { getSessionUser, sessionIdFrom } from '../auth/session.js';
import { config } from '../config.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** `requireAuth` がセッション cookie から解決して埋める(`app.ts` で decorate)。 */
    user?: User;
  }
}

/** ログイン中ユーザをセッション cookie から解決する(未ログイン/失効時は null)。 */
export async function loadUser(req: FastifyRequest): Promise<User | null> {
  const sid = sessionIdFrom(req.headers.cookie);
  if (!sid) return null;
  return getSessionUser(sid);
}

export async function requireAuth(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  // ローカルモード(DB/セッション無し)ではデータ系ルートを開放する。web は
  // localStorage を使い呼び出さないため。PDF/generate はそのまま動く。
  if (!config.requireAuth) return;
  const user = await loadUser(request);
  if (!user) throw unauthorized('ログインが必要です');
  if (user.disabled) throw unauthorized('このアカウントは無効化されています');
  request.user = user;
}

/** `requireAuth` の後に実行する前提。admin ロールを強制する。 */
export async function requireAdmin(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  if (!config.requireAuth) return;
  if (!request.user) throw unauthorized('ログインが必要です');
  if (request.user.role !== 'admin') throw forbidden('管理者権限が必要です');
}

/**
 * `requireAuth` の後に実行する前提。精査者(承認者)ロールを強制する(`approver` または
 * `admin`)。確定保存の承認・却下、および緊急の直接確定保存(`PUT /templates/:id`)を
 * 施錠し、編集者(editor)が実ファイルへ書けないようにする(承認ワークフローの要)。
 */
export async function requireApprover(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  if (!config.requireAuth) return;
  if (!request.user) throw unauthorized('ログインが必要です');
  if (request.user.role !== 'approver' && request.user.role !== 'admin')
    throw forbidden('精査者(承認者)権限が必要です');
}
