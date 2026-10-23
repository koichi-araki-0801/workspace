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
import {
  BAND_DASH,
  BAND_FONT_SIZE,
  BAND_TEXT_COLOR,
  BLANK_BAND_HEIGHT,
  BLANK_PAGE_LABEL,
  PAGEBREAK_TYPE,
  PV_BLANK_ATTR,
  pagebreakCanvasCss,
} from '@/features/editor/pagebreakCanvas';
import { markPages, PV_ATTR, pageViewCss } from '@/features/editor/pageView';
import { useGrapes } from '@/features/editor/useGrapes';
import { pageItems, splitPages } from '@/lib/pageBreaks';

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
    expect(pagebreakCanvasCss).toMatch(/2px dashed #94a3b8/);
    expect(pagebreakCanvasCss).toContain("content: '改ページ'");
    expect(pagebreakCanvasCss).toMatch(/font-size:\s*11px/);
    expect(pagebreakCanvasCss).toMatch(/color:\s*#64748b/);
    expect(pagebreakCanvasCss).toMatch(/background:\s*#fff/);
  });

  it('白紙のページの先頭の区切りは高さのある帯にし、白紙のページの文言を出す', () => {
    expect(pagebreakCanvasCss).toContain(`div.pagebreak[${PV_BLANK_ATTR}]`);
    expect(pagebreakCanvasCss).toMatch(/height:\s*40px\s*!important/);
    expect(pagebreakCanvasCss).toContain(`content: '${BLANK_PAGE_LABEL}'`);
    expect(BLANK_PAGE_LABEL).toBe('白紙のページ（区切りが続いているか、左右合わせで入るページ）');
  });
});

/**
 * 単純なセレクタの詳細度 `[id, class・属性・擬似クラス, 型]`。`:not()` は引数だけを数える。
 * jsdom の `getComputedStyle` は詳細度を見ず出現順で決めるので、詳細度は文字列から数える。
 */
function specificity(selector: string): [number, number, number] {
  const s = selector
    .replace(/"[^"]*"/g, '""')
    .replace(/:not\(/g, ' ')
    .replace(/\)/g, ' ');
  const ids = (s.match(/#[\w-]+/g) ?? []).length;
  const classes = (s.match(/\[[^\]]*\]|\.[\w-]+|:(?!:)[\w-]+/g) ?? []).length;
  const rest = s.replace(/\[[^\]]*\]|[.#][\w-]+|::?[\w-]+/g, ' ');
  const types = (rest.match(/(^|[\s>+~])[a-zA-Z][\w-]*/g) ?? []).length;
  return [ids, classes, types];
}

const beats = (a: number[], b: number[]): boolean => {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
};

describe('帯と 1 ページ表示', () => {
  it('区切りの帯と要素の無い白紙のページの帯は、色・字の大きさ・破線・高さを共有の定数で揃える', () => {
    const elementless = pageViewCss(1, 3, true, true);
    for (const css of [pagebreakCanvasCss, elementless]) {
      expect(css).toContain(`color: ${BAND_TEXT_COLOR}`);
      expect(css).toContain(`font-size: ${BAND_FONT_SIZE}`);
      expect(css).toContain(`border-top: ${BAND_DASH}`);
      expect(css).toContain(`height: ${BLANK_BAND_HEIGHT}`);
    }
    expect(elementless).toContain(`border-bottom: ${BAND_DASH}`);
  });

  it('1 ページ表示の隠す規則は、帯の規則より詳細度が高い', () => {
    const band = [...pagebreakCanvasCss.matchAll(/([^{}]+)\{[^}]*display:/g)].map((m) =>
      m[1].trim(),
    );
    const hide = pageViewCss(1, 3, true, false).split('{')[0].trim();
    expect(band).toEqual(['[data-gjs-type=wrapper] > div.pagebreak']);
    expect(specificity(band[0])).toEqual([0, 2, 1]);
    expect(beats(specificity(hide), specificity(band[0])), hide).toBe(true);
  });

  // 帯の規則は `!important` で表示を決めるので、1 ページ表示の隠す規則(`pageViewCss`)が詳細度で
  // 勝たないと他ページの帯が見え続ける。実際の帯の CSS と `markPages` の印で確かめる。
  it('根の直下の区切りは直前のページの印を持ち、他ページの表示中は隠れる', () => {
    const wrapper = document.createElement('div');
    wrapper.setAttribute('data-gjs-type', 'wrapper');
    wrapper.innerHTML =
      '<section id="a"></section><div class="pagebreak" id="k1"></div><section id="b"></section>' +
      '<div class="pagebreak" id="k2"></div><section id="c"></section>';
    document.body.appendChild(wrapper);
    const children = Array.from(wrapper.children) as HTMLElement[];
    markPages(wrapper, splitPages(pageItems(children)));
    const k1 = wrapper.querySelector('#k1') as HTMLElement;
    const k2 = wrapper.querySelector('#k2') as HTMLElement;
    expect(k1.getAttribute(PV_ATTR)).toBe('0');
    expect(k2.getAttribute(PV_ATTR)).toBe('1');
    const style = document.createElement('style');
    document.head.appendChild(style);
    try {
      style.textContent = `${pagebreakCanvasCss}
${pageViewCss(1, 3, true, false)}`;
      expect(getComputedStyle(k1).display).toBe('none');
      expect(getComputedStyle(k2).display).toBe('block');
      style.textContent = `${pagebreakCanvasCss}
${pageViewCss(0, 3, false, false)}`;
      expect(getComputedStyle(k1).display).toBe('block');
    } finally {
      style.remove();
      wrapper.remove();
    }
  });
});
