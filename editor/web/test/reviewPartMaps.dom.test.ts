// =============================================================================
// reviewPartMaps.test.ts — 承認タブのコメント宛先パーツ算出
// =============================================================================
import { describe, expect, it } from 'vitest';
import { partMapsFromHtml } from '@/features/reviews/reviewPartMaps';

describe('partMapsFromHtml', () => {
  it('2 ページの HTML からラベル・ページ index を作る(キー集合が一致・ページ index が対応)', () => {
    const html =
      '<div data-part-id="cover">表紙</div><div data-part-id="body">本文</div>' +
      '<div class="pagebreak"></div><div data-part-id="notes">注記</div>';
    const { labels, pages } = partMapsFromHtml(html);
    expect([...labels.keys()].sort()).toEqual([...pages.keys()].sort());
    expect(labels.get('cover#1')).toBe('ページ1・パーツ1');
    expect(labels.get('body#1')).toBe('ページ1・パーツ2');
    expect(labels.get('notes#1')).toBe('ページ2・パーツ1');
    expect(pages.get('cover#1')).toBe(0);
    expect(pages.get('body#1')).toBe(0);
    expect(pages.get('notes#1')).toBe(1);
  });

  it('本文の <style> と区切りはパーツに数えない', () => {
    const html =
      '<style>.a{}</style><p class="a">A</p><div class="pagebreak"></div><style>.b{}</style>' +
      '<p class="a">B</p>';
    const { labels } = partMapsFromHtml(html);
    expect([...labels]).toEqual([
      ['.a#1', 'ページ1・パーツ1'],
      ['.a#2', 'ページ2・パーツ1'],
    ]);
  });

  it('空文字は空マップを返す(throw しない)', () => {
    const { labels, pages } = partMapsFromHtml('');
    expect(labels.size).toBe(0);
    expect(pages.size).toBe(0);
  });
});
