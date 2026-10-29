// =============================================================================
// safeMarkupGates.test.ts — `safe` で生で置いた値が描き直しの関所で能動コンテンツに数えられないこと
// =============================================================================
// 描き直し(`jinjaPartRerender.ts`)は、承認済みのパーツと描き直したパーツの能動コンテンツの並び
// (`collectExecutableUnits`)が同じときだけ置き換える。`safe` の値が許可した属性を持つだけで能動
// コンテンツに数えられると、写し先の値だけが違うパーツが「直した」扱いになる。
import { renderPlainFilled, SAFE_MARKUP_ATTRS, SAFE_MARKUP_TAGS } from '@editor/shared';
import { describe, expect, it } from 'vitest';
import { collectExecutableUnits } from '../src/security/templateScripts.js';

const VOID = new Set(['br', 'hr', 'col']);

const markupOf = (tag: string) => {
  const attrs = [...SAFE_MARKUP_ATTRS]
    .map((a) => ` ${a}="${a === 'style' ? 'color: red' : '1'}"`)
    .join('');
  return VOID.has(tag) ? `<${tag}${attrs}>` : `<${tag}${attrs}>x</${tag}>`;
};

describe('safe の許可リスト ⊆ server の関所の不活性な属性', () => {
  it.each([...SAFE_MARKUP_TAGS])('<%s> と許可した属性は能動コンテンツに数えない', (tag) => {
    const html = renderPlainFilled('<div>{{ v | safe }}</div>', { v: markupOf(tag) }).html;
    expect(html).toBe(`<div>${markupOf(tag)}</div>`);
    expect(collectExecutableUnits(html)).toEqual([]);
  });
});
