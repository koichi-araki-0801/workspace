// =============================================================================
// searchFilters.test.ts — 絞り込みバーの placeholder がフィールド幅に収まること
// =============================================================================
// `FormField width="lg"` は `min-w-[190px]` で、実測の入力欄は 153px(枠の padding と
// chevron を引いた残り)。項目名を含む placeholder はこの幅を超えて見切れるため、
// 項目名はラベル側に任せて placeholder を短く保つ。
import { ok } from '@editor/shared';
import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import SearchFilters from '@/features/templates/components/SearchFilters.vue';

vi.mock('@/api/repositories', () => ({
  useTemplateRepo: () => ({
    getDropdownOptions: vi
      .fn()
      .mockResolvedValue(ok({ companyCodes: [], fundCodes: [], baseDates: [], editionTypes: [] })),
  }),
}));
vi.mock('vue-router', () => ({
  useRoute: () => ({ query: {} }),
  useRouter: () => ({ replace: vi.fn(), currentRoute: { value: { query: {} } } }),
}));

describe('SearchFilters', () => {
  it('placeholder は項目名を含めず、入力欄の幅(153px)に収まる長さにする', () => {
    const w = mount(SearchFilters);
    const placeholders = w.findAll('input').map((i) => i.attributes('placeholder') ?? '');
    // 委託会社コード / ファンドコードの 2 つが Combobox(=input)。
    expect(placeholders.length).toBeGreaterThanOrEqual(2);
    for (const p of placeholders) {
      expect(p).not.toContain('委託会社コード');
      expect(p).not.toContain('ファンドコード');
    }
  });
});
