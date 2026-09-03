import { describe, expect, it } from 'vitest';
import { MAX_EXPANDED, toggleExpanded } from '@/features/reviews/reviewAccordion';

describe('toggleExpanded', () => {
  it('閉じているものは開き、開いているものは閉じる', () => {
    expect(toggleExpanded([], 'a')).toEqual(['a']);
    expect(toggleExpanded(['a'], 'a')).toEqual([]);
  });

  it('同時展開は MAX_EXPANDED 件まで。超えたら最も古く開いたものを閉じる', () => {
    expect(MAX_EXPANDED).toBe(2);
    expect(toggleExpanded(['a', 'b'], 'c')).toEqual(['b', 'c']);
  });

  it('入力の配列を書き換えない', () => {
    const src = ['a'];
    toggleExpanded(src, 'b');
    expect(src).toEqual(['a']);
  });
});
