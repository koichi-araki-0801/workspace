import { describe, expect, it } from 'vitest';
import { canSubmitSearch } from '@/features/templates/components/searchGuard';

const FIELDS = ['companyCode', 'fundCode', 'baseDate', 'editionType'] as const;

describe('canSubmitSearch', () => {
  it('必須指定が無いときは、条件が 1 つも入っていなければ押させない', () => {
    expect(canSubmitSearch({}, FIELDS, [])).toBe(false);
    expect(canSubmitSearch({ companyCode: '', fundCode: '' }, FIELDS, [])).toBe(false);
  });

  it('必須指定が無いときは、条件が 1 つでも入っていれば押させる', () => {
    expect(canSubmitSearch({ companyCode: 'AM01' }, FIELDS, [])).toBe(true);
    expect(canSubmitSearch({ editionType: '交付版' }, FIELDS, [])).toBe(true);
  });

  it('必須指定があるときは、必須が全部埋まって初めて押させる', () => {
    expect(canSubmitSearch({ companyCode: 'AM01' }, FIELDS, ['companyCode', 'fundCode'])).toBe(
      false,
    );
    expect(
      canSubmitSearch({ companyCode: 'AM01', fundCode: '510037' }, FIELDS, [
        'companyCode',
        'fundCode',
      ]),
    ).toBe(true);
  });

  it('必須以外がいくら埋まっていても、必須が欠けていれば押させない', () => {
    expect(
      canSubmitSearch({ baseDate: '20240710', editionType: '交付版' }, FIELDS, ['companyCode']),
    ).toBe(false);
  });

  it('空白だけの入力は未入力として扱う', () => {
    expect(canSubmitSearch({ companyCode: '   ' }, FIELDS, [])).toBe(false);
    expect(canSubmitSearch({ companyCode: '   ' }, FIELDS, ['companyCode'])).toBe(false);
  });
});
