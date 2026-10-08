import { describe, expect, it } from 'vitest';
import { canSubmitSearch } from '@/features/templates/components/searchGuard';

const FIELDS = ['companyCode', 'fundCode', 'baseDate', 'editionType'] as const;

describe('canSubmitSearch', () => {
  it('条件が 1 つも入っていなければ押させない', () => {
    expect(canSubmitSearch({}, FIELDS)).toBe(false);
    expect(canSubmitSearch({ companyCode: '', fundCode: '' }, FIELDS)).toBe(false);
  });

  it('条件が 1 つでも入っていれば押させる', () => {
    expect(canSubmitSearch({ companyCode: 'AM01' }, FIELDS)).toBe(true);
    expect(canSubmitSearch({ editionType: '交付版' }, FIELDS)).toBe(true);
  });

  it('空白だけの入力は未入力として扱う', () => {
    expect(canSubmitSearch({ companyCode: '   ' }, FIELDS)).toBe(false);
  });
});
