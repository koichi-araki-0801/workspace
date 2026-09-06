// =============================================================================
// reviewPartMaps.test.ts — 承認タブのコメント宛先パーツ算出
// =============================================================================
import { describe, expect, it } from 'vitest';
import { partMapsFromHtml } from '@/features/reviews/reviewPartMaps';

describe('partMapsFromHtml', () => {
  it('2 ページの HTML からラベル・ページ index を作る(キー集合が一致・ページ index が対応)', () => {
    const html =
      '<div class="page"><div data-part-id="cover">表紙</div><div data-part-id="body">本文</div></div>' +
      '<div class="page"><div data-part-id="notes">注記</div></div>';
    const { labels, pages } = partMapsFromHtml(html);
    expect([...labels.keys()].sort()).toEqual([...pages.keys()].sort());
    expect(labels.get('.page#1/cover#1')).toBe('ページ1・パーツ1');
    expect(labels.get('.page#1/body#1')).toBe('ページ1・パーツ2');
    expect(labels.get('.page#2/notes#1')).toBe('ページ2・パーツ1');
    expect(pages.get('.page#1/cover#1')).toBe(0);
    expect(pages.get('.page#1/body#1')).toBe(0);
    expect(pages.get('.page#2/notes#1')).toBe(1);
  });

  it('空文字は空マップを返す(throw しない)', () => {
    const { labels, pages } = partMapsFromHtml('');
    expect(labels.size).toBe(0);
    expect(pages.size).toBe(0);
  });
});
