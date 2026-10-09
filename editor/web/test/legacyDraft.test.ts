import { describe, expect, it } from 'vitest';
import { isLegacyDraft, LEGACY_DRAFT_ATTRS } from '@/features/editor/services/legacyDraft';
import { LEGACY_ATTR_SELECTOR } from '@/lib/jinjaMask';

describe('isLegacyDraft', () => {
  it('作成経路: 旧形式の属性があれば旧形式、新形式の印は正当', () => {
    expect(
      isLegacyDraft('<tr data-jinja-open="eyU=" data-jinja-close="eyU="></tr>', 'template'),
    ).toBe(true);
    expect(isLegacyDraft('<p data-jinja-block="eyU=">x</p>', 'template')).toBe(true);
    expect(isLegacyDraft('<tr data-jinja-loop-clone=""></tr>', 'template')).toBe(true);
    expect(
      isLegacyDraft(
        '<p><!--jinja-rt:o:1:eyU=-->x<span data-jinja="e3t9fQ==">1</span></p>',
        'template',
      ),
    ).toBe(false);
  });

  it('作成経路: 旧形式の属性と新形式の印が混ざる下書きは旧形式', () => {
    expect(
      isLegacyDraft(
        '<p data-jinja-open="eyU=">a</p><p>b<!--jinja-rt:o:1:eyU=-->x<!--jinja-rt:c:1:eyU=--></p>',
        'template',
      ),
    ).toBe(true);
  });

  it('編集経路: 編集用の印が 1 個でもあれば旧形式(旧 fixture から作った下書き)', () => {
    expect(isLegacyDraft('<p><span data-jinja="e3t9fQ==">1</span></p>', 'filled')).toBe(true);
    expect(isLegacyDraft('<p>値</p>', 'filled')).toBe(false);
  });

  it('toTemplate が legacy-draft にする選択子と同じ属性の集合を見る', () => {
    const fromSelector = LEGACY_ATTR_SELECTOR.split(',').map((s) => s.trim().slice(1, -1));
    expect([...fromSelector].sort()).toEqual([...LEGACY_DRAFT_ATTRS].sort());
  });
});
