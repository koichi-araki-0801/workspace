// =============================================================================
// noteBubbleLayout.test.ts — メモ吹き出しの左右判定・縦クランプ
// =============================================================================
// 吹き出しは常にページへ重ねて出す(表計算ソフトのセルコメントと同じ挙動)。左右は
// 「吹き出しが帳票の上に重なる量が少ない側」で選ぶだけで、場所を空ける処理は持たない。
import { describe, expect, it } from 'vitest';
import { computeBubbleAnchor, sameBubbleAnchor } from '@/features/editor/noteBubbleLayout';

const BUBBLE = { width: 244, height: 300 };
const CONTAINER = { width: 856, height: 700 };

describe('左右の判定', () => {
  it('パーツが右寄りなら右へ出す', () => {
    const a = computeBubbleAnchor({
      part: { left: 400, top: 100, width: 150, height: 80 },
      page: { left: 150, width: 556 },
      container: CONTAINER,
      bubble: BUBBLE,
    });
    expect(a.side).toBe('right');
  });

  it('パーツが左寄りなら左へ出す', () => {
    const a = computeBubbleAnchor({
      part: { left: 160, top: 100, width: 150, height: 80 },
      page: { left: 150, width: 556 },
      container: CONTAINER,
      bubble: BUBBLE,
    });
    expect(a.side).toBe('left');
  });

  it('ページ幅いっぱいのパーツは既定の右へ出す', () => {
    const a = computeBubbleAnchor({
      part: { left: 150, top: 100, width: 556, height: 80 },
      page: { left: 150, width: 556 },
      container: CONTAINER,
      bubble: BUBBLE,
    });
    expect(a.side).toBe('right');
  });
});

describe('重ねる位置の収まり', () => {
  it('右側はコンテナ内に収まる', () => {
    const a = computeBubbleAnchor({
      part: { left: 20, top: 100, width: 820, height: 80 },
      page: { left: 20, width: 820 },
      container: CONTAINER,
      bubble: BUBBLE,
    });
    expect(a.side).toBe('right');
    expect(a.left).toBeGreaterThanOrEqual(0);
    expect(a.left + BUBBLE.width).toBeLessThanOrEqual(CONTAINER.width);
  });

  it('左側もコンテナ内に収まる', () => {
    // パーツをページ左端に寄せて side='left' にする。
    const a = computeBubbleAnchor({
      part: { left: 20, top: 100, width: 100, height: 80 },
      page: { left: 20, width: 820 },
      container: CONTAINER,
      bubble: BUBBLE,
    });
    expect(a.side).toBe('left');
    // side='left' 分岐でも算出した位置がコンテナ内に収まることを確認する回帰テスト
    // (直前のテストは side='right' 側で同じ不変条件を確認している)。
    expect(a.left).toBeGreaterThanOrEqual(0);
    expect(a.left + BUBBLE.width).toBeLessThanOrEqual(CONTAINER.width);
  });
});

describe('縦の収まり', () => {
  it('クランプが効かない通常時は top がパーツ上端と一致する', () => {
    const a = computeBubbleAnchor({
      part: { left: 400, top: 100, width: 150, height: 80 },
      page: { left: 150, width: 556 },
      container: CONTAINER,
      bubble: BUBBLE,
    });
    // 範囲内チェックだけだと top を常に 0 で返す実装でも通ってしまうため、値そのものを固定する。
    expect(a.top).toBe(100);
  });

  it('下がはみ出すときは上へクランプする', () => {
    const a = computeBubbleAnchor({
      part: { left: 400, top: 650, width: 150, height: 80 },
      page: { left: 150, width: 556 },
      container: CONTAINER,
      bubble: BUBBLE,
    });
    expect(a.top + BUBBLE.height).toBeLessThanOrEqual(CONTAINER.height);
    expect(a.top).toBeGreaterThanOrEqual(0);
  });
});

describe('sameBubbleAnchor(参照ではなく値で比較)', () => {
  // `refreshBubbleAnchor` が「値が同じなら代入しない」を保証するための核となる関数。
  // ここが壊れると、参照が変わるだけで watcher の再発火 → 再計測が連鎖する退行が戻る。
  const base = () =>
    computeBubbleAnchor({
      part: { left: 400, top: 100, width: 150, height: 80 },
      page: { left: 150, width: 556 },
      container: CONTAINER,
      bubble: BUBBLE,
    });

  it('同じ値の別オブジェクト同士は true', () => {
    expect(sameBubbleAnchor(base(), base())).toBe(true);
  });

  it('left だけ違うものは false', () => {
    const a = base();
    const b = { ...base(), left: base().left + 1 };
    expect(sameBubbleAnchor(a, b)).toBe(false);
  });

  it('side だけ違うものは false', () => {
    const a = base();
    const b = { ...base(), side: 'left' as const };
    expect(sameBubbleAnchor(a, b)).toBe(false);
  });

  it('null と null は true', () => {
    expect(sameBubbleAnchor(null, null)).toBe(true);
  });

  it('null と値は false(両方向)', () => {
    const a = base();
    expect(sameBubbleAnchor(null, a)).toBe(false);
    expect(sameBubbleAnchor(a, null)).toBe(false);
  });
});
