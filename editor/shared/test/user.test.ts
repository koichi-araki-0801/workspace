import { describe, expect, it } from 'vitest';
import {
  canDisableUser,
  hasErrors,
  isAdmin,
  isValidUsername,
  USERNAME_MAX_LENGTH,
  validateNewUser,
} from '../src/domain/user';
import type { User } from '../src/index';
import { CreateUserRequest, UpdateUserRequest } from '../src/schemas';

const make = (role: User['role']): User => ({
  id: 'u1',
  username: 'u',
  displayName: 'U',
  role,
  disabled: false,
  mustChangePassword: false,
});

const user = (over: Partial<User>): User => ({ ...make('editor'), ...over });

describe('isAdmin', () => {
  it('is true only for the admin role', () => {
    expect(isAdmin(make('admin'))).toBe(true);
    expect(isAdmin(make('editor'))).toBe(false);
    expect(isAdmin(make('viewer'))).toBe(false);
  });

  it('is false for null/undefined', () => {
    expect(isAdmin(null)).toBe(false);
    expect(isAdmin(undefined)).toBe(false);
  });
});

describe('validateNewUser / hasErrors', () => {
  it('reports both fields when blank', () => {
    const e = validateNewUser({ username: '  ', displayName: '' });
    expect(e.username).toBeTruthy();
    expect(e.displayName).toBeTruthy();
    expect(hasErrors(e)).toBe(true);
  });

  it('is clean for a valid form', () => {
    const e = validateNewUser({ username: 'taro', displayName: '太郎' });
    expect(e).toEqual({});
    expect(hasErrors(e)).toBe(false);
  });
});

// 運用アルファベットは「画面の入力チェック」ではなく、資格情報経路が依存する不変条件
// (`server/src/auth/loginId.ts` の `isOperationalLoginId`)。DB の照合順序が無視する
// 文字を入力域から締め出すことで「正規形が一致 ⇔ DB で同一行」を成り立たせている。
describe('isValidUsername', () => {
  it.each(['admin', 'ADMIN', 'user_01', '_', '0'])('%j は運用アルファベット内', (id) => {
    expect(isValidUsername(id)).toBe(true);
  });

  it.each([
    ['', '空'],
    ['ad​min', 'ゼロ幅空白(DB では無視され admin と同一行になる)'],
    ['admin-1', 'ハイフン'],
    ['あどみん', 'かな(NFKC でも畳まれない)'],
    ['admin@example.com', '記号'],
    ['ａｄｍｉｎ', '全角(正規化前の生値は域外)'],
  ])('%j は域外 (%s)', (id) => {
    expect(isValidUsername(id)).toBe(false);
  });

  it('列幅を超える長さは域外', () => {
    expect(isValidUsername('a'.repeat(USERNAME_MAX_LENGTH))).toBe(true);
    expect(isValidUsername('a'.repeat(USERNAME_MAX_LENGTH + 1))).toBe(false);
  });
});

// `USERNAME_PATTERN` を web クライアントでしか見ないと、API を直接叩けば
// 域外 ID のアカウントを作れる(= 作った瞬間ログイン不能なアカウントになる)。
describe('CreateUserRequest / UpdateUserRequest のユーザーID 検証', () => {
  const base = {
    displayName: '太郎',
    role: 'editor' as const,
    disabled: false,
    mustChangePassword: true,
  };

  it('域内の ID は通る', () => {
    expect(CreateUserRequest.safeParse({ ...base, username: 'taro_01' }).success).toBe(true);
  });

  it.each(['ad​min', 'admin-1', 'あどみん', ''])('%j は 400 相当で弾く', (username) => {
    expect(CreateUserRequest.safeParse({ ...base, username }).success).toBe(false);
    expect(UpdateUserRequest.safeParse({ username }).success).toBe(false);
  });
});

describe('canDisableUser', () => {
  const me = user({ id: 'me', role: 'admin' });
  const other = user({ id: 'other', role: 'editor' });
  const admin2 = user({ id: 'a2', role: 'admin' });

  it('禁止: 自分自身の無効化', () => {
    const r = canDisableUser(me, 'me', [me, other]);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('自分自身');
  });

  it('禁止: 最後の有効 admin の無効化', () => {
    const r = canDisableUser(me, 'other', [me, other]); // me が唯一の有効 admin
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('最後の管理者');
  });

  it('許可: 有効 admin が他にいれば admin を無効化できる', () => {
    const r = canDisableUser(me, 'other', [me, admin2, other]);
    expect(r.ok).toBe(true);
  });

  it('許可: 自分以外の非 admin を無効化できる', () => {
    const r = canDisableUser(other, 'me', [me, other]);
    expect(r.ok).toBe(true);
  });

  it('無効化済みの admin は有効 admin 数に数えない', () => {
    const disabledAdmin = user({ id: 'a3', role: 'admin', disabled: true });
    // 有効 admin は me のみ → me を無効化しようとすると拒否
    const r = canDisableUser(me, 'other', [me, disabledAdmin, other]);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('最後の管理者');
  });
});
