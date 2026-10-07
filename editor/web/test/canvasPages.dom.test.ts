import type { Component, Editor } from 'grapesjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_GEOM, geomToStyle } from '@/features/editor/geom';
import { PV_ATTR } from '@/features/editor/pageView';
import { useGrapes } from '@/features/editor/useGrapes';
import { useSnapshotHistory } from '@/features/editor/useSnapshotHistory';
import { rtComment } from '@/lib/jinjaAttrs';
import { REDLINE_ATTR } from '@/lib/redlineAttr';

vi.mock('@/components/ui/toast', () => ({ toast: vi.fn(), toastError: vi.fn() }));

// =============================================================================
// canvasPages.dom.test.ts — 編集 canvas のページを div.pagebreak の区切りで数える
// =============================================================================
// ページ数・1 ページ表示・パーツの挿入先が、根(wrapper)の直下の区切りで決まることを確かめる。
// `saveFormat.dom.test.ts` と同じく canvas は文書に接続しない(接続すると jsdom の iframe で
// GrapesJS の初期化が戻らない)。そのため GrapesJS は view を作らないので、wrapper の view を
// テストで作って文書へ置き、`load` イベントを canvas の文書 = テストの文書で起こす。

const BR = '<div class="pagebreak"></div>';
const DOC = `<p class="a">1</p>${BR}<p class="b">2</p><p class="b2">2b</p>${BR}<p class="c">3</p>`;

let g: ReturnType<typeof useGrapes>;
let viewEl: HTMLElement | undefined;

/** wrapper の view を作って文書へ置き、ページを数え直す(本番の描画と `recomputeLayout` の代わり)。 */
function render(): HTMLElement {
  viewEl?.remove();
  const ed = g.editor.value as Editor;
  const wrapper = ed.getWrapper() as Component;
  // biome-ignore lint/suspicious/noExplicitAny: GrapesJS の view の型は公開されていない
  const View = (ed.Components.getType('wrapper') as any).view;
  const view = new View({
    model: wrapper,
    config: ed.Components.config,
    componentTypes: ed.Components.componentTypes,
  });
  viewEl = view.render().el as HTMLElement;
  document.body.appendChild(viewEl);
  g.refreshPageMarks();
  return viewEl;
}

function load(html: string): HTMLElement {
  g.load(html, '');
  return render();
}

/** モデル木からクラスで component を探す(view の無い `find` に頼らない)。 */
function byClass(cls: string): Component {
  const walk = (c: Component): Component | undefined => {
    if (c.getClasses().includes(cls)) return c;
    for (const child of c.components()) {
      const hit = walk(child);
      if (hit) return hit;
    }
    return undefined;
  };
  const hit = walk(g.editor.value?.getWrapper() as Component);
  if (!hit) throw new Error(`no .${cls}`);
  return hit;
}

/** 保存内容の本文の、根の直下の並び(クラス名か `BR` / コメント)。 */
function order(): string[] {
  const body = document.createElement('div');
  body.innerHTML = g.getBodyHtml().replace(/^<body[^>]*>|<\/body>$/g, '');
  return Array.from(body.childNodes, (n) =>
    n.nodeType === Node.COMMENT_NODE
      ? `<!--${(n as Comment).data.slice(9, 10)}-->`
      : (n as Element).classList.contains('pagebreak')
        ? 'BR'
        : ((n as Element).getAttribute('data-part-id') ?? (n as Element).className),
  );
}

beforeEach(() => {
  // 選択で GrapesJS が呼ぶ(jsdom には無い)。
  Element.prototype.scrollIntoView = vi.fn();
  // ページ送りで canvas の window を先頭へ戻す(jsdom には無い)。
  window.scrollTo = vi.fn();
  g = useGrapes();
  g.init({ canvas: document.createElement('div'), layers: document.createElement('div') });
  const ed = g.editor.value as Editor;
  // 1 ページ表示の `<style>` を canvas の文書(= テストの文書)へ置かせる。
  vi.spyOn(ed.Canvas, 'getDocument').mockReturnValue(document);
  ed.trigger('load');
});

afterEach(() => {
  viewEl?.remove();
  viewEl = undefined;
  g.destroy();
  for (const s of Array.from(document.head.querySelectorAll('style'))) s.remove();
});

describe('ページ数', () => {
  it('区切りの数 + 1 ページになり、ページごとのパーツを持つ', () => {
    load(DOC);
    expect(g.pageCount.value).toBe(3);
    expect(g.pageBlocks.value.map((p) => p.map((el) => el.className))).toEqual([
      ['a'],
      ['b', 'b2'],
      ['c'],
    ]);
  });

  it('区切りが無ければ 1 ページ', () => {
    load('<p class="a">1</p><p class="b">2</p>');
    expect(g.pageCount.value).toBe(1);
  });

  it('先頭・連続の区切りは白紙のページを数え、白紙のページはパーツを持たない', () => {
    load(`${BR}<p class="a">1</p>${BR}${BR}<p class="b">2</p>${BR}`);
    expect(g.pageCount.value).toBe(4);
    expect(g.pageBlocks.value.map((p) => p.map((el) => el.className))).toEqual([
      [],
      ['a'],
      [],
      ['b'],
    ]);
  });
});

describe('改ページの警告の材料(pageBreakFacts)', () => {
  const NESTED = `<div class="x">${BR}<p style="break-before: page">n</p></div>`;

  it('数えた区切りと数えていない指定を数え、CSS が無ければ cssDefined は false', () => {
    load(`${DOC}${NESTED}`);
    expect(g.pageBreakFacts.value).toEqual({
      uncounted: 2,
      counted: 2,
      cssDefined: false,
      ignoredInline: 0,
      cssRuleBreak: null,
      elementizingChips: 0,
    });
  });

  it('印刷で効かない inline の改ページ指定(page-break-*)を数える', () => {
    load(
      '<p class="a">1</p><p class="b" style="page-break-before: always">2</p>' +
        '<div class="x"><p style="page-break-after: always">n</p></div>',
    );
    expect(g.pageBreakFacts.value.ignoredInline).toBe(2);
    expect(g.pageCount.value).toBe(1);
  });

  it('テンプレの CSS にあれば cssDefined は true', () => {
    g.load(DOC, '.pagebreak{page-break-after:always}');
    render();
    expect(g.pageBreakFacts.value.cssDefined).toBe(true);
  });

  it('本文の <style> にあれば cssDefined は true', () => {
    load(`<style>div.pagebreak{break-after:page}</style>${DOC}`);
    expect(g.pageBreakFacts.value.cssDefined).toBe(true);
  });
});

describe('本文全体を固めた文書', () => {
  // 作成タブで本文全体を固めると、本文が `div.jinja-frozen-body`(`display: contents`)に包まれ、
  // 根の直下に `{% set %}` のチップが並ぶ。包みの中の区切りもページを分ける。
  const FROZEN =
    '<span data-gjs-type="jinja-stmt" class="jinja-chip jinja-stmt" data-jinja="eyUgc2V0IHggPSAxICV9">{% set x = 1 %}</span>' +
    `<div data-gjs-type="jinja-frozen" class="jinja-frozen-body" data-opaque="eA==" data-opaque-kind="body">${DOC}</div>`;

  it('包みの中の区切りの数 + 1 ページになり、チップはパーツに数えない', () => {
    load(FROZEN);
    expect(g.pageCount.value).toBe(3);
    expect(g.pageBlocks.value.map((p) => p.map((el) => el.className))).toEqual([
      ['a'],
      ['b', 'b2'],
      ['c'],
    ]);
  });

  it('1 ページ表示で、包みの中の他のページのパーツが隠れる', () => {
    const root = load(FROZEN);
    g.goToPage(1);
    const shown = (cls: string) =>
      getComputedStyle(root.querySelector(`.${cls}`) as Element).display !== 'none';
    expect(['a', 'b', 'b2', 'c'].map(shown)).toEqual([false, true, true, false]);
  });
});

describe('1 ページ表示', () => {
  it('2 ページ目へ送ると 1・3 ページ目のパーツが隠れ、2 ページ目は見える', () => {
    const root = load(DOC);
    g.goToPage(1);
    const shown = (cls: string) =>
      getComputedStyle(root.querySelector(`.${cls}`) as Element).display !== 'none';
    expect(['a', 'b', 'b2', 'c'].map(shown)).toEqual([false, true, true, false]);
  });

  it('白紙のページへ送ると、そのページの区切りの帯だけが見える', () => {
    const root = load(`<p class="a">1</p>${BR}${BR}<p class="b">2</p>`);
    g.goToPage(1);
    const [k1, k2] = Array.from(root.querySelectorAll('.pagebreak'));
    const shown = (el: Element) => getComputedStyle(el).display !== 'none';
    expect(
      [root.querySelector('.a'), k1, k2, root.querySelector('.b')].map((el) =>
        shown(el as Element),
      ),
    ).toEqual([false, false, true, false]);
  });

  it('赤入れの削除要素は、印を付け直すと元のページでだけ見える', () => {
    const root = load(DOC);
    const del = document.createElement('del');
    del.setAttribute(REDLINE_ATTR, '');
    root.insertBefore(del, root.querySelector('.c'));
    g.refreshPageMarks();
    expect(del.getAttribute(PV_ATTR)).toBe('2');
    g.goToPage(1);
    expect(getComputedStyle(del).display).toBe('none');
  });
});

describe('insertPart', () => {
  it('何も選んでいなければ、現在ページの範囲の末尾(次の区切りの直前)へ入る', () => {
    load(DOC);
    g.goToPage(1);
    g.insertPart('<section>new</section>', 'NEW');
    expect(order()).toEqual(['a', 'BR', 'b', 'b2', 'NEW', 'BR', 'c']);
  });

  it('最後のページなら wrapper の末尾へ入る', () => {
    load(DOC);
    g.goToPage(2);
    g.insertPart('<section>new</section>', 'NEW');
    expect(order()).toEqual(['a', 'BR', 'b', 'b2', 'BR', 'c', 'NEW']);
  });

  it('現在ページのパーツを選んでいれば、そのパーツの直後へ入る', () => {
    load(DOC);
    g.goToPage(1);
    g.editor.value?.select(byClass('b'));
    g.insertPart('<section>new</section>', 'NEW');
    expect(order()).toEqual(['a', 'BR', 'b', 'NEW', 'b2', 'BR', 'c']);
  });

  it('パーツの中の要素を選んでいても、そのパーツの直後(根の直下)へ入る', () => {
    load(
      `<p class="a">1</p>${BR}<div class="b"><span class="in">x</span></div>${BR}<p class="c">3</p>`,
    );
    g.goToPage(1);
    g.editor.value?.select(byClass('in'));
    g.insertPart('<section>new</section>', 'NEW');
    expect(order()).toEqual(['a', 'BR', 'b', 'NEW', 'BR', 'c']);
  });

  it('別のページのパーツを選んでいれば、現在ページの範囲の末尾へ入る', () => {
    load(DOC);
    g.editor.value?.select(byClass('c'));
    g.goToPage(0);
    g.insertPart('<section>new</section>', 'NEW');
    expect(order()).toEqual(['a', 'NEW', 'BR', 'b', 'b2', 'BR', 'c']);
  });

  it('範囲の印(閉じのコメント)の後ろ、区切りの手前へ入り、{% if %} の枝の中に入らない', () => {
    const open = rtComment({ kind: 'o', id: 1, payload: '{% if x %}' });
    const close = rtComment({ kind: 'c', id: 1, payload: '{% endif %}' });
    load(`<p class="a">1</p>${open}<p class="b">2</p>${close}${BR}<p class="c">3</p>`);
    g.insertPart('<section>new</section>', 'NEW');
    expect(order()).toEqual(['a', '<!--o-->', 'b', '<!--c-->', 'NEW', 'BR', 'c']);
  });

  it('最後のパーツが inline の改ページ(after)を持てば、改ページ指定は動かさず次のページの先頭に入る', () => {
    load('<p class="a" style="break-after: page">1</p><p class="b">2</p>');
    g.goToPage(0);
    g.insertPart('<section>new</section>', 'NEW');
    expect(order()).toEqual(['a', 'NEW', 'b']);
    expect(g.getBodyHtml()).toMatch(/class="a" style="break-after: ?page;?"/);
    g.refreshPageMarks();
    expect(
      g.pageBlocks.value.map((p) => p.map((el) => el.getAttribute('data-part-id') ?? el.className)),
    ).toEqual([['a'], ['NEW', 'b']]);
  });

  it('白紙のページでは、そのページの区切りの直前へ入り、白紙のページのパーツになる', () => {
    load(`${BR}<p class="a">1</p>${BR}${BR}<p class="b">2</p>`);
    g.goToPage(2);
    g.insertPart('<section>new</section>', 'NEW');
    expect(order()).toEqual(['BR', 'a', 'BR', 'NEW', 'BR', 'b']);
    g.goToPage(0);
    g.insertPart('<section>top</section>', 'TOP');
    expect(order()).toEqual(['TOP', 'BR', 'a', 'BR', 'NEW', 'BR', 'b']);
    g.refreshPageMarks();
    expect(
      g.pageBlocks.value.map((p) => p.map((el) => el.getAttribute('data-part-id') ?? el.className)),
    ).toEqual([['TOP'], ['a'], ['NEW'], ['b']]);
  });

  it('要素の無い白紙のページ(左右合わせ)では、次のページの先頭の直前へ入る', () => {
    load('<p class="a">1</p><p class="b" style="break-before: right">2</p>');
    expect(g.pageCount.value).toBe(3);
    g.goToPage(1);
    g.insertPart('<section>new</section>', 'NEW');
    expect(order()).toEqual(['a', 'NEW', 'b']);
    // 入ったのは 1 ページ目の末尾なので、1 ページ表示はそのページへ送り、選んだパーツを見せる。
    expect(g.currentPageIndex.value).toBe(0);
    expect(g.editor.value?.getSelected()?.getAttributes()['data-part-id']).toBe('NEW');
  });

  it('inline の改ページ(after)の後ろに入ったパーツは、次のページへ送って選ぶ', () => {
    load('<p class="a" style="break-after: page">1</p><p class="b">2</p>');
    g.goToPage(0);
    g.insertPart('<section>new</section>', 'NEW');
    expect(g.currentPageIndex.value).toBe(1);
    expect(g.editor.value?.getSelected()?.getAttributes()['data-part-id']).toBe('NEW');
  });

  it('全ページ表示では、挿入してもページの位置を動かさない', () => {
    load('<p class="a" style="break-after: page">1</p><p class="b">2</p>');
    g.setSinglePageMode(false);
    g.goToPage(0);
    g.insertPart('<section>new</section>', 'NEW');
    expect(g.currentPageIndex.value).toBe(0);
  });

  it('境目の要素を component と照合できなければ、本文の末尾へ入れず何もしない', () => {
    const root = load(DOC);
    g.goToPage(0);
    // 再描画で区切りの要素だけが入れ替わり、component の `getEl()` が古い要素を指したままの状態。
    const br = root.querySelector(':scope > div.pagebreak') as HTMLElement;
    br.replaceWith(br.cloneNode(true));
    g.insertPart('<section>new</section>', 'NEW');
    expect(order()).toEqual(['a', 'BR', 'b', 'b2', 'BR', 'c']);
  });

  it('挿入したパーツを選び、data-part-id を付ける', () => {
    load(DOC);
    g.insertPart('<section>new</section>', 'NEW');
    expect(g.editor.value?.getSelected()?.getAttributes()['data-part-id']).toBe('NEW');
  });
});

describe('setPartBreak', () => {
  /** `useTemplateEditor.ts` と同じく、操作の前に 1 回だけ snapshot を積む Undo。 */
  function history() {
    return useSnapshotHistory(
      () => ({ html: g.getBodyHtml(), css: g.getCss() }),
      (snap) => {
        g.load(snap.html, snap.css);
        render();
      },
    );
  }

  it('after を ON にすると直後に区切りが 1 つ増え、ページが 1 つ増え、Undo 1 回で戻る', () => {
    load(DOC);
    const h = history();
    const before = g.getBodyHtml();
    h.pushUndo();
    expect(g.setPartBreak(byClass('b'), 'after', true)).toBe(true);
    render();
    expect(order()).toEqual(['a', 'BR', 'b', 'BR', 'b2', 'BR', 'c']);
    expect(g.pageCount.value).toBe(4);
    // 区切りは属性を持たない素の div(自動 id を保存内容に載せない)。
    expect(g.getBodyHtml()).toContain(
      '<p class="b">2</p><div class="pagebreak"></div><p class="b2">',
    );
    h.undo();
    expect(g.getBodyHtml()).toBe(before);
    expect(g.pageCount.value).toBe(3);
  });

  it('before を ON にすると、選んだ要素が属するパーツの直前に入る', () => {
    load(`<p class="a">1</p><div class="b"><span class="in">x</span></div>`);
    expect(g.setPartBreak(byClass('in'), 'before', true)).toBe(true);
    expect(order()).toEqual(['a', 'BR', 'b']);
  });

  it('ON にすると、その端の印刷で効かない inline の page-break-* を区切りに置き換える', () => {
    load('<p class="a" style="page-break-after: always; color: red">1</p><p class="b">2</p>');
    expect(g.pageBreakFacts.value.ignoredInline).toBe(1);
    expect(g.setPartBreak(byClass('a'), 'after', true)).toBe(true);
    render();
    expect(order()).toEqual(['a', 'BR', 'b']);
    expect(g.getBodyHtml()).not.toContain('page-break-after');
    expect(g.getBodyHtml()).toMatch(/class="a" style="color: ?red;?"/);
    expect(g.pageBreakFacts.value.ignoredInline).toBe(0);
  });

  it('OFF にすると隣の区切りと inline の break-after を消し、Undo 1 回で両方戻る', () => {
    load(`<p class="a">1</p><p class="b" style="break-after: page">2</p>${BR}<p class="c">3</p>`);
    // inline の after の直後の区切りは白紙のページを作る。
    expect(g.pageCount.value).toBe(3);
    const h = history();
    const before = g.getBodyHtml();
    h.pushUndo();
    expect(g.setPartBreak(byClass('b'), 'after', false)).toBe(true);
    // テストの view は GrapesJS の frame に登録されず、モデルの削除で要素が外れないので描き直す。
    render();
    expect(order()).toEqual(['a', 'b', 'c']);
    expect(g.getBodyHtml()).not.toContain('break-after');
    expect(g.pageCount.value).toBe(1);
    h.undo();
    expect(g.getBodyHtml()).toBe(before);
  });

  it('状態が変わらない操作・区切り自身・固めた範囲の包みは何もしない(false)', () => {
    const FROZEN = `<div data-gjs-type="jinja-frozen" class="jinja-frozen-body" data-opaque="eA==" data-opaque-kind="body">${DOC}</div>`;
    load(DOC);
    const html = g.getBodyHtml();
    expect(g.setPartBreak(byClass('a'), 'after', true)).toBe(false);
    expect(g.setPartBreak(byClass('a'), 'before', false)).toBe(false);
    expect(g.setPartBreak(byClass('pagebreak'), 'after', true)).toBe(false);
    expect(g.getBodyHtml()).toBe(html);
    load(FROZEN);
    expect(g.partBreakOf(byClass('jinja-frozen-body'))).toBeNull();
    expect(g.setPartBreak(byClass('jinja-frozen-body'), 'after', true)).toBe(false);
  });

  it('区切りの帯・既定の配置のパーツへの配置の初期化は変更にならず、Undo を積まず Redo を残す', () => {
    // `useTemplateEditor.ts` の `resetGeom` と同じ手順(begin → 変わらなければ cancel)。
    load(DOC);
    const h = history();
    h.pushUndo();
    expect(g.setPartBreak(byClass('a'), 'before', true)).toBe(true);
    h.undo();
    expect(h.canRedo.value).toBe(true);
    const html = g.getBodyHtml();
    for (const cls of ['pagebreak', 'a']) {
      g.editor.value?.select(byClass(cls));
      h.beginUndo();
      if (g.patchSelectedStyle(geomToStyle(DEFAULT_GEOM))) h.commitUndo();
      else h.cancelUndo();
    }
    expect(g.getBodyHtml()).toBe(html);
    expect(h.canUndo.value).toBe(false);
    expect(h.canRedo.value).toBe(true);
  });

  it('partBreakOf は選んだ要素が属するパーツの前後の状態を返す', () => {
    load(
      `<p class="a" style="break-after: page">1</p>${BR}<div class="b"><span class="in">x</span></div>`,
    );
    expect(g.partBreakOf(byClass('a'))).toEqual({ before: null, after: 'div' });
    expect(g.partBreakOf(byClass('in'))).toEqual({ before: 'div', after: null });
    expect(g.partBreakOf(undefined)).toBeNull();
  });
});

it('ページの印(data-pv-idx)は保存内容に出ない', () => {
  load(DOC);
  g.goToPage(1);
  expect(viewEl?.querySelector(`[${PV_ATTR}]`)).not.toBeNull();
  expect(g.getBodyHtml()).not.toContain(PV_ATTR);
});
