import { describe, expect, it } from 'vitest';
import { filterComboboxOptions } from '@/components/ui/comboboxFilter';

const opts = [
  { label: '三井住友トラスト', value: 'AM01' },
  { label: '510037 コア投資戦略ファンド（切替型）', value: '510037' },
];

describe('filterComboboxOptions', () => {
  it('空の入力は全件', () => expect(filterComboboxOptions(opts, ' ')).toEqual(opts));
  it('値(コード)の前方一致で絞る(大文字小文字を区別しない)', () =>
    expect(filterComboboxOptions(opts, 'am0')).toEqual([opts[0]]));
  it('表示名の部分一致でも絞る', () => {
    expect(filterComboboxOptions(opts, 'トラスト')).toEqual([opts[0]]);
    expect(filterComboboxOptions(opts, '切替')).toEqual([opts[1]]);
  });
  it('どれにも当たらなければ空', () => expect(filterComboboxOptions(opts, 'zzz')).toEqual([]));
});
