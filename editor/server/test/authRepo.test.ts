// =============================================================================
// authRepo.test.ts — 資格情報検証の応答を揃える(存在オラクルの封じ込め)
// =============================================================================
// 以前は未知 ID と無効アカウントで**文言が違い**、しかもどちらも KDF より前で return して
// いた。文言を揃えるだけでは足りない — 「KDF を回したかどうか」の分岐が残っている限り
// 応答時間が second channel になる。ここで主張するのは
//   1. 未知 ID / 無効アカウント / パスワード誤り の 3 分岐が同一の kind + message を返す
//   2. どの分岐でも `verifyPassword` の呼び出し回数(= KDF の有無)が同じ
//   3. パスワード変更は「除外セッションID」を sproc へ渡す(旧セッションの失効は sproc 内)
// の 3 点。
import { beforeEach, describe, expect, it, vi } from 'vitest';

const callSproc = vi.fn(async (..._args: unknown[]): Promise<Record<string, unknown>[]> => []);
const verifyPassword = vi.fn(async (): Promise<boolean> => true);
const createSession = vi.fn(async () => 'sid');

vi.mock('../src/db/sproc.js', () => ({
  callSproc: (...args: unknown[]) => callSproc(...args),
  firstRow: (rows: Record<string, unknown>[]) => rows[0],
  p: (name: string, value: unknown) => ({ name, value }),
  asBool: (v: unknown) => v === true || v === 1,
  asBuffer: () => Buffer.alloc(0),
  asNumberOrNull: () => 120_000,
  asString: (v: unknown) => (v == null ? '' : String(v)),
}));

vi.mock('../src/auth/password.js', () => ({
  verifyPassword: (...args: unknown[]) => verifyPassword(...(args as [])),
  hashPassword: vi.fn(async () => ({
    hash: Buffer.alloc(0),
    salt: Buffer.alloc(0),
    iterations: 1,
  })),
}));

vi.mock('../src/auth/session.js', () => ({
  createSession: (...args: unknown[]) => createSession(...(args as [])),
  destroySession: vi.fn(async () => {}),
}));

const row = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  公開ID: 'u1',
  ログインID: 'admin',
  表示名: 'admin',
  ロール: 'admin',
  無効: false,
  要パスワード変更: false,
  PWハッシュ: Buffer.alloc(0),
  PWソルト: Buffer.alloc(0),
  PW反復回数: 120_000,
  ...overrides,
});

beforeEach(() => {
  callSproc.mockReset();
  verifyPassword.mockReset();
  verifyPassword.mockResolvedValue(true);
});

describe('login の失敗応答', () => {
  /** 3 通りの失敗を作り、投げられた error と KDF 回数を集める。 */
  async function failuresOf(): Promise<Array<{ error: unknown; kdfCalls: number; label: string }>> {
    const { login } = await import('../src/repositories/authRepo.js');
    const scenarios: Array<[string, () => void]> = [
      [
        '未知 ID',
        () => {
          callSproc.mockResolvedValue([]);
          verifyPassword.mockResolvedValue(true);
        },
      ],
      [
        '無効アカウント',
        () => {
          callSproc.mockResolvedValue([row({ 無効: true })]);
          verifyPassword.mockResolvedValue(true);
        },
      ],
      [
        'パスワード誤り',
        () => {
          callSproc.mockResolvedValue([row()]);
          verifyPassword.mockResolvedValue(false);
        },
      ],
    ];
    const out = [];
    for (const [label, setup] of scenarios) {
      verifyPassword.mockClear();
      setup();
      let error: unknown;
      await login('admin', 'pw').catch((e) => {
        error = e;
      });
      out.push({ error, kdfCalls: verifyPassword.mock.calls.length, label });
    }
    return out;
  }

  it('answers with the same kind and message for unknown, disabled and wrong password', async () => {
    const results = await failuresOf();
    for (const r of results) {
      expect(r.error, r.label).toMatchObject({
        kind: 'unauthorized',
        message: 'ユーザーIDまたはパスワードが違います',
      });
      // `code` が付くと errorHandler がボディへ載せ、そこが判別面になる。
      expect((r.error as { code?: string }).code, r.label).toBeUndefined();
    }
  });

  // 無効アカウントを KDF の前で return すると、正当な ID だけが 60ms を払う形が残り、
  // 文言を揃えても応答時間で判別できる。実在する行に対しては必ず KDF を通す。
  it('does not short-circuit a disabled account before the KDF', async () => {
    const [unknown, disabled, wrong] = await failuresOf();
    expect(unknown.kdfCalls).toBe(0); // 行が無ければ検証しようがない(時間差はルート側のフロアが吸収)
    expect(disabled.kdfCalls).toBe(1);
    expect(wrong.kdfCalls).toBe(1);
  });

  it('opens a session only when everything checks out', async () => {
    const { login } = await import('../src/repositories/authRepo.js');
    createSession.mockClear();
    callSproc.mockResolvedValue([row()]);
    verifyPassword.mockResolvedValue(true);
    const { result } = await login('admin', 'pw');
    expect(result.user.username).toBe('admin');
    expect(createSession).toHaveBeenCalledWith('admin');
  });
});

describe('initPassword', () => {
  it('uses the same message for unknown, disabled and wrong current password', async () => {
    const { initPassword } = await import('../src/repositories/authRepo.js');
    const req = { currentPassword: 'x', newPassword: 'new-password' };
    for (const setup of [
      () => callSproc.mockResolvedValue([]),
      () => callSproc.mockResolvedValue([row({ 無効: true })]),
      () => {
        callSproc.mockResolvedValue([row()]);
        verifyPassword.mockResolvedValue(false);
      },
    ]) {
      verifyPassword.mockResolvedValue(true);
      setup();
      await expect(initPassword('admin', req)).rejects.toMatchObject({
        kind: 'unauthorized',
        message: 'ユーザーIDまたはパスワードが違います',
      });
    }
  });

  // 旧セッションの失効はパスワード列の UPDATE と同一トランザクションで行う(sproc 内)。
  // Node 側が「除外するセッション」を渡さないと、変更した本人まで蹴られる。
  it('passes the session to keep alive through to the sproc', async () => {
    const { initPassword } = await import('../src/repositories/authRepo.js');
    callSproc.mockResolvedValue([row()]);
    verifyPassword.mockResolvedValue(true);
    callSproc.mockClear();
    await initPassword('admin', { currentPassword: 'x', newPassword: 'new-password' }, 'sid-1');

    const update = callSproc.mock.calls.find((c) => c[1] === 'PW初期化');
    expect(update).toBeDefined();
    expect(update?.[2]).toContainEqual({ name: '除外セッションID', value: 'sid-1' });
  });

  it('rejects a new password that is only whitespace', async () => {
    const { initPassword } = await import('../src/repositories/authRepo.js');
    callSproc.mockResolvedValue([row()]);
    verifyPassword.mockResolvedValue(true);
    await expect(
      initPassword('admin', { currentPassword: 'x', newPassword: '            ' }),
    ).rejects.toMatchObject({ kind: 'validation' });
  });
});
