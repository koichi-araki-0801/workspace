// =============================================================================
// safeMarkupGates.test.ts — `safe` で生で置いた値が canvas の入口の刈り取りで落ちないこと
// =============================================================================
// 描画器(`renderPlainFilled`)が `safe` の値を生で置く許可リストは、canvas の入口の刈り取りの
// 許可リストの部分集合でなければならない。外れると、挿入した値が中身ごと消えて「取り除きました」の
// 通知が出る。リストを共有の定数から作らず検査で縛るのは、描画器の許可を広げたときに刈り取りまで
// 黙って緩まないようにするため。
import { renderPlainFilled, SAFE_MARKUP_ATTRS, SAFE_MARKUP_TAGS } from '@editor/shared';
import { describe, expect, it } from 'vitest';
import { JINJA_COMPONENT_TYPE_SET } from '@/features/editor/jinjaComponents';
import { type ParsedHtmlNode, pruneCanvasActiveContent } from '@/lib/sanitizeHtml';

const VOID = new Set(['br', 'hr', 'col']);

/** 許可した属性を全部持たせた値。style は許可した文字だけで書く。 */
const ATTRS: Record<string, string> = Object.fromEntries(
  [...SAFE_MARKUP_ATTRS].map((a) => [a, a === 'style' ? 'color: red' : '1']),
);

const markupOf = (tag: string) => {
  const attrs = Object.entries(ATTRS)
    .map(([k, v]) => ` ${k}="${v}"`)
    .join('');
  return VOID.has(tag) ? `<${tag}${attrs}>` : `<${tag}${attrs}>x</${tag}>`;
};

describe('safe の許可リスト ⊆ canvas の刈り取りの許可リスト', () => {
  it.each([...SAFE_MARKUP_TAGS])('<%s> と許可した属性は刈り取りで落ちない', (tag) => {
    const value = markupOf(tag);
    // 描画器が生で置いたこと(エスケープされていないこと)を先に確かめる。
    expect(renderPlainFilled('<div>{{ v | safe }}</div>', { v: value }).html).toBe(
      `<div>${value}</div>`,
    );
    const root: ParsedHtmlNode = {
      nodeType: 11,
      childNodes: [
        {
          nodeType: 1,
          tagName: tag,
          attributes: { ...ATTRS },
          childNodes: VOID.has(tag) ? [] : [{ nodeType: 3 }],
        },
      ],
    };
    const report = pruneCanvasActiveContent(root, { allowedGjsTypes: JINJA_COMPONENT_TYPE_SET });
    expect(report).toEqual({ droppedElements: [], droppedAttrs: [], droppedCount: 0 });
    expect(root.childNodes?.[0]?.attributes).toEqual(ATTRS);
  });
});
