// =============================================================================
// fakeRepositories.ts — ストアとサービスのテスト用の偽 repo(インメモリ・テスト専用)
// =============================================================================
// 本物の REST repo は fetch を要するので、ストアやサービスの振る舞いだけを見たいテストは
// これを provide する。値はすべて架空のテスト用ダミーで、本番のどのデータとも対応しない。
// 呼ばれる想定の無いメソッドは黙って成功させず、呼ばれた時点で例外を投げる(テストが
// 偽物の既定値に寄りかかって緑になるのを防ぐ)。localStorage には触らない。
import { type AuthRepository, err, ok, type User, unauthorized } from '@editor/shared';
import type { Repositories } from '@/api/repositories';

/** 偽の認証が知っているテスト用ユーザー。パスワードは明らかなダミー値。 */
const TEST_USERS: ReadonlyArray<User & { password: string }> = [
  {
    id: 'test-u-admin',
    username: 'test-admin',
    displayName: 'テスト管理者',
    role: 'admin',
    disabled: false,
    mustChangePassword: false,
    password: 'dummy-pass-admin',
  },
  {
    id: 'test-u-approver',
    username: 'test-approver',
    displayName: 'テスト精査者',
    role: 'approver',
    disabled: false,
    mustChangePassword: false,
    password: 'dummy-pass-approver',
  },
  {
    id: 'test-u-editor',
    username: 'test-editor',
    displayName: 'テスト編集者',
    role: 'editor',
    disabled: false,
    mustChangePassword: true,
    password: 'dummy-pass-editor',
  },
];

/** テストからログインに使う資格情報(`TEST_USERS` と同じ値)。 */
export const TEST_LOGIN = {
  admin: { username: 'test-admin', password: 'dummy-pass-admin' },
  approver: { username: 'test-approver', password: 'dummy-pass-approver' },
  editor: { username: 'test-editor', password: 'dummy-pass-editor' },
} as const;

/** セッションを 1 つだけ持つ偽の認証。同じ偽 repo を provide したストア同士で共有される。 */
function fakeAuthRepo(): AuthRepository {
  let session: User | null = null;
  return {
    async login({ username, password }) {
      const found = TEST_USERS.find((u) => u.username === username && u.password === password);
      if (!found) return err(unauthorized('ユーザー名またはパスワードが違います'));
      const { password: _, ...user } = found;
      session = user;
      return ok({ user, mustChangePassword: user.mustChangePassword });
    },
    async logout() {
      session = null;
      return ok(undefined);
    },
    async me() {
      return ok(session);
    },
    async initPassword() {
      return ok(undefined);
    },
  };
}

/** 未実装のメソッドを呼ぶと例外を投げる repo を作る。 */
function strictRepo<T extends object>(name: string, impl: Partial<T>): T {
  return new Proxy(impl as T, {
    get(target, prop, receiver) {
      if (prop in target) return Reflect.get(target, prop, receiver);
      if (typeof prop === 'symbol' || prop === 'then') return undefined;
      return () => {
        throw new Error(`fake: ${name}.${prop} は未実装`);
      };
    },
  });
}

type RepoOverrides = { [K in keyof Repositories]?: Partial<Repositories[K]> };

/**
 * テスト用の偽 repo 一式を作る。`auth` だけは既定でインメモリの偽物を持ち、ほかは
 * `overrides` で渡したメソッドだけを持つ。
 */
export function createFakeRepositories(overrides: RepoOverrides = {}): Repositories {
  return {
    auth: strictRepo('auth', { ...fakeAuthRepo(), ...overrides.auth }),
    templates: strictRepo('templates', overrides.templates ?? {}),
    parts: strictRepo('parts', overrides.parts ?? {}),
    history: strictRepo('history', overrides.history ?? {}),
    notes: strictRepo('notes', overrides.notes ?? {}),
    reviews: strictRepo('reviews', overrides.reviews ?? {}),
    users: strictRepo('users', overrides.users ?? {}),
    fundAssets: strictRepo('fundAssets', overrides.fundAssets ?? {}),
  };
}
