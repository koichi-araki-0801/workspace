// =============================================================================
// pagebreakCanvas.dom.test.ts — 改ページの区切り(`div.pagebreak`)の部品の型と canvas の帯
// =============================================================================
// 主張は 3 つ。
//   1. 根の直下の `div.pagebreak` は型 `pagebreak`(名前「改ページ」)になり、選んで消せるが、中に
//      何も入れられず複製もできない。
//   2. 保存内容は `<div class="pagebreak"></div>` のまま(属性も中身も足さない)で、帯の CSS は
//      保存 CSS に出ない。
//   3. 帯の CSS は根の直下の区切りだけを対象にし、`!important` でテンプレの CSS に負けない。
import type { Component } from 'grapesjs';
import { beforeEach, describe, expect, it } from 'vitest';
import { PAGEBREAK_TYPE, pagebreakCanvasCss } from '@/features/editor/pagebreakCanvas';
import { useGrapes } from '@/features/editor/useGrapes';

const DOC =
  '<section><p>1 ページ目</p></section><div class="pagebreak"></div><section><p>2 ページ目</p></section>';

let g: ReturnType<typeof useGrapes>;

beforeEach(() => {
  g = useGrapes();
  g.init({ canvas: document.createElement('div'), layers: document.createElement('div') });
});

/** wrapper 直下の区切りの部品。`Component.find` は jsdom で view が無く空になるのでモデルを見る。 */
function rootBreaks(): Component[] {
  const w = g.editor.value?.getWrapper();
  return w ? w.components().models.filter((c) => c.getClasses().includes('pagebreak')) : [];
}

describe('区切りの部品の型', () => {
  it('型は pagebreak で名前は「改ページ」、選べて消せるが中に入れられず複製しない', () => {
    g.load(DOC, '');
    const [br] = rootBreaks();
    expect(br?.get('type')).toBe(PAGEBREAK_TYPE);
    expect(br?.getName()).toBe('改ページ');
    expect(br?.get('selectable')).not.toBe(false);
    expect(br?.get('removable')).toBe(true);
    expect(br?.get('droppable')).toBe(false);
    expect(br?.get('copyable')).toBe(false);
  });

  it('section や他の div は区切りの型にしない', () => {
    g.load('<div class="pagebreak-not"></div><section class="pagebreak"></section>', '');
    const types = g.editor.value
      ?.getWrapper()
      ?.components()
      .models.map((c) => c.get('type'));
    expect(types).not.toContain(PAGEBREAK_TYPE);
  });

  it('保存内容は区切りの原文のまま、帯の CSS は保存 CSS に出ない', () => {
    g.load(DOC, '.pagebreak { break-after: page; }');
    expect(g.getBodyHtml()).toContain('<div class="pagebreak"></div>');
    expect(g.getBodyHtml()).not.toMatch(/<div class="pagebreak"[^>]*>[^<]/);
    expect(g.getBodyHtml()).not.toMatch(/<div class="pagebreak"\s[^>]*id=/);
    const css = g.editor.value?.getCss() ?? '';
    expect(css).not.toContain('改ページ');
    expect(css).not.toContain('#94a3b8');
  });
});

describe('帯の CSS', () => {
  const selectors = [...pagebreakCanvasCss.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{/g)]
    .flatMap((m) => m[1].split(','))
    .map((s) => s.trim());

  it('根の直下の div.pagebreak だけを対象にする', () => {
    expect(selectors.length).toBeGreaterThan(0);
    for (const s of selectors) {
      expect(s.startsWith('[data-gjs-type=wrapper] > div.pagebreak'), s).toBe(true);
    }
  });

  it('display を !important で決め、設計の見た目を持つ', () => {
    expect(pagebreakCanvasCss).toMatch(/display:\s*block\s*!important/);
    expect(pagebreakCanvasCss).toMatch(/height:\s*14px\s*!important/);
    expect(pagebreakCanvasCss).toMatch(/margin:\s*8px 0\s*!important/);
    expect(pagebreakCanvasCss).toMatch(/2px dotted #94a3b8/);
    expect(pagebreakCanvasCss).toContain("content: '改ページ'");
    expect(pagebreakCanvasCss).toMatch(/font-size:\s*11px/);
    expect(pagebreakCanvasCss).toMatch(/color:\s*#64748b/);
    expect(pagebreakCanvasCss).toMatch(/background:\s*#fff/);
  });
});
