// =============================================================================
// noteBubbleLayout.test.ts — メモ吹き出しの左右判定・重ね・縦クランプ
// =============================================================================
// 吹き出しは「リーダー線が帳票を横切る量が少ない側」へ出し、その反対へページを寄せて
// 場所を作る。寄せても幅が足りなければページに重ねる(ページの大きさは変えない)。
import { describe, expect, it } from 'vitest';
import { computeBubbleAnchor } from '@/features/editor/noteBubbleLayout';

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

describe('場所が足りないとき', () => {
  it('寄せれば入るなら重ねない', () => {
    const a = computeBubbleAnchor({
      part: { left: 150, top: 100, width: 556, height: 80 },
      page: { left: 150, width: 556 },
      container: CONTAINER,
      bubble: BUBBLE,
    });
    // 856 - 556 = 300 >= 244 なので、ページを左端へ寄せれば収まる。
    expect(a.overlap).toBe(false);
  });

  it('ページがコンテナ幅に近いときは重ねる', () => {
    const a = computeBubbleAnchor({
      part: { left: 20, top: 100, width: 820, height: 80 },
      page: { left: 20, width: 820 },
      container: CONTAINER,
      bubble: BUBBLE,
    });
    // 856 - 820 = 36 < 244。ページは縮めないので吹き出しを重ねる。
    expect(a.overlap).toBe(true);
    // 重ねる位置はコンテナ内に収まる。
    expect(a.left).toBeGreaterThanOrEqual(0);
    expect(a.left + BUBBLE.width).toBeLessThanOrEqual(CONTAINER.width);
  });
});

describe('縦の収まり', () => {
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

  it('リーダーはパーツの縦中心から引く', () => {
    const a = computeBubbleAnchor({
      part: { left: 400, top: 100, width: 150, height: 80 },
      page: { left: 150, width: 556 },
      container: CONTAINER,
      bubble: BUBBLE,
    });
    expect(a.leader.top).toBe(140);
    expect(a.leader.left).toBe(550);
    expect(a.leader.width).toBeGreaterThan(0);
  });
});
