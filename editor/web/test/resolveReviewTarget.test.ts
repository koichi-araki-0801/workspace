import { describe, expect, it } from 'vitest';
import { resolveReviewTarget } from '@/features/reviews/resolveReviewTarget';

const ID = 'AM01_510037_20240710_交付版';

describe('resolveReviewTarget', () => {
  it('query の template を最優先にする', () => {
    expect(resolveReviewTarget({ template: ID }, `/edit/other`)).toBe(ID);
  });

  it('query が無ければ編集タブの直前画面 /edit/:id から取る(URL エンコードを解く)', () => {
    expect(resolveReviewTarget({}, `/edit/${encodeURIComponent(ID)}`)).toBe(ID);
    expect(resolveReviewTarget({}, `/edit/${encodeURIComponent(ID)}?x=1`)).toBe(ID);
    expect(resolveReviewTarget({}, `/preview/${encodeURIComponent(ID)}`)).toBe(ID);
  });

  it('作成経路(?created=1)の編集画面は対象にしない(作成中のテンプレートに申請は無い)', () => {
    expect(resolveReviewTarget({}, `/edit/${encodeURIComponent(ID)}?created=1`)).toBeNull();
  });

  it('一覧に居たとき・記憶が無いとき・不正な id は null', () => {
    expect(resolveReviewTarget({}, '/edit')).toBeNull();
    expect(resolveReviewTarget({}, undefined)).toBeNull();
    expect(resolveReviewTarget({ template: '../x' }, undefined)).toBeNull();
    expect(resolveReviewTarget({ template: ['a', 'b'] }, undefined)).toBeNull();
  });
});
