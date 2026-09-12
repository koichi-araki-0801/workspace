// =============================================================================
// editorRoute.test.ts — 編集画面への遷移先(`created` query の出し分け)
// =============================================================================
// 「pending だけの id は作成経路で開く」規則が 1 か所に集まっていること、つまり
// `created` query の有無が `opensAsCreate` の判定だけで決まることを固定する。
import { describe, expect, it } from 'vitest';
import { editorRoute, opensAsCreate } from '@/features/templates/editorRoute';

describe('editorRoute', () => {
  it('編集経路は query を持たない(完全一致で主張する)', () => {
    expect(editorRoute('AM01_510037_20240710_交付版', { created: false })).toEqual({
      name: 'editor',
      params: { id: 'AM01_510037_20240710_交付版' },
    });
  });

  it('作成経路は `created=1` を付ける', () => {
    expect(editorRoute('T1', { created: true })).toEqual({
      name: 'editor',
      params: { id: 'T1' },
      query: { created: '1' },
    });
  });
});

describe('opensAsCreate', () => {
  it('`status:"draft"`(pending だけの成果物)は作成経路で開く', () => {
    expect(opensAsCreate({ status: 'draft' })).toBe(true);
  });

  it('確定版は編集経路で開く', () => {
    expect(opensAsCreate({ status: 'published' })).toBe(false);
  });
});
