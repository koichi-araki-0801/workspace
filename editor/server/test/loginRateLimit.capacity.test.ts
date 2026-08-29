// =============================================================================
// loginRateLimit.capacity.test.ts — 表が満杯でも fail open しない
// =============================================================================
// 固定長テーブルの定番の壊れ方: 上限に達したときに「最古から退避」で吸収すると、
// 退避されるのは**窓の中で数えている最中の失敗カウンタ**なので、そのキーは次の計上で
// 0 からやり直しになる。表を埋めるのは外から自由(ログインID を変えるだけ)なので、
// 洪水下ではリミッタが素通しへ倒れる。上限は「退避」ではなく「新規キーの拒否」で守る。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  beginCredentialAttempt,
  LOGIN_MAX_ENTRIES,
  LOGIN_MAX_FAILURES,
  loginAttemptEntryCount,
  resetLoginRateLimit,
  settleCredentialAttempt,
} from '../src/auth/loginRateLimit.js';

const NOW = 1_700_000_000_000;

/** 1 試行を通し切る(in-flight を残さない)。 */
function attempt(ip: string, id: string, now: number) {
  const r = beginCredentialAttempt('login', ip, id, now);
  if (r.ok) settleCredentialAttempt(r.ticket, 'failure');
  return r;
}

/** 表を上限まで埋める(別々の IP を使い、狙ったキーと衝突させない)。 */
function fillTable(now: number): void {
  let i = 0;
  while (loginAttemptEntryCount() < LOGIN_MAX_ENTRIES) {
    attempt(`10.0.${Math.floor(i / 250)}.${i % 250}`, `filler-${i}`, now);
    i += 1;
    if (i > LOGIN_MAX_ENTRIES * 2) throw new Error('表が埋まらない');
  }
}

beforeEach(() => resetLoginRateLimit());
afterEach(() => resetLoginRateLimit());

describe('上限に達した表の扱い', () => {
  it('生きているカウンタを追い出さない(埋めても既存キーの計数は続く)', async () => {
    // 対象キーを閾値の 1 歩手前まで進める。
    for (let i = 0; i < LOGIN_MAX_FAILURES; i++) {
      expect(attempt('1.2.3.4', 'victim', NOW).ok).toBe(true);
    }
    const before = loginAttemptEntryCount();
    fillTable(NOW);
    expect(loginAttemptEntryCount()).toBeGreaterThanOrEqual(before);

    // 退避方式だとここで「まだ 0 回」に戻り通ってしまう。拒否方式なら閾値超過で拒否。
    const r = attempt('1.2.3.4', 'victim', NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('LOGIN_RATE_LIMITED');
  });

  it('拒否中のキーは、表を溢れさせても解除されない', async () => {
    for (let i = 0; i <= LOGIN_MAX_FAILURES; i++) attempt('9.9.9.9', 'blocked', NOW);
    expect(attempt('9.9.9.9', 'blocked', NOW).ok).toBe(false);

    fillTable(NOW);
    const r = attempt('9.9.9.9', 'blocked', NOW);
    expect(r.ok).toBe(false);
  });

  it('満杯なら新規キーは拒否する(件数は上限を超えない)', async () => {
    fillTable(NOW);
    const r = attempt('203.0.113.9', 'newcomer', NOW);
    expect(r.ok).toBe(false);
    expect(loginAttemptEntryCount()).toBeLessThanOrEqual(LOGIN_MAX_ENTRIES);
  });

  it('窓が明けて期限切れが掃除されれば、新規キーは再び受け付けられる', async () => {
    fillTable(NOW);
    expect(attempt('203.0.113.9', 'newcomer', NOW).ok).toBe(false);
    // 窓(5 分)と拒否時間(15 分)を跨いだ時刻。満杯時は間引きを無視して掃除する。
    const later = NOW + 30 * 60_000;
    const r = attempt('203.0.113.9', 'newcomer', later);
    expect(r.ok).toBe(true);
  });
});
