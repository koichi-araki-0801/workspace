// =============================================================================
// auth.ts — 認証 / 認可ミドルウェア(phase 2, Fastify preHandler フック)
// =============================================================================
// `requireAuth` はセッション cookie → DB セッション → `request.user` を解決する(無ければ 401)。
// `requireAdmin` はさらに admin ロールを強制する(403 = forbidden)。preHandler 配列の順に
// 実行されるので `[requireAuth, requireAdmin]` の順で適用する。
// 公開ルート(login / health)はこれらをスキップする。OpenAPI の
// `security: []` 指定(`document.ts`)と対応する。
// `要パスワード変更` の強制もここで行う。SPA のルータガードだけに任せていた頃は、API を
// 直接叩けば初期パスワードのままフル権限で操作できた(承認まで通った)。
import { apiPaths, forbidden, type User, unauthorized } from '@editor/shared';
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

/**
 * `要パスワード変更` のセッションでも通す経路。パスワード変更そのものと、変更画面が必ず使う
 * 「自分は誰か」「やめる」の 3 つに限る。ここを増やすと、初期パスワードのままのセッションで
 * 触れる API が増える = F16/F21 の再来になるので、追加は設計判断として扱うこと
 * (`server/test/mustChangePassword.test.ts` が「例外は 3 経路のみ」を固定している)。
 */
export const PASSWORD_CHANGE_ALLOWED_PATHS: readonly string[] = [
  apiPaths.authInitPassword,
  apiPaths.authMe,
  apiPaths.authLogout,
];

/**
 * 現在のリクエストが上記 3 経路のいずれかか。ルートは `/api` prefix 付きで登録されるため、
 * 正典 `apiPaths`(prefix 無し)とは後方一致で突き合わせる。`routeOptions.url` は
 * 「登録時のパターン」なので、query や動的セグメントの中身に影響されない。
 */
function isPasswordChangeAllowed(request: FastifyRequest): boolean {
  const url = request.routeOptions?.url ?? request.url.split('?')[0];
  return PASSWORD_CHANGE_ALLOWED_PATHS.some((p) => url === p || url.endsWith(p));
}

export async function requireAuth(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  // ローカルモード(DB/セッション無し)ではデータ系ルートを開放する。web は
  // localStorage を使い呼び出さないため。PDF/generate はそのまま動く。
  if (!config.requireAuth) return;
  const user = await loadUser(request);
  if (!user) throw unauthorized('ログインが必要です');
  if (user.disabled) throw unauthorized('このアカウントは無効化されています');
  // 初期パスワードのままのセッションは、変更を終えるまでパスワード変更経路しか触れない。
  if (user.mustChangePassword && !isPasswordChangeAllowed(request))
    throw forbidden('パスワードの再設定が完了するまで、この操作は利用できません', {
      code: 'PASSWORD_CHANGE_REQUIRED',
    });
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
