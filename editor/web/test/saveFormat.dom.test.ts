import type { Component } from 'grapesjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from '@/components/ui/toast';
import { useGrapes } from '@/features/editor/useGrapes';

vi.mock('@/components/ui/toast', () => ({ toast: vi.fn(), toastError: vi.fn() }));

// =============================================================================
// saveFormat.dom.test.ts — 保存内容(getBodyHtml / getCss)に GrapesJS 由来の揮発物を載せない
// =============================================================================
// 幾何は inline style 属性に保存し、自動 id(ccid)と protectedCss は保存内容に出さない。
// 自動 id が draft / Undo snapshot に混入すると再読込で確定版と構造キーが一致せず、編集して
// いない箇所が赤入れになりコメントの宛先が「削除済みパーツ」になる。protectedCss は load の
// たび規則として積み増す。幾何を CssRule(#id)に書くと自動 id が保存内容の一部になってしまう。

const DOC =
  '<div class="page"><p class="cover-category" data-part-id="cat">見出し</p><p class="body" id="fixed-1">本文</p></div>';

describe('保存形式', () => {
  let g: ReturnType<typeof useGrapes>;
  beforeEach(() => {
    g = useGrapes();
    g.init({ canvas: document.createElement('div'), layers: document.createElement('div') });
    g.load(DOC, '.body { color: red; }');
  });

  /**
   * class セレクタでモデル木を素朴に探す。GrapesJS の `Component.find` は
   * 「既に描画済みの component にしか効かない」("works only with already rendered
   * component")仕様で、本番の canvas は常にライブ document へ接続されるが、この
   * `.dom.test.ts` の canvas 引数(detached な `div`)は接続されないため view が
   * 作られず `find` は常に空を返す。ここではモデル(= 保存内容の実体)だけを見れば十分なので、
   * view 依存の `find` を避けてモデル木を直接たどる。
   */
  function findByClass(root: Component, cls: string): Component | undefined {
    if (root.getClasses().includes(cls)) return root;
    for (const child of root.components()) {
      const found = findByClass(child, cls);
      if (found) return found;
    }
    return undefined;
  }

  function select(selector: string) {
    const ed = g.editor.value!;
    const comp = findByClass(ed.getWrapper()!, selector.replace(/^\./, ''))!;
    ed.select(comp);
    return comp;
  }

  it('選択しただけでは getBodyHtml に自動 id が現れない', () => {
    select('.cover-category');
    expect(g.getBodyHtml()).not.toMatch(/ id="i[a-z0-9]+"/);
  });

  it('テンプレ由来の明示 id は残る', () => {
    select('.body');
    expect(g.getBodyHtml()).toContain('id="fixed-1"');
  });

  it('幾何の編集は inline style 属性へ書かれ、保存 → 再読込で残る', () => {
    select('.cover-category');
    g.patchSelectedStyle({ width: '50%', 'margin-top': '10mm' });
    const html = g.getBodyHtml();
    expect(html).toMatch(/class="cover-category"[^>]*style="[^"]*width:\s*50%/);
    expect(html).not.toMatch(/ id="i[a-z0-9]+"/);
    expect(g.getCss()).not.toMatch(/#i[a-z0-9]+\s*\{/);
    g.load(html, g.getCss());
    select('.cover-category');
    expect(g.selectedStyle()).toMatchObject({ width: '50%', 'margin-top': '10mm' });
  });

  it('getCss に protectedCss(box-sizing / body margin)が現れず、load を繰り返しても増えない', () => {
    const css1 = g.getCss();
    expect(css1).not.toMatch(/box-sizing/);
    expect(css1).not.toMatch(/body\s*\{\s*margin/);
    g.load(g.getBodyHtml(), css1);
    expect(g.getCss()).toBe(css1);
  });

  it('幾何を持つ component があっても getCss に自動 id ミラーは出ず、明示 id の本物のルールは残る', () => {
    g.load(DOC, '#fixed-1 { color: blue; }');
    select('.cover-category');
    g.patchSelectedStyle({ width: '50%' });
    const css = g.getCss();
    expect(css).not.toMatch(/#i[a-z0-9]+\s*\{/);
    expect(css).toContain('#fixed-1{color:blue;}');
  });
  // CSS はテンプレ単位で基準日をまたいで共有する。この文書で使っていない規則も、別の基準日の
  // 文書では使われうるので、保存・申請・baseline の CSS から落とさない。
  it('文書で使っていないクラスの規則も getCss に残る(load → getCss で消えない)', () => {
    g.load(DOC, '.body { color: red; } .only-other-date { color: blue; }');
    expect(g.getCss()).toContain('.only-other-date{color:blue;}');
  });

  it('クラスを使う最後の要素を消しても、そのクラスの規則は getCss に残る', () => {
    g.load(DOC, '.cover-category { color: green; }');
    select('.cover-category').remove();
    expect(g.getBodyHtml()).not.toContain('cover-category');
    expect(g.getCss()).toContain('.cover-category{color:green;}');
  });
  it('@media の中の、文書で使っていないクラスの規則も getCss に残る', () => {
    g.load(DOC, '.body { color: red; } @media print { .unused-print { color: blue; } }');
    expect(g.getCss()).toContain('@media print{.unused-print{color:blue;}}');
  });

  it('quiet の読み込みは外部参照の CSS を拒んでも通知を出さない(通常の読み込みは出す)', () => {
    vi.mocked(toast).mockClear();
    const external = '@import "http://evil.example/x";';
    expect(g.load(DOC, external, { quiet: true })).toBe(false);
    expect(toast).not.toHaveBeenCalled();
    expect(g.load(DOC, external)).toBe(false);
    expect(toast).toHaveBeenCalledTimes(1);
  });
});

describe('本文の先頭のコメント', () => {
  // 値入り HTML の往復の印はコメントで、本文の先頭に来ることがある(先頭がブロックの本文)。
  it('読み込みで消えず、保存内容の先頭に残る', () => {
    const g = useGrapes();
    g.init({ canvas: document.createElement('div'), layers: document.createElement('div') });
    g.load('<!-- a --><!--b--> <p>x</p>', '');
    expect(g.getBodyHtml()).toMatch(/^<body><!-- a --><!--b--> <p>x<\/p><\/body>$/);
  });
  it('赤入れの基準(parseHtmlQuiet)でも消えない', () => {
    const g = useGrapes();
    g.init({ canvas: document.createElement('div'), layers: document.createElement('div') });
    const defs = g.parseHtmlQuiet('<!--a--><p>x</p>');
    expect(defs[0]).toMatchObject({ type: 'comment', content: 'a' });
  });
});
