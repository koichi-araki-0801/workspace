// =============================================================================
// password.test.ts — KDF(非同期 PBKDF2)と一時パスワード生成の単体テスト
// =============================================================================
// 守る不変則は 2 つ。(1) KDF は Promise を返す = 呼び出し側が await を落とすと型で落ちる
// (同期版はイベントループを塞ぐため復活させない)。(2) 一時パスワードは推測不能で、
// ログインID から導出されない — 導出していた頃は ID を知る者が未活性アカウントへ入れた。
import { describe, expect, it } from 'vitest';
import { generateTemporaryPassword, hashPassword, verifyPassword } from '../src/auth/password.js';

// 既定の 12 万回反復は 1 件 100ms 規模なので、単体テストでは反復数を絞って回す
// (反復数は行ごとに保存され検証時も同じ値を使うため、機能的な差は無い)。
const FAST_ITERATIONS = 1_000;

describe('hashPassword / verifyPassword', () => {
  it('accepts the original password and rejects a wrong one', async () => {
    const { hash, salt, iterations } = await hashPassword('correct horse', FAST_ITERATIONS);

    await expect(verifyPassword('correct horse', hash, salt, iterations)).resolves.toBe(true);
    await expect(verifyPassword('correct horsE', hash, salt, iterations)).resolves.toBe(false);
  });

  it('salts every call so the same password never yields the same hash', async () => {
    const a = await hashPassword('same', FAST_ITERATIONS);
    const b = await hashPassword('same', FAST_ITERATIONS);

    expect(a.salt.equals(b.salt)).toBe(false);
    expect(a.hash.equals(b.hash)).toBe(false);
  });

  it('returns false instead of throwing when the stored fields are missing', async () => {
    await expect(verifyPassword('x', null, null, null)).resolves.toBe(false);
    await expect(verifyPassword('x', Buffer.alloc(4), null, FAST_ITERATIONS)).resolves.toBe(false);
    await expect(verifyPassword('x', Buffer.alloc(4), Buffer.alloc(4), 0)).resolves.toBe(false);
  });

  it('round-trips with the production iteration count (default argument)', async () => {
    // 反復数を省略した既定経路。実運用と同じ 12 万回で 1 往復だけ確認する。
    const { hash, salt, iterations } = await hashPassword('default-iterations');
    expect(iterations).toBe(120_000);
    await expect(verifyPassword('default-iterations', hash, salt, iterations)).resolves.toBe(true);
  });

  it('hashes off the event loop (returns a Promise, not a value)', async () => {
    // 同期版へ戻すとここが落ちる。await 忘れを型と実行時の両方で検出する。
    const pending = hashPassword('x', FAST_ITERATIONS);
    expect(pending).toBeInstanceOf(Promise);
    await pending;
  });
});

describe('generateTemporaryPassword', () => {
  it('emits 12 characters from the unambiguous alphabet only', () => {
    for (let i = 0; i < 50; i += 1) {
      const pw = generateTemporaryPassword();
      expect(pw).toHaveLength(12);
      // 誤読しやすい 0 / O / 1 / I / l と小文字は含まない。
      expect(pw).toMatch(/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{12}$/);
    }
  });

  it('never repeats across calls (CSPRNG, not a derived constant)', () => {
    const issued = new Set(Array.from({ length: 200 }, () => generateTemporaryPassword()));
    expect(issued.size).toBe(200);
  });
});
