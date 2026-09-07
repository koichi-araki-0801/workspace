// =============================================================================
// auth.ts — 認証 / 認可ミドルウェア(phase 2, Fastify preHandler フック)
// =============================================================================
// `requireAuth` はセッション cookie → DB セッション → `request.user` を解決する(無ければ 401)。
// `requireEditor` / `requireApprover` / `requireAdmin` はさらにロールを強制する
// (403 = forbidden)。preHandler 配列の順に実行されるので `[requireAuth, requireAdmin]` の
// 順で適用する。どのルートにどれを付けるかの正典は `routes/routeGuards.ts` の `ROUTE_POLICY`
// で、表と実際のガードの食い違いはサーバ起動時に落ちる。
// 公開ルート(login / health)はこれらをスキップする。OpenAPI の
// `security: []` 指定(`document.ts`)と対応する。
// `要パスワード変更` の強制もここで行う。SPA のルータガードだけに任せていた頃は、API を
// 直接叩けば初期パスワードのままフル権限で操作できた(承認まで通った)。
import { apiPaths, forbidden, type User, unauthorized } from '@editor/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { sessionIdFrom } from '../auth/session.js';
import { config } from '../config.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** `requireAuth` がセッション cookie から解決して埋める(`app.ts` で decorate)。 */
    user?: User;
  }
}

/**
 * ログイン中ユーザをセッション cookie から解決する(未ログイン/失効時は null)。
 * ストアはインスタンスに載っている(`app.ts` の `decorate`)。ここでモジュールを直接
 * 掴まないのは、注入したフェイクが素通りしてしまうため。
 */
export async function loadUser(req: FastifyRequest): Promise<User | null> {
  const sid = sessionIdFrom(req.headers.cookie);
  if (!sid) return null;
  return req.server.sessionStore.getSessionUser(sid);
}

/**
 * `要パスワード変更` のセッションでも通す経路。パスワード変更そのものと、変更画面が必ず使う
 * 「自分は誰か」「やめる」の 3 つに限る。ここを増やすと、初期パスワードのままのセッションで
 * 触れる API が増える = 強制変更を迂回して業務操作が通る穴になるので、追加は設計判断として扱うこと
 * (`server/test/mustChangePassword.test.ts` が「例外は 3 経路のみ」を固定している)。
 */
export const PASSWORD_CHANGE_ALLOWED_PATHS: readonly string[] = [
  apiPaths.authInitPassword,
  apiPaths.authMe,
  apiPaths.authLogout,
];

/**
 * 現在のリクエストが上記 3 経路のいずれかか。ルートは `/api` prefix 付きで登録されるため、
 * 正典 `apiPaths`(prefix 無し)とは `/api${p}` を組み立てて完全一致で突き合わせる
 * (`routes/routeGuards.ts` の `api()` と同じ合成)。`endsWith` の後方一致は
 * `/api/evil/auth/me` のような偽装パスまで免除対象にしてしまうため使わない。
 * `routeOptions.url` は「登録時のパターン」なので、query や動的セグメントの中身に
 * 影響されない。
 */
function isPasswordChangeAllowed(request: FastifyRequest): boolean {
  const url = request.routeOptions?.url ?? request.url.split('?')[0];
  return PASSWORD_CHANGE_ALLOWED_PATHS.some((p) => url === `/api${p}`);
}

/**
 * ロールの許可集合。**許可リストで書く**(`viewer` を名指しで拒む denylist にしない) —
 * 将来ロールが増えたときに既定で通ってしまう形を避けるため。未知のロール文字列は
 * どの集合にも属さないので自動的に 403 になる。
 */
const EDITOR_ROLES: readonly string[] = ['editor', 'approver', 'admin'];
const APPROVER_ROLES: readonly string[] = ['approver', 'admin'];
const ADMIN_ROLES: readonly string[] = ['admin'];

export async function requireAuth(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  // ローカルモード(DB/セッション無し)ではデータ系ルートを開放する。web は
  // localStorage を使い呼び出さないため。PDF/generate はそのまま動く。
  // ⚠ この素通しは**データ系ルートに限る**意図的な設計である。資格情報を書き換える
  // ルート(パスワード変更)はこの区分に属さないので、`requireIdentifiedUser` を重ねて
  // 設定値に依存しない施錠を掛けること。
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

/**
 * `config.requireAuth` を**参照しない**唯一のガード。ローカルモードでも 401 にする。
 *
 * 資格情報を書き換えるルート(パスワード変更)の本人確認を
 * `if (request.user && request.user.username !== body.username)` の形で書いてはならない。
 * `requireAuth` はローカルモードで `request.user` を埋めないまま素通りするため、
 * `AUTH_REQUIRED` が false の配備ではこの条件式ごと消え、未認証で任意アカウントの
 * パスワードを書き換えられる。**ガードの発火条件を設定値に従属させない**のがここの仕様で、
 * ローカルモードにサーバ側アカウントは存在しないのだから 401 が正しい応答である。
 */
export async function requireIdentifiedUser(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  if (!request.user) throw unauthorized('ログインが必要です');
}

/** `requireAuth` の後に実行する前提。admin ロールを強制する。 */
export async function requireAdmin(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  if (!config.requireAuth) return;
  if (!request.user) throw unauthorized('ログインが必要です');
  if (!ADMIN_ROLES.includes(request.user.role)) throw forbidden('管理者権限が必要です');
}

/**
 * `requireAuth` の後に実行する前提。編集者以上(`editor` / `approver` / `admin`)を強制する。
 *
 * `viewer` は**閲覧のみ**のロールで、台帳(`ユーザー.ロール`)の上にあるだけでは
 * 下書き上書き・削除・メモ書き・履歴追記・承認申請の投入まで全部通れる。変更系ルートは
 * 必ずこのガードを通すこと。適用の網羅は `routes/routeGuards.ts` の `ROUTE_POLICY` が
 * 正典で、表に無いルートはサーバ起動時に落ちる(付け忘れが本番まで届かない)。
 */
export async function requireEditor(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  if (!config.requireAuth) return;
  if (!request.user) throw unauthorized('ログインが必要です');
  if (!EDITOR_ROLES.includes(request.user.role)) throw forbidden('編集者権限が必要です');
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
  if (!APPROVER_ROLES.includes(request.user.role)) throw forbidden('精査者(承認者)権限が必要です');
}
