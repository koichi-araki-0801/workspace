// =============================================================================
// templateTable.test.ts — action 列ボタンの二重送信ガードの回帰テスト
// =============================================================================
// 作成は数秒かかる。ボタンが押しっぱなしのままだと連打で同じファンドのテンプレが二重に
// 作られるため、進行中は `actionDisabled` で押せなくする。
import type { TemplateMeta } from '@editor/shared';
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import TemplateTable from '@/features/templates/components/TemplateTable.vue';

const row: TemplateMeta = {
  id: 'AM01_510037_20240710_交付版',
  attributes: {
    companyCode: 'AM01',
    fundCode: '510037',
    baseDate: '20240710',
    editionType: '交付版',
  },
  fileName: 'AM01_510037_20240710_交付版.html',
  status: 'draft',
  updatedAt: null,
  updatedBy: null,
};

function mountTable(actionDisabled: boolean) {
  return mount(TemplateTable, {
    props: { rows: [row], action: 'create', actionDisabled },
    // ファンド名の解決は repository 注入が要る。ここの関心はボタンの活性なので差し替える。
    global: { stubs: { FundCodeName: true } },
  });
}

describe('TemplateTable の action ボタン', () => {
  it('既定では押せて action を emit する', async () => {
    const w = mountTable(false);
    const btn = w.get('tbody button');
    expect(btn.attributes('disabled')).toBeUndefined();
    await btn.trigger('click');
    expect(w.emitted('action')).toHaveLength(1);
  });

  it('actionDisabled の間は押せず action も emit しない', async () => {
    const w = mountTable(true);
    const btn = w.get('tbody button');
    expect(btn.attributes('disabled')).toBeDefined();
    await btn.trigger('click');
    expect(w.emitted('action')).toBeUndefined();
  });
});
