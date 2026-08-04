// =============================================================================
// loginRateLimit.test.ts — 資格情報試行レート制限(予約方式)の単体テスト
// =============================================================================
// 時刻は全て引数で注入し、実時間に依存させない(タイマーのフェイク不要・並列実行でも安定)。
// 主張はすべて「攻撃者の入力・状態で失敗すること」の形にする — 前回のテストは正常系
// (正しい入力で通る)に寄っていて、判定と計上を分けたことによる素通しを検出できなかった。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { canonicalLoginId } from '../src/auth/loginId.js';
import {
  beginCredentialAttempt,
  IP_MAX_ATTEMPTS,
  LOGIN_BUSY_CODE,
  LOGIN_MAX_ENTRIES,
  LOGIN_MAX_FAILURES,
  LOGIN_RATE_LIMITED_CODE,
  loginAttemptEntryCount,
  loginInFlightCount,
  MAX_CONCURRENT_ATTEMPTS,
  resetLoginRateLimit,
  settleCredentialAttempt,
} from '../src/auth/loginRateLimit.js';

const T0 = 1_700_000_000_000;
const MINUTE = 60_000;
const IP = '10.0.0.1';

beforeEach(() => resetLoginRateLimit());

/** 1 試行を通して即 settle する(ゲージを埋めずに回数だけ消費する定型)。 */
function attempt(loginId: string, now: number, ip: string | undefined = IP): boolean {
  const r = beginCredentialAttempt('login', ip, canonicalLoginId(loginId), now);
  if (r.ok) settleCredentialAttempt(r.ticket, 'failure');
  return r.ok;
}

describe('beginCredentialAttempt — 予約方式', () => {
  // 本命。判定と計上が別タイミングだった頃は、settle せずに 20 回呼んでも全部 ok になった
  // (実運用では同一 tick に到着した N 本がすべて「まだ 0 回」を読んで素通しした)。
  it('charges the counter before returning, so a burst of N never exceeds the threshold', () => {
    const tickets = [];
    for (let i = 0; i < 20; i += 1) {
      const r = beginCredentialAttempt('login', IP, 'admin', T0);
      if (r.ok) tickets.push(r.ticket);
    }
    // 同時実行ゲージ(第 3 段)のほうが先に効くので、通るのは高々その本数。
    expect(tickets.length).toBe(MAX_CONCURRENT_ATTEMPTS);
    for (const t of tickets) settleCredentialAttempt(t, 'failure');
    // ゲージを空けても、既に計上済みの回数は戻らない。
    expect(loginInFlightCount()).toBe(0);
  });

  it('allows attempts up to the threshold and blocks the next one', () => {
    for (let i = 0; i < LOGIN_MAX_FAILURES; i += 1) expect(attempt('admin', T0)).toBe(true);

    const r = beginCredentialAttempt('login', IP, 'admin', T0);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatchObject({ kind: 'forbidden', code: LOGIN_RATE_LIMITED_CODE });
    expect(r.error.message).toContain('ログイン試行が多すぎます');
  });

  // DB の `Japanese_CI_AS` は大小・幅を区別せず末尾空白を無視し、65 文字目以降は切り詰める。
  // JS 側のキーがこれとずれると、同じ 1 アカウントに独立したカウンタをいくつでも作れる。
  it('folds the login id the same way the database does', () => {
    for (let i = 0; i < LOGIN_MAX_FAILURES; i += 1) attempt('admin', T0);

    for (const variant of ['ADMIN', 'admin ', 'ａｄｍｉｎ', 'Admin　']) {
      expect(attempt(variant, T0)).toBe(false);
    }
    // 64 文字目まで同じなら DB も同一行に当たるので、キーも同一でなければならない。
    const long = 'a'.repeat(64);
    for (let i = 0; i < LOGIN_MAX_FAILURES; i += 1) attempt(long, T0);
    expect(attempt(`${long}b`, T0)).toBe(false);
  });

  it('does not punish a different IP or a different login id', () => {
    for (let i = 0; i < LOGIN_MAX_FAILURES; i += 1) attempt('admin', T0);

    expect(attempt('admin', T0, '10.0.0.2')).toBe(true);
    expect(attempt('editor', T0)).toBe(true);
  });

  // 第 1 段は (IP, ログインID) の組なので、アカウントを変えながら 1 回ずつ試すスプレーは
  // どのキーも閾値へ届かない。第 2 段(IP 窓)が無いとこれが無制限に通る。
  it('spreads across login ids but still trips the per-IP window', () => {
    let allowed = 0;
    for (let i = 0; i < IP_MAX_ATTEMPTS + 20; i += 1) {
      if (attempt(`user${i}`, T0)) allowed += 1;
    }
    expect(allowed).toBe(IP_MAX_ATTEMPTS);
    expect(attempt('anyone-else', T0)).toBe(false);
  });

  // 対称にすると、有効な資格情報を 1 つ持つ攻撃者が自分のログイン成功を挟むだけで
  // IP 上限をリセットでき、スプレーが素通しになる。
  it('does not let a successful login clear the per-IP window', () => {
    for (let i = 0; i < IP_MAX_ATTEMPTS - 1; i += 1) attempt(`user${i}`, T0);
    const mine = beginCredentialAttempt('login', IP, 'mine', T0);
    expect(mine.ok).toBe(true);
    if (mine.ok) settleCredentialAttempt(mine.ticket, 'success');

    // 成功で消えるのは自分の第 1 段だけ。IP 窓は残っているので次で上限に達する。
    expect(attempt('someone', T0)).toBe(false);
  });

  it('forgets the per-id failures of a successful login', () => {
    for (let i = 0; i < LOGIN_MAX_FAILURES - 1; i += 1) attempt('admin', T0);
    const ok = beginCredentialAttempt('login', IP, 'admin', T0);
    expect(ok.ok).toBe(true);
    if (ok.ok) settleCredentialAttempt(ok.ticket, 'success');

    for (let i = 0; i < LOGIN_MAX_FAILURES; i += 1) expect(attempt('admin', T0)).toBe(true);
  });

  it('lifts the block once the wait has elapsed', () => {
    for (let i = 0; i < LOGIN_MAX_FAILURES + 1; i += 1) attempt('admin', T0);

    expect(attempt('admin', T0 + 14 * MINUTE)).toBe(false);
    expect(attempt('admin', T0 + 16 * MINUTE)).toBe(true);
  });

  it('restarts counting after the window, so slow typos never accumulate into a block', () => {
    for (let i = 0; i < LOGIN_MAX_FAILURES; i += 1) attempt('admin', T0 + i * MINUTE);
    expect(attempt('admin', T0 + 30 * MINUTE)).toBe(true);
  });

  it('separates the login and init-password scopes', () => {
    for (let i = 0; i < LOGIN_MAX_FAILURES + 1; i += 1) attempt('admin', T0);
    expect(beginCredentialAttempt('init-password', IP, 'admin', T0).ok).toBe(true);
  });

  it('defaults the clock to now when the caller omits it (production call shape)', () => {
    for (let i = 0; i < LOGIN_MAX_FAILURES; i += 1) {
      const r = beginCredentialAttempt('login', IP, 'admin');
      expect(r.ok).toBe(true);
      if (r.ok) settleCredentialAttempt(r.ticket, 'failure');
    }
    expect(beginCredentialAttempt('login', IP, 'admin').ok).toBe(false);
  });
});

describe('同時実行ゲージ(第 3 段)', () => {
  it('rejects immediately when the in-flight gauge is full', () => {
    const tickets = [];
    for (let i = 0; i < MAX_CONCURRENT_ATTEMPTS; i += 1) {
      const r = beginCredentialAttempt('login', `10.1.0.${i}`, `user${i}`, T0);
      expect(r.ok).toBe(true);
      if (r.ok) tickets.push(r.ticket);
    }
    const overflow = beginCredentialAttempt('login', '10.1.9.9', 'other', T0);
    expect(overflow.ok).toBe(false);
    if (!overflow.ok) expect(overflow.error.code).toBe(LOGIN_BUSY_CODE);

    for (const t of tickets) settleCredentialAttempt(t, 'failure');
    expect(loginInFlightCount()).toBe(0);
    expect(beginCredentialAttempt('login', '10.1.9.9', 'other', T0).ok).toBe(true);
  });

  it('releases the gauge on both outcomes', () => {
    const a = beginCredentialAttempt('login', IP, 'a', T0);
    const b = beginCredentialAttempt('login', IP, 'b', T0);
    expect(loginInFlightCount()).toBe(2);
    if (a.ok) settleCredentialAttempt(a.ticket, 'success');
    if (b.ok) settleCredentialAttempt(b.ticket, 'failure');
    expect(loginInFlightCount()).toBe(0);
  });

  // settle を呼ばない経路が 1 つでもあるとゲージがリークし、数本で全ログインが恒久的に
  // 拒否される(自己 DoS)。時刻ベースの保険が効いていることを固定する。
  it('auto-releases a leaked in-flight entry after its TTL', () => {
    for (let i = 0; i < MAX_CONCURRENT_ATTEMPTS; i += 1) {
      beginCredentialAttempt('login', `10.2.0.${i}`, `user${i}`, T0);
    }
    expect(beginCredentialAttempt('login', '10.2.9.9', 'x', T0).ok).toBe(false);
    expect(beginCredentialAttempt('login', '10.2.9.9', 'x', T0 + 5 * MINUTE).ok).toBe(true);
  });
});

describe('表の上限と掃除', () => {
  // 期限切れ掃除だけでは件数の上限にならない(窓の 5 分間はどれも消せない)。毎回違う
  // ログインID を送るだけで表が伸びるため、ハードキャップと退避順を対で固定する。
  it('caps the table size and keeps a live block while evicting', () => {
    for (let i = 0; i < LOGIN_MAX_FAILURES + 1; i += 1) attempt('victim', T0);
    // 未認証でできる操作(違う IP・違う ID で失敗し続ける)だけで上限を溢れさせる。
    for (let i = 0; i < LOGIN_MAX_ENTRIES + 100; i += 1) {
      attempt(`flood${i}`, T0 + 1, `10.9.${(i >> 8) & 255}.${i & 255}`);
    }
    // 退避は呼び出しごとに走るが、1 回の `begin` は IP キーと ID キーの 2 件を足しうる。
    // よって観測値の上限は「キャップ + 2」で、件数が要求レートに比例して伸びることはない。
    expect(loginAttemptEntryCount()).toBeLessThanOrEqual(LOGIN_MAX_ENTRIES + 2);
    // 溢れさせた側にブロックを流させない(拒否中のエントリは最後まで残す)。
    expect(attempt('victim', T0 + 2)).toBe(false);
  });

  // 上限に張り付いた状態で毎回全件 sort すると、未認証リクエスト 1 本あたりの同期時間が
  // 件数に比例して伸びる。O(1) の最古退避で吸収していることを、粗い時間比較で固定する。
  it('keeps the eviction cost flat once the table is saturated', () => {
    for (let i = 0; i < LOGIN_MAX_ENTRIES; i += 1) {
      attempt(`seed${i}`, T0, `10.8.${(i >> 8) & 255}.${i & 255}`);
    }
    const started = performance.now();
    for (let i = 0; i < 5_000; i += 1) {
      attempt(`more${i}`, T0, `10.7.${(i >> 8) & 255}.${i & 255}`);
    }
    // sort 方式なら 5,000 x O(n log n) で桁違いに遅くなる。閾値はゆるく取る。
    expect(performance.now() - started).toBeLessThan(3_000);
    expect(loginAttemptEntryCount()).toBeLessThanOrEqual(LOGIN_MAX_ENTRIES + 2);
  });
});

// 構造テスト。判定区間へ await が入った瞬間に「読んで・通してから・後で数える」形へ戻り、
// 並行リクエストが素通しする(この module の最重要の不変条件)。粗いが、再来を機械的に
// 止める唯一の安価な手段。
describe('判定区間の同期性', () => {
  it('never introduces an await into the decision path', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const src = fs.readFileSync(path.join(here, '../src/auth/loginRateLimit.ts'), 'utf8');
    const code = src
      .split('\n')
      .filter((line) => {
        const t = line.trim();
        return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
      })
      .join('\n');
    expect(code).not.toMatch(/\basync\b/);
    expect(code).not.toMatch(/\bawait\b/);
    expect(code).not.toMatch(/\bPromise\b/);
  });

  // キーの素材は `request.ip`。Fastify の `trustProxy` を有効にすると、これが
  // `X-Forwarded-For` = 攻撃者が任意に書けるヘッダから導出されるようになり、3 段すべての
  // キーが攻撃者の自由になる = レート制限が完全消滅する。リバースプロキシ配備のために
  // 足す日が来たら、信頼するプロキシを明示列挙したうえで本テストを更新すること。
  it('never enables trustProxy, which would put the rate-limit keys under attacker control', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const src = fs.readFileSync(path.join(here, '../src/app.ts'), 'utf8');
    expect(src).not.toMatch(/\btrustProxy\b/);
  });
});
