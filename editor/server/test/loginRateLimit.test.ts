// =============================================================================
// loginRateLimit.test.ts — ログイン試行レート制限の単体テスト
// =============================================================================
// 時刻は全て引数で注入し、実時間に依存させない(タイマーのフェイク不要・並列実行でも安定)。
// 守るのは「閾値まで通し、超えたら拒否し、成功と時間経過で解ける」ことと、
// 期限切れエントリが掃除されて無制限に貯まらないこと。
import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearLoginFailures,
  LOGIN_MAX_ENTRIES,
  LOGIN_MAX_FAILURES,
  LOGIN_RATE_LIMITED_CODE,
  loginAttemptEntryCount,
  loginAttemptKey,
  loginRateLimitRejection,
  recordLoginFailure,
  resetLoginRateLimit,
} from '../src/auth/loginRateLimit.js';

const T0 = 1_700_000_000_000;
const MINUTE = 60_000;
const KEY = loginAttemptKey('10.0.0.1', 'admin');

beforeEach(() => resetLoginRateLimit());

describe('loginAttemptKey', () => {
  it('separates by IP and by login id, and folds case', () => {
    expect(loginAttemptKey('10.0.0.1', 'admin')).not.toBe(loginAttemptKey('10.0.0.2', 'admin'));
    expect(loginAttemptKey('10.0.0.1', 'admin')).not.toBe(loginAttemptKey('10.0.0.1', 'editor'));
    expect(loginAttemptKey('10.0.0.1', 'ADMIN')).toBe(loginAttemptKey('10.0.0.1', 'admin'));
  });

  it('still produces a key when the IP is unknown', () => {
    expect(loginAttemptKey(undefined, 'admin')).toContain('unknown');
  });

  // ログインID に長さ制約は無く(実効上限はボディ上限の 8MB)、失敗は必ず記録される。
  // 生のまま鍵にすると、未認証リクエストだけでキー長 x 件数のメモリを伸ばせる。
  it('keeps the key bounded however long the login id is', () => {
    const huge = 'a'.repeat(100_000);
    const key = loginAttemptKey('10.0.0.1', huge);
    expect(key.length).toBeLessThan(128);
    expect(key).not.toContain('aaaaaaaaaa');
    // 畳んでも別IDと混ざらない。
    expect(loginAttemptKey('10.0.0.1', `${huge}b`)).not.toBe(key);
  });
});

describe('loginRateLimitRejection', () => {
  it('allows attempts up to the threshold and blocks the next one', () => {
    for (let i = 0; i < LOGIN_MAX_FAILURES - 1; i += 1) {
      expect(loginRateLimitRejection(KEY, T0)).toBeNull();
      recordLoginFailure(KEY, T0);
    }
    // 最後の 1 回はまだ通り、その失敗で閾値に達する。
    expect(loginRateLimitRejection(KEY, T0)).toBeNull();
    recordLoginFailure(KEY, T0);

    const rejection = loginRateLimitRejection(KEY, T0);
    expect(rejection).toMatchObject({ kind: 'forbidden', code: LOGIN_RATE_LIMITED_CODE });
    expect(rejection?.message).toContain('ログイン試行が多すぎます');
  });

  it('does not punish a different IP or a different login id', () => {
    for (let i = 0; i < LOGIN_MAX_FAILURES; i += 1) recordLoginFailure(KEY, T0);

    expect(loginRateLimitRejection(loginAttemptKey('10.0.0.2', 'admin'), T0)).toBeNull();
    expect(loginRateLimitRejection(loginAttemptKey('10.0.0.1', 'editor'), T0)).toBeNull();
  });

  it('lifts the block once the wait has elapsed', () => {
    for (let i = 0; i < LOGIN_MAX_FAILURES; i += 1) recordLoginFailure(KEY, T0);

    expect(loginRateLimitRejection(KEY, T0 + 14 * MINUTE)).not.toBeNull();
    expect(loginRateLimitRejection(KEY, T0 + 16 * MINUTE)).toBeNull();
  });

  it('restarts counting after the window, so slow typos never accumulate into a block', () => {
    for (let i = 0; i < LOGIN_MAX_FAILURES - 1; i += 1) recordLoginFailure(KEY, T0 + i * MINUTE);
    // 窓(5 分)を跨いだ失敗は数え直し。ここで閾値に届いてはいけない。
    recordLoginFailure(KEY, T0 + 30 * MINUTE);

    expect(loginRateLimitRejection(KEY, T0 + 30 * MINUTE)).toBeNull();
  });

  it('defaults the clock to now when the caller omits it (production call shape)', () => {
    // 本番の呼び出しは時刻を渡さない。既定引数の経路も踏んでおく。
    expect(loginRateLimitRejection(KEY)).toBeNull();
    for (let i = 0; i < LOGIN_MAX_FAILURES; i += 1) recordLoginFailure(KEY);
    expect(loginRateLimitRejection(KEY)).not.toBeNull();
  });

  it('forgets the failures of a successful login', () => {
    for (let i = 0; i < LOGIN_MAX_FAILURES - 1; i += 1) recordLoginFailure(KEY, T0);
    clearLoginFailures(KEY);
    recordLoginFailure(KEY, T0);

    expect(loginRateLimitRejection(KEY, T0)).toBeNull();
  });

  // 期限切れ掃除だけでは件数の上限にならない(窓の 5 分間はどれも消せない)。毎回違う
  // ログインID を送るだけで表が伸びるため、ハードキャップと退避順を対で固定する。
  it('caps the table size and keeps a live block while evicting', () => {
    const victim = loginAttemptKey('10.0.0.1', 'victim');
    for (let i = 0; i < LOGIN_MAX_FAILURES; i += 1) recordLoginFailure(victim, T0);

    // 未認証でできる操作(違う ID で失敗し続ける)だけで上限を溢れさせる。
    for (let i = 0; i < LOGIN_MAX_ENTRIES + 100; i += 1) {
      recordLoginFailure(loginAttemptKey('10.0.0.2', `flood${i}`), T0 + 1);
    }
    expect(loginAttemptEntryCount()).toBeGreaterThan(LOGIN_MAX_ENTRIES);

    // 掃除は判定時に走る。期限切れは 1 件も無いが、件数上限で古い順に削られる。
    const rejection = loginRateLimitRejection(victim, T0 + 2);
    expect(loginAttemptEntryCount()).toBeLessThanOrEqual(LOGIN_MAX_ENTRIES);
    // 溢れさせた側にブロックを流させない(拒否中のエントリは最後まで残す)。
    expect(rejection).not.toBeNull();
  });

  it('prunes expired entries without dropping a live block', () => {
    const ghost = loginAttemptKey('10.0.0.9', 'ghost');
    for (let i = 0; i < LOGIN_MAX_FAILURES; i += 1) recordLoginFailure(ghost, T0);

    // 1 回目の判定で掃除が走る(まだ窓の中なのでブロックは残る)。
    expect(loginRateLimitRejection(ghost, T0)).not.toBeNull();
    // 掃除間隔(1 分)以内の連打では掃除を間引く。ブロック判定は変わらない。
    expect(loginRateLimitRejection(ghost, T0 + 1)).not.toBeNull();
    // 掃除間隔とブロック時間の両方を跨ぐと、期限切れエントリは捨てられる。
    expect(loginRateLimitRejection(ghost, T0 + 30 * MINUTE)).toBeNull();
    recordLoginFailure(ghost, T0 + 30 * MINUTE);
    // 捨てた後は数え直しなので、1 回の失敗で再ブロックされることはない。
    expect(loginRateLimitRejection(ghost, T0 + 30 * MINUTE)).toBeNull();
  });
});
