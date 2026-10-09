// dom.dom.test.ts — キー操作を奪わない入力要素の判定
import { describe, expect, it } from 'vitest';
import { isEditableTarget } from '@/lib/dom';

describe('isEditableTarget', () => {
  it('input / textarea / select はキーを奪わない対象', () => {
    for (const tag of ['input', 'textarea', 'select']) {
      expect(isEditableTarget(document.createElement(tag))).toBe(true);
    }
  });

  it('contenteditable の要素は対象、ふつうの要素・null・HTMLElement 以外は対象外', () => {
    const div = document.createElement('div');
    Object.defineProperty(div, 'isContentEditable', { value: true });
    expect(isEditableTarget(div)).toBe(true);
    expect(isEditableTarget(document.createElement('div'))).toBeFalsy();
    expect(isEditableTarget(null)).toBe(false);
    expect(isEditableTarget(window)).toBe(false);
  });
});
