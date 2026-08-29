// =============================================================================
// user.ts — ユーザードメインのルール (純粋・Vue/DI 非依存で単体テスト可能)
// =============================================================================
import type { User } from '../index.js';

/** ユーザーが存在し、かつ admin ロールを持つとき true。 */
export function isAdmin(user: User | null | undefined): boolean {
  return user?.role === 'admin';
}

/**
 * 確定保存を承認できる(精査者)権限を持つとき true。`approver` と `admin` が該当する。
 * 承認画面/導線の出し分けに使う(サーバ側 `requireApprover` と同じ判定基準)。
 */
export function isApprover(user: User | null | undefined): boolean {
  return user?.role === 'approver' || user?.role === 'admin';
}

/** ユーザー作成時に集める入力フィールド。 */
export interface NewUserForm {
  username: string;
  displayName: string;
}

/** フィールド別のバリデーションメッセージ (空オブジェクト = 妥当)。 */
export interface NewUserErrors {
  username?: string;
  displayName?: string;
}

/**
 * ユーザーIDの運用アルファベット: 半角英数字とアンダースコア。
 *
 * これは画面の入力チェックではなく**運用上の唯一の字種規約**である。サーバ側の
 * 資格情報経路(`auth/loginId.ts` の `isOperationalLoginId`)とユーザ作成・更新の
 * リクエスト検証(`schemas.ts` の `Username`)が同じこの 1 本を参照する。
 *
 * 字種を絞る理由は入力ミス防止ではない。DB の照合順序(`Japanese_CI_AS`)は
 * ゼロウェイト文字などを無視して等価と見なすため、JS 側で照合順序を再現しない限り
 * 「JS では別キー・DB では同一行」の組が作れてしまう。再現は原理的に無理なので、
 * **入力域そのものを照合順序の差が出ない範囲へ狭める**ことで代える。
 */
export const USERNAME_PATTERN = /^[a-z0-9_]+$/i;

/** ユーザーIDの最大長。DB の `ログインID NVARCHAR(64)` に由来する。 */
export const USERNAME_MAX_LENGTH = 64;

/** 運用アルファベットと長さの両方に適合する ID か(client/server 共通の判定)。 */
export function isValidUsername(username: string): boolean {
  return username.length <= USERNAME_MAX_LENGTH && USERNAME_PATTERN.test(username);
}

/**
 * 資格情報の不一致で返す唯一の文言。未知 ID・無効アカウント・パスワード誤り・
 * 運用アルファベット外の ID の**全分岐が同じ定数を参照する**ことで、コピペのずれで
 * 文言が割れる(= 存在オラクルになる)のを防ぐ。
 */
export const INVALID_CREDENTIALS_MESSAGE = 'ユーザーIDまたはパスワードが違います';

/** パスワード再設定時の最小長。client/server で同一基準を使うため共有定数とする。 */
export const PASSWORD_MIN_LENGTH = 8;

/**
 * ユーザー追加フォームを検証する。`existingUsernames` を渡すと重複 (大文字小文字
 * 無視) を弾く。省略すると一意性チェックをスキップする。
 */
export function validateNewUser(
  form: NewUserForm,
  existingUsernames: readonly string[] = [],
): NewUserErrors {
  const errors: NewUserErrors = {};
  const username = form.username.trim();
  if (!username) errors.username = 'ユーザーIDを入力してください';
  else if (!isValidUsername(username))
    errors.username = '半角英数字とアンダースコアのみ使用できます';
  else if (existingUsernames.some((u) => u.toLowerCase() === username.toLowerCase()))
    errors.username = 'このユーザーIDは既に使われています';
  if (!form.displayName.trim()) errors.displayName = '表示名を入力してください';
  return errors;
}

export function hasErrors(errors: NewUserErrors): boolean {
  return Object.values(errors).some(Boolean);
}

/** 無効化操作の可否判定の結果(`ok=false` のとき `reason` に理由)。 */
export interface DisableUserCheck {
  ok: boolean;
  reason?: string;
}

/**
 * ユーザーを無効化してよいか判定する(純粋関数)。一手で管理アクセスを失う事故を防ぐため、
 * 「自分自身」と「最後の有効 admin」の無効化を禁止する。有効化(再有効化)はここでは扱わない。
 *
 * @param target 無効化しようとしているユーザー
 * @param currentUserId 操作中ユーザーの id
 * @param allUsers 全ユーザー(有効 admin 数の算定に使う)
 */
export function canDisableUser(
  target: User,
  currentUserId: string,
  allUsers: readonly User[],
): DisableUserCheck {
  if (target.id === currentUserId) {
    return { ok: false, reason: '自分自身は無効化できません' };
  }
  if (isAdmin(target)) {
    const activeAdmins = allUsers.filter((u) => isAdmin(u) && !u.disabled);
    // target は現状 有効 admin の前提。これを無効化して 0 になるなら拒否。
    if (activeAdmins.length <= 1) {
      return { ok: false, reason: '最後の管理者は無効化できません' };
    }
  }
  return { ok: true };
}
