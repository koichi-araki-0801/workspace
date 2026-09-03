// =============================================================================
// draftOwner.test.ts — 下書きの所属セッションの判定
// =============================================================================
// 編集セッションはブラウザタブの寿命。sessionStorage のトークンで「同じタブか」を判定し、
// 別タブ(閉じたタブ・別端末)が残した下書きは次回オープン時に破棄される側へ倒す。
import { beforeEach, describe, expect, it } from 'vitest';
import { draftOwner, sessionToken } from '@/lib/draftOwner';
import { draftOwnerKey } from '@/lib/storageKeys';

describe('draftOwner', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it('sessionToken はタブ内で安定し、sessionStorage が消える(タブを閉じる)と変わる', () => {
    const a = sessionToken();
    expect(sessionToken()).toBe(a);
    sessionStorage.clear();
    expect(sessionToken()).not.toBe(a);
  });

  it('claim した下書きは同じセッションのものとして扱う', () => {
    localStorage.setItem(draftOwnerKey(), '{}'); // 移行の猶予を消しておく(下記参照)
    expect(draftOwner.belongsToSession('t1')).toBe(false); // 記録なし = 別セッション扱い
    draftOwner.claim('t1');
    expect(draftOwner.belongsToSession('t1')).toBe(true);
  });

  it('所属キー自体が無ければ猶予として引き継ぐ(旧ビルドからの移行直後)', () => {
    // 旧ビルドは所属を記録しない。ここで破棄側へ倒すと、デプロイ後の最初のリロードで
    // 作業中の下書きが一斉に消える。猶予は 1 回限り(claim でキーが生まれる)。
    expect(localStorage.getItem(draftOwnerKey())).toBeNull();
    expect(draftOwner.belongsToSession('t1')).toBe(true);
    expect(JSON.parse(localStorage.getItem(draftOwnerKey()) ?? '{}')).toEqual({
      t1: sessionToken(),
    });
    // キーが生まれた後は通常判定 — 記録の無い別テンプレは別セッション扱いへ戻る。
    expect(draftOwner.belongsToSession('t2')).toBe(false);
  });

  it('所属キーはあるが記録が無ければ別セッション扱い', () => {
    localStorage.setItem(draftOwnerKey(), '{}');
    expect(draftOwner.belongsToSession('t1')).toBe(false);
  });

  it('タブを閉じた後(sessionStorage が消えた後)は別セッション扱いになる', () => {
    draftOwner.claim('t1');
    sessionStorage.clear();
    expect(draftOwner.belongsToSession('t1')).toBe(false);
  });

  it('release で所属の記録が消える', () => {
    draftOwner.claim('t1');
    draftOwner.claim('t2');
    draftOwner.release('t1');
    expect(draftOwner.belongsToSession('t1')).toBe(false);
    expect(draftOwner.belongsToSession('t2')).toBe(true);
    expect(JSON.parse(localStorage.getItem(draftOwnerKey()) ?? '{}')).toEqual({
      t2: sessionToken(),
    });
  });

  it('所属の記録が壊れていても例外にせず「別セッション」へ倒す', () => {
    localStorage.setItem(draftOwnerKey(), '{not json');
    expect(draftOwner.belongsToSession('t1')).toBe(false);
    draftOwner.claim('t1'); // 壊れた記録は上書きされる
    expect(draftOwner.belongsToSession('t1')).toBe(true);
  });
});
