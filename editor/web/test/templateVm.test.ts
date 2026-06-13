import type { TemplateMeta } from '@editor/shared';
import { describe, expect, it } from 'vitest';
import { toTemplateMetaVm } from '@/features/templates/viewmodels/templateVm';

const meta = (status: TemplateMeta['status']): TemplateMeta => ({
  id: 'AM01_510037_20240710_kr',
  attributes: { companyCode: 'AM01', fundCode: '510037', baseDate: '20240710', editionType: 'kr' },
  fileName: 'AM01_510037_20240710_kr.html',
  status,
  updatedAt: null,
  updatedBy: null,
});

describe('toTemplateMetaVm', () => {
  it('maps published to the success badge', () => {
    const vm = toTemplateMetaVm(meta('published'));
    expect(vm.statusLabel).toBe('公開');
    expect(vm.statusVariant).toBe('success');
  });

  it('maps draft to the secondary badge', () => {
    const vm = toTemplateMetaVm(meta('draft'));
    expect(vm.statusLabel).toBe('下書き');
    expect(vm.statusVariant).toBe('secondary');
  });

  it('keeps the source entity in raw', () => {
    const m = meta('draft');
    expect(toTemplateMetaVm(m).raw).toBe(m);
  });
});
