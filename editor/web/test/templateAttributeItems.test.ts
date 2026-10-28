import { describe, expect, it } from 'vitest';
import { templateAttributeItems } from '@/lib/templateAttributeItems';

describe('templateAttributeItems', () => {
  it('値入り HTML(基準日あり)は 4 項目を決まった順に出す', () => {
    const items = templateAttributeItems({
      companyCode: 'XX01',
      fundCode: '950037',
      baseDate: '20240710',
      editionType: '交付版',
    });
    expect(items.map((i) => [i.label, i.value])).toEqual([
      ['委託会社', 'XX01'],
      ['ファンドコード', '950037'],
      ['基準日', '20240710'],
      ['版種', '交付版'],
    ]);
  });

  it('テンプレート(基準日なし)は基準日の項目ごと出さない', () => {
    const items = templateAttributeItems({
      companyCode: 'XX01',
      fundCode: '950037',
      editionType: '交付版',
    });
    expect(items.map((i) => i.key)).toEqual(['companyCode', 'fundCode', 'editionType']);
  });
});
