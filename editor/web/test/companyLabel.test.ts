// =============================================================================
// companyLabel.test.ts — 委託会社の表示書式「略称（Rep1 の委託会社コード）」
// =============================================================================
import { describe, expect, it } from 'vitest';
import { formatCompanyLabel, UNREGISTERED } from '@/lib/companyLabel';

describe('formatCompanyLabel', () => {
  it('略称（コード）を全角括弧で組む', () => {
    expect(formatCompanyLabel('AM01', '0001')).toBe('AM01（0001）');
  });

  it('未登録の文言は同じ括弧書きになる', () => {
    expect(formatCompanyLabel('AM01', '未登録')).toBe(`AM01${UNREGISTERED}`);
  });
});
