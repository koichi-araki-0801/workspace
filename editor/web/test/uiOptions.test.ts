// uiOptions.test.ts — Select / Combobox が受ける Option の正規化
import { describe, expect, it } from 'vitest';
import { normalizeOptions } from '@/components/ui/options';

describe('normalizeOptions', () => {
  it('文字列は label=value に、{ label, value } はそのまま揃える', () => {
    expect(normalizeOptions(['a', { label: 'B 社', value: 'b' }])).toEqual([
      { label: 'a', value: 'a' },
      { label: 'B 社', value: 'b' },
    ]);
    expect(normalizeOptions([])).toEqual([]);
  });
});
