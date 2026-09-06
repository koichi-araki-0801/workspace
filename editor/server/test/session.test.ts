// =============================================================================
// session.test.ts — Cookie ヘッダからのセッション id 抽出(fail-closed)
// =============================================================================
// Cookie ヘッダの**全**エントリへ `decodeURIComponent` を try/catch 無しで掛けると、
// editor と無関係な壊れた cookie が 1 個混ざるだけで全 API が 500 になる。
// ここで主張するのは「攻撃者が送り込める入力で例外にならない・DB まで降りない」こと。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { SprocClient } from '../src/db/sproc.js';

// config を import する前に、データ配置先を一時ディレクトリへ逃がす。
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-session-'));
process.env.DATA_ROOT = tmp;

const callSproc = vi.fn(async (..._args: unknown[]): Promise<Record<string, unknown>[]> => []);
const sproc: SprocClient = {
  callSproc: async (proc, 操作, params) => (await callSproc(proc, 操作, params)) as never[],
};

const SID = 'a'.repeat(64);
let sessionIdFrom: (header: string | undefined) => string | undefined;
let createSessionStore: typeof import('../src/auth/session.js').createSessionStore;

beforeAll(async () => {
  ({ sessionIdFrom, createSessionStore } = await import('../src/auth/session.js'));
});

describe('sessionIdFrom', () => {
  it('reads the session cookie among unrelated ones', () => {
    expect(sessionIdFrom(`theme=dark; editor.sid=${SID}; lang=ja`)).toBe(SID);
  });

  // `Cookie: x=%; editor.sid=...` を投げるだけで全 API が 500 になっていた経路。
  it('ignores a malformed percent escape in an unrelated cookie', () => {
    expect(() => sessionIdFrom(`x=%; editor.sid=${SID}`)).not.toThrow();
    expect(sessionIdFrom(`x=%; editor.sid=${SID}`)).toBe(SID);
    expect(sessionIdFrom('x=%E0%A4%A; y=1')).toBeUndefined();
  });

  // セッション id は `randomBytes(32).toString('hex')`。形の合わない値は DB 往復の前に
  // 捨てる(ゴミ id での sproc 呼び出しと、そこで生じる応答時間差を消す)。
  it('rejects a session id that is not 64 lowercase hex characters', () => {
    for (const bad of [
      'editor.sid=short',
      `editor.sid=${'A'.repeat(64)}`,
      `editor.sid=${'a'.repeat(63)}`,
      `editor.sid=${'a'.repeat(65)}`,
      `editor.sid=${'a'.repeat(63)}g`,
      "editor.sid=' OR 1=1--",
      `editor.sid=${encodeURIComponent(SID)}%00`,
    ]) {
      expect(sessionIdFrom(bad)).toBeUndefined();
    }
  });

  // 名前一致は完全一致でなければならない。前方一致で拾うと、攻撃者が任意に立てられる
  // `editor.sid.evil` のような cookie がセッション id として読まれる。
  it('does not match a cookie whose name merely resembles the session cookie', () => {
    expect(sessionIdFrom(`editor.sidx=${SID}`)).toBeUndefined();
    expect(sessionIdFrom(`xeditor.sid=${SID}`)).toBeUndefined();
  });

  it('returns undefined for an absent or empty header', () => {
    expect(sessionIdFrom(undefined)).toBeUndefined();
    expect(sessionIdFrom('')).toBeUndefined();
    expect(sessionIdFrom('novalue')).toBeUndefined();
  });
});

// ストアは注入された実行面しか触らない(実 DB へ降りない)。`取得` は「有効なら 1 行、
// でなければ 0 行」という sproc の契約をそのまま写す形なので、Node 側は行の有無だけを見る。
describe('createSessionStore', () => {
  it('creates a 64 hex session id and passes it with the login id', async () => {
    callSproc.mockReset();
    callSproc.mockResolvedValue([]);
    const id = await createSessionStore(sproc).createSession('admin');
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    const [proc, 操作, params] = callSproc.mock.calls[0] as [string, string, { name: string }[]];
    expect(proc).toContain('セッション');
    expect(操作).toBe('作成');
    expect(params.map((x) => x.name)).toEqual(['セッションID', 'ログインID', '有効期限']);
  });

  it('returns null when the sproc yields no row (revoked or expired)', async () => {
    callSproc.mockReset();
    callSproc.mockResolvedValue([]);
    await expect(createSessionStore(sproc).getSessionUser(SID)).resolves.toBeNull();
  });

  it('passes the retention window to the purge operation', async () => {
    callSproc.mockReset();
    callSproc.mockResolvedValue([]);
    await createSessionStore(sproc).purgeExpiredSessions(3);
    expect(callSproc.mock.calls[0]?.[2]).toContainEqual({ name: '保持日数', value: 3 });
  });
});
