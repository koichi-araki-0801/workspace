import { describe, expect, it } from 'vitest';
import { resolveReviewTarget } from '@/features/reviews/resolveReviewTarget';

const ID = 'XX01_950037_20240710_交付版';

describe('resolveReviewTarget', () => {
  it('query の template を対象にする', () => {
    expect(resolveReviewTarget({ template: ID })).toBe(ID);
  });

  it('template が無いとき・不正な id・配列は null(承認タブは全申請の一覧になる)', () => {
    expect(resolveReviewTarget({})).toBeNull();
    expect(resolveReviewTarget({ template: '../x' })).toBeNull();
    expect(resolveReviewTarget({ template: 'a/b' })).toBeNull();
    expect(resolveReviewTarget({ template: ['a', 'b'] })).toBeNull();
  });
});
