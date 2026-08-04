// =============================================================================
// auth.routes.ts — 認証ルート(login / logout / me / init-password)
// =============================================================================
// 公開(OpenAPI の `security: []`)は login のみ。init-password はセッション必須で、
// 対象は**常にセッション所有者**(body の指定は使わない)+ 現行パスワードによる所有証明を
// 要する。logout と me は cookie の読み取り後に動く。
//
// login と init-password は KDF(PBKDF2 12 万回反復)へ到達する 2 経路なので、どちらも
// `beginCredentialAttempt` を通す。判定と計上は同期 1 区間で行い(`auth/loginRateLimit.ts`
// 冒頭の不変条件)、通した試行は必ず `settleCredentialAttempt` で返す — 返し忘れると
// 同時実行ゲージがリークして全ログインが恒久的に拒否される。
//
// 失敗応答には `applyFailureFloor` で下限時間を課す。未知 ID / 無効アカウント /
// パスワード誤り / DB 障害で文言・ステータス・`code`・レート制限の状態を揃えても、
// 応答時間だけで「その ID は存在するか」が読めてしまうため(`auth/timing.ts`)。
import { apiPaths, forbidden } from '@editor/shared';
import type { FastifyInstance } from 'fastify';
import type { z } from 'zod';
import { canonicalLoginId } from '../auth/loginId.js';
import {
  type AttemptTicket,
  beginCredentialAttempt,
  settleCredentialAttempt,
} from '../auth/loginRateLimit.js';
import { cookieOptions, sessionIdFrom } from '../auth/session.js';
import { applyFailureFloor, startedNow } from '../auth/timing.js';
import { config } from '../config.js';
import { actorFromReq, audit } from '../logger.js';
import { loadUser, requireAuth, requireIdentifiedUser } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { LoginRequest, PasswordInitRequest } from '../openapi/schemas.js';
import * as auth from '../repositories/authRepo.js';

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: z.infer<typeof LoginRequest> }>(
    apiPaths.authLogin,
    { preHandler: validate(LoginRequest) },
    async (request, reply) => {
      const body = request.body;
      // 正規形は**レート制限のキーにも DB の引数にも同じものを渡す**。片方だけに使うと、
      // 大小文字や全角で書き分けるだけで 1 アカウントに独立したカウンタを作れる。
      const loginId = canonicalLoginId(body.username);
      const started = startedNow();
      const attempt = beginCredentialAttempt('login', request.ip, loginId);
      if (!attempt.ok) {
        // 拒否も攻撃の痕跡なので監査ログへ残す。フロアは掛けない — 攻撃者自身のキーの
        // 状態しか反映せず他人の存在を漏らさないうえ、速く返すほうが在庫を空ける。
        audit({
          event: 'auth.login',
          outcome: 'failure',
          actor: loginId,
          ip: request.ip,
          error: attempt.error.code,
        });
        throw attempt.error;
      }
      try {
        const { result, sessionId } = await auth.login(loginId, body.password);
        settleCredentialAttempt(attempt.ticket, 'success');
        reply.setCookie(config.auth.cookieName, sessionId, cookieOptions);
        audit({
          event: 'auth.login',
          outcome: 'success',
          actor: result.user.username,
          ip: request.ip,
        });
        return result;
      } catch (e) {
        settleCredentialAttempt(attempt.ticket, 'failure');
        audit({
          event: 'auth.login',
          outcome: 'failure',
          actor: loginId,
          ip: request.ip,
          error: e instanceof Error ? e.message : 'login failed',
        });
        await applyFailureFloor(started);
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
  //
  // `requireIdentifiedUser` は `config.requireAuth` を見ない。以前の本人一致検査は
  // `if (request.user && ...)` の形で、`AUTH_REQUIRED` が false の配備では条件式ごと
  // 消えて未認証で任意アカウントを書き換えられた(fail-open)。ガードの発火条件を設定値へ
  // 従属させないこと。
  app.post<{ Body: z.infer<typeof PasswordInitRequest> }>(
    apiPaths.authInitPassword,
    { preHandler: [requireAuth, requireIdentifiedUser, validate(PasswordInitRequest)] },
    async (request, reply) => {
      const body = request.body;
      // `requireIdentifiedUser` を通った時点で non-null。**対象は常にセッション所有者**で、
      // body の `username` は宛先として使わない — 比較で守る限り、比較の条件式が壊れれば
      // 穴に戻る。宛先を body から取らなければ「他人指定」という状態が表現できなくなる。
      const owner = request.user as NonNullable<typeof request.user>;
      const loginId = canonicalLoginId(owner.username);
      // 宛先には使わないが、食い違う指定は利用者の誤操作なので明示的に断る(契約の明確化。
      // 正規形で突き合わせるので `Admin` / `admin` の書き分けでは分岐しない)。
      if (body.username !== undefined && canonicalLoginId(body.username) !== loginId) {
        throw forbidden('他のユーザーのパスワードは変更できません');
      }
      const started = startedNow();
      const attempt = beginCredentialAttempt('init-password', request.ip, loginId);
      if (!attempt.ok) {
        audit({
          event: 'auth.init-password',
          outcome: 'failure',
          ...actorFromReq(request),
          error: attempt.error.code,
        });
        throw attempt.error;
      }
      // 現セッションだけ残して他端末を蹴る。パスワード変更で全部切ると、変更直後に
      // 自分もログアウトされ「初期パスワードのままでは他経路を触れない」状態と噛み合って
      // 復旧不能になる。奪われたセッションを断つという目的は他端末の失効で足りる。
      const currentSession = sessionIdFrom(request.headers.cookie);
      await settleAfter(attempt.ticket, started, async () => {
        await auth.initPassword(loginId, body, currentSession);
      });
      audit({
        event: 'auth.init-password',
        outcome: 'success',
        ...actorFromReq(request),
        resource: { username: loginId },
      });
      return reply.code(204).send();
    },
  );
}

/**
 * 試行本体を走らせ、成功・失敗のどちらでも必ずゲージを返す。失敗側だけ応答フロアを掛ける
 * (現行パスワード誤りの応答時間も、未知 ID / DB 障害と揃える)。
 */
async function settleAfter(
  ticket: AttemptTicket,
  startedAt: number,
  run: () => Promise<void>,
): Promise<void> {
  try {
    await run();
    settleCredentialAttempt(ticket, 'success');
  } catch (e) {
    settleCredentialAttempt(ticket, 'failure');
    await applyFailureFloor(startedAt);
    throw e;
  }
}
