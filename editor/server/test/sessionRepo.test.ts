// =============================================================================
// sessionRepo.test.ts — セッション repo が sproc の操作名・引数と戻りをどう写すか
// =============================================================================
// 操作名は本番の定数を読まず文字列で書く。定数を書き間違えても、ここが同じ間違いを
// 写さないようにするため。
import { describe, expect, it, vi } from 'vitest';
import type { Param, Row, SprocClient } from '../src/db/sproc.js';
import { SP } from '../src/db/sprocNames.js';
import { createSessionRepo } from '../src/repositories/sessionRepo.js';

type Call = [proc: string, 操作: string, params: Param[]];

function stub(rows: Row[] = []): { sproc: SprocClient; callSproc: ReturnType<typeof vi.fn> } {
  const callSproc = vi.fn(async (..._a: Call): Promise<Row[]> => rows);
  const sproc = {
    callSproc: (proc: string, 操作: string, params: Param[] = []) => callSproc(proc, 操作, params),
  } as unknown as SprocClient;
  return { sproc, callSproc };
}

const onlyCall = (callSproc: ReturnType<typeof vi.fn>): Call => {
  expect(callSproc).toHaveBeenCalledTimes(1);
  return callSproc.mock.calls[0] as Call;
};

describe('sessionRepo', () => {
  it('insertSession は `作成` へセッションID・ログインID・有効期限を渡す', async () => {
    const { sproc, callSproc } = stub();
    const expiresAt = new Date('2026-11-02T00:00:00Z');
    await createSessionRepo(sproc).insertSession('sid', 'admin', expiresAt);

    const [proc, 操作, params] = onlyCall(callSproc);
    expect(proc).toBe(SP.session);
    expect(操作).toBe('作成');
    expect(params.map((x) => x.name)).toEqual(['セッションID', 'ログインID', '有効期限']);
    expect(params.find((x) => x.name === '有効期限')?.value).toBe(expiresAt);
  });

  it('findSessionUser は 0 行なら null を返す', async () => {
    const { sproc, callSproc } = stub([]);
    await expect(createSessionRepo(sproc).findSessionUser('sid')).resolves.toBeNull();

    const [proc, 操作, params] = onlyCall(callSproc);
    expect(proc).toBe(SP.session);
    expect(操作).toBe('取得');
    expect(params).toEqual([{ name: 'セッションID', value: 'sid' }]);
  });

  it('findSessionUser は 1 行を User へ写す', async () => {
    const { sproc } = stub([
      {
        公開ID: 'u1',
        ログインID: 'admin',
        表示名: '管理者',
        ロール: 'admin',
        無効: false,
        要パスワード変更: false,
      },
    ]);
    await expect(createSessionRepo(sproc).findSessionUser('sid')).resolves.toEqual({
      id: 'u1',
      username: 'admin',
      displayName: '管理者',
      role: 'admin',
      disabled: false,
      mustChangePassword: false,
    });
  });

  // DB の失敗を null(未ログイン扱い)へ潰すと、障害が「全員ログアウト」に見えてしまう。
  it('findSessionUser は sproc の失敗を同じエラーで返す', async () => {
    const { sproc, callSproc } = stub();
    const err = new Error('DB 停止中');
    callSproc.mockRejectedValueOnce(err);
    await expect(createSessionRepo(sproc).findSessionUser('sid')).rejects.toBe(err);
  });

  it('revokeSession は `失効` へセッションIDを渡す', async () => {
    const { sproc, callSproc } = stub();
    await createSessionRepo(sproc).revokeSession('sid');

    const [proc, 操作, params] = onlyCall(callSproc);
    expect(proc).toBe(SP.session);
    expect(操作).toBe('失効');
    expect(params).toEqual([{ name: 'セッションID', value: 'sid' }]);
  });

  it('revokeAllSessions は `全失効` を引数なしで呼ぶ', async () => {
    const { sproc, callSproc } = stub();
    await createSessionRepo(sproc).revokeAllSessions();

    const [proc, 操作, params] = onlyCall(callSproc);
    expect(proc).toBe(SP.session);
    expect(操作).toBe('全失効');
    expect(params).toEqual([]);
  });

  it('purgeSessions は `掃除` へ保持日数を渡す', async () => {
    const { sproc, callSproc } = stub();
    await createSessionRepo(sproc).purgeSessions(3);

    const [proc, 操作, params] = onlyCall(callSproc);
    expect(proc).toBe(SP.session);
    expect(操作).toBe('掃除');
    expect(params).toEqual([{ name: '保持日数', value: 3 }]);
  });
});
