import { describe, expect, it } from 'vitest';
import { partBreakLabel, partBreakState, planBreakToggle } from '@/features/editor/partBreak';

// =============================================================================
// partBreak.dom.test.ts — Inspector の「前で改ページ / 後で改ページ」の状態と操作の決め方
// =============================================================================
// 状態はパーツ(根の直下)の前後の区切り(`div.pagebreak`)か inline の改ページで決まり、
// ON は区切りを 1 つ置く、OFF は隣の区切りと inline の該当の宣言を消す。

const BR = '<div class="pagebreak"></div>';

function root(html: string): HTMLElement {
  const el = document.createElement('div');
  el.innerHTML = html;
  return el;
}

function q(r: Element, sel: string): Element {
  const el = r.querySelector(sel);
  if (!el) throw new Error(`no ${sel}`);
  return el;
}

describe('partBreakState', () => {
  it('直前・直後の兄弟が区切りなら div', () => {
    const r = root(`<p class="a"></p>${BR}<p class="b"></p>${BR}<p class="c"></p>`);
    expect(partBreakState(q(r, '.b'), r)).toEqual({ before: 'div', after: 'div' });
  });

  it('inline の break-before / break-after なら inline', () => {
    const r = root(
      '<p class="a"></p><p class="b" style="break-before: left; break-after: page"></p>',
    );
    expect(partBreakState(q(r, '.b'), r)).toEqual({ before: 'inline', after: 'inline' });
  });

  it('inline の page-break-* と break-*: always は改ページにならないので OFF(印刷でも効かない)', () => {
    const r = root(
      '<p class="a"></p><p class="b" style="page-break-before: always; break-after: always"></p>',
    );
    expect(partBreakState(q(r, '.b'), r)).toEqual({ before: null, after: null });
  });

  it('どちらも無ければ null', () => {
    const r = root('<p class="a"></p><p class="b"></p><p class="c"></p>');
    expect(partBreakState(q(r, '.b'), r)).toEqual({ before: null, after: null });
  });

  it('区切りと inline の両方があれば区切りを採る', () => {
    const r = root(`${BR}<p class="b" style="break-before: page"></p>`);
    expect(partBreakState(q(r, '.b'), r)?.before).toBe('div');
  });

  it('間の赤入れの削除要素と <style> は飛ばして隣を見る', () => {
    const r = root(
      `<p class="a"></p>${BR}<del data-redline=""></del><style></style><p class="b"></p>`,
    );
    expect(partBreakState(q(r, '.b'), r)?.before).toBe('div');
  });

  it('根の直下でない要素・区切り自身・固めた範囲の包みは対象にしない(null)', () => {
    const r = root(
      `<div class="x"><p class="in"></p></div>${BR}` +
        `<div class="jinja-frozen-body"><p class="fz"></p></div>`,
    );
    expect(partBreakState(q(r, '.in'), r)).toBeNull();
    expect(partBreakState(q(r, '.pagebreak'), r)).toBeNull();
    expect(partBreakState(q(r, '.jinja-frozen-body'), r)).toBeNull();
    expect(partBreakState(q(r, '.fz'), r)).toBeNull();
  });

  it('隣の区切りが固めた範囲の包みの中にあれば数えない(消せないため)', () => {
    const r = root(`<div class="jinja-frozen-body"><p></p>${BR}</div><p class="b"></p>`);
    expect(partBreakState(q(r, '.b'), r)?.before).toBeNull();
  });
});

describe('planBreakToggle', () => {
  it('ON は直前(直後)に区切りを挿入する', () => {
    const r = root('<p class="a"></p><p class="b"></p>');
    expect(planBreakToggle(q(r, '.b'), r, 'before', true)).toEqual({
      insert: 'before',
      remove: [],
      stripProps: [],
    });
    expect(planBreakToggle(q(r, '.b'), r, 'after', true)?.insert).toBe('after');
  });

  it('既に ON なら何もしない(null)', () => {
    const r = root(`<p class="a"></p>${BR}<p class="b" style="break-after: page"></p>`);
    expect(planBreakToggle(q(r, '.b'), r, 'before', true)).toBeNull();
    expect(planBreakToggle(q(r, '.b'), r, 'after', true)).toBeNull();
  });

  it('OFF は直前の区切りを消し、inline の該当の宣言も消す', () => {
    const r = root(`<p class="a"></p>${BR}<p class="b" style="break-before: page"></p>`);
    const plan = planBreakToggle(q(r, '.b'), r, 'before', false);
    expect(plan?.insert).toBeNull();
    expect(plan?.remove).toEqual([q(r, '.pagebreak')]);
    expect(plan?.stripProps).toEqual(['page-break-before', 'break-before']);
  });

  // 連続した区切りは間に白紙のページを作る。OFF はその白紙のページごと消す(1 つ残すと ON のまま)。
  it('OFF は連続した区切りをまとめて消す(1 つ残すと ON のまま)', () => {
    const r = root(`<p class="a"></p><p class="b"></p>${BR}${BR}<p class="c"></p>`);
    const plan = planBreakToggle(q(r, '.b'), r, 'after', false);
    expect(plan?.remove).toEqual(Array.from(r.querySelectorAll('.pagebreak')));
    expect(plan?.stripProps).toEqual([]);
  });

  it('OFF で inline だけなら区切りは消さず宣言だけを消す', () => {
    const r = root('<p class="b" style="break-after: page"></p><p class="c"></p>');
    expect(planBreakToggle(q(r, '.b'), r, 'after', false)).toEqual({
      insert: null,
      remove: [],
      stripProps: ['page-break-after', 'break-after'],
    });
  });

  it('既に OFF・対象外のパーツなら何もしない(null)', () => {
    const r = root(`<p class="b"></p><div class="x"><p class="in"></p></div>`);
    expect(planBreakToggle(q(r, '.b'), r, 'after', false)).toBeNull();
    expect(planBreakToggle(q(r, '.in'), r, 'after', true)).toBeNull();
  });
});

describe('partBreakLabel', () => {
  it('修正履歴の文言', () => {
    expect(partBreakLabel('before', true)).toBe('「前で改ページ」を有効化');
    expect(partBreakLabel('before', false)).toBe('「前で改ページ」を解除');
    expect(partBreakLabel('after', true)).toBe('「後で改ページ」を有効化');
    expect(partBreakLabel('after', false)).toBe('「後で改ページ」を解除');
  });
});
