import { describe, expect, it } from 'vitest';
import { restartEnded } from '@/lib/appEpoch';

// restartEnded: 「サーバ/dev 再起動でセッションが切れた」かの表示判定(§5)。純粋関数なので
// document 非依存で全分岐を直接検証する。
describe('restartEnded', () => {
  it('未認証で epoch が変わっていれば再起動切断 = true', () => {
    expect(restartEnded('e1', 'e2', false)).toBe(true);
  });

  it('認証済みなら false(まだログイン中)', () => {
    expect(restartEnded('e1', 'e2', true)).toBe(false);
  });

  it('直前マーカーが無い初回訪問は false', () => {
    expect(restartEnded(null, 'e2', false)).toBe(false);
  });

  it('epoch 一致(同一起動中の手動/TTL 失効など)は false', () => {
    expect(restartEnded('e1', 'e1', false)).toBe(false);
  });
});
