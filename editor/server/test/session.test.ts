// =============================================================================
// session.test.ts — Cookie ヘッダからのセッション id 抽出(fail-closed)
// =============================================================================
// 以前は Cookie ヘッダの**全**エントリへ `decodeURIComponent` を try/catch 無しで掛けて
// いたため、editor と無関係な壊れた cookie が 1 個混ざるだけで全 API が 500 になった。
// ここで主張するのは「攻撃者が送り込める入力で例外にならない・DB まで降りない」こと。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';

// config を import する前に、データ配置先を一時ディレクトリへ逃がす。
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-session-'));
process.env.DATA_ROOT = tmp;

const callSproc = vi.fn(async () => []);
vi.mock('../src/db/sproc.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/db/sproc.js')>();
  return { ...actual, callSproc: (...args: unknown[]) => callSproc(...(args as [])) };
});

const SID = 'a'.repeat(64);
let sessionIdFrom: (header: string | undefined) => string | undefined;

beforeAll(async () => {
  ({ sessionIdFrom } = await import('../src/auth/session.js'));
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
