// =============================================================================
// changedSummary.test.ts — 申請時の変更概要(自己申告・参考情報)の計算
// =============================================================================
import { ok } from '@editor/shared';
import { describe, expect, it, vi } from 'vitest';
import { computeChangedSummaryWith } from '@/features/reviews/services/changedSummary';

const diff = {
  truncated: false,
  pages: [
    {
      blocks: [
        { key: 'note-a#1', label: 'ページ1・パーツ1', status: 'changed' },
        { key: '.x#1', label: 'ページ1・パーツ2', status: 'same' },
        { key: 'note-b#1', label: 'ページ2・パーツ1', status: 'added' },
      ],
    },
  ],
};

const deps = {
  renderAfter: vi.fn(async () => ok({ html: '<p>a</p>', css: '' })),
  renderBefore: vi.fn(async () => ok({ html: '<p>b</p>', css: '' })),
  buildHtmlDiff: vi.fn(async () => diff),
  loadNames: vi.fn(async () => new Map([['note-a', '運用実績の表']])),
};

describe('computeChangedSummaryWith', () => {
  it('変更ブロックの件数と業務名(重複除去)を返す', async () => {
    const s = await computeChangedSummaryWith(
      { templateId: 't', html: '<p>a</p>', css: '', fundCode: 'f', origin: 'edit' },
      deps,
    );
    expect(s).toEqual({ count: 2, names: ['運用実績の表', 'ページ2・パーツ1'] });
  });

  it('内部で例外が出ても null(申請を止めない)', async () => {
    const s = await computeChangedSummaryWith(
      { templateId: 't', html: '', css: '', fundCode: 'f', origin: 'edit' },
      {
        ...deps,
        buildHtmlDiff: vi.fn(async () => {
          throw new Error('x');
        }),
      },
    );
    expect(s).toBeNull();
  });
});
