import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import SeriesSourceTable from '@/features/templates/components/SeriesSourceTable.vue';

const rows = [
  { fundCode: '510003', fundName: '安定型', hasTemplate: false },
  { fundCode: '510037', fundName: '切替型', hasTemplate: true },
];

describe('SeriesSourceTable', () => {
  it('コピー元テンプレートが無い行は警告を出し、作成ボタンを押せない', () => {
    const w = mount(SeriesSourceTable, { props: { rows } });
    expect(w.text()).toContain('コピー元のテンプレートがありません');
    expect(w.get('[data-testid="series-create-510003"]').attributes('disabled')).toBeDefined();
    expect(w.get('[data-testid="series-create-510037"]').attributes('disabled')).toBeUndefined();
  });

  it('作成ボタンでコピー元のファンドコードを emit する', async () => {
    const w = mount(SeriesSourceTable, { props: { rows } });
    await w.get('[data-testid="series-create-510037"]').trigger('click');
    expect(w.emitted('create')?.[0]).toEqual(['510037']);
  });

  it('disabled のときは全行の作成ボタンを押せない', () => {
    const w = mount(SeriesSourceTable, { props: { rows, disabled: true } });
    expect(w.get('[data-testid="series-create-510037"]').attributes('disabled')).toBeDefined();
  });
});
