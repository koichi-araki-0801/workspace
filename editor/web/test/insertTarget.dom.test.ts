// =============================================================================
// insertTarget.dom.test.ts — パーツの挿入先と「このページに挿入できるか」
// =============================================================================
// 挿入先は現在ページの範囲の末尾。次の区切り(ページの境目)が固めた範囲の包みの中にあるときは、
// 包みの中身は原文から作り直されて挿入が保存で消えるので、挿入できない。
import { describe, expect, it } from 'vitest';
import { insertTarget } from '@/features/editor/insertTarget';

const BR = (id: string) => `<div class="pagebreak" id="${id}"></div>`;
const FROZEN = (inner: string) => `<div class="jinja-frozen-body">${inner}</div>`;

function root(html: string): HTMLElement {
  const r = document.createElement('div');
  r.innerHTML = html;
  return r;
}
const at = (r: HTMLElement, id: string) => r.querySelector(`#${id}`) as HTMLElement;

describe('insertTarget', () => {
  it('このページのパーツを選んでいれば、その直後', () => {
    const r = root(`<p id="a"></p><p id="b"></p>${BR('k1')}<p id="c"></p>`);
    expect(insertTarget(r, 0, at(r, 'a'))).toEqual({ kind: 'after', el: at(r, 'a') });
  });

  it('選んでいない・別のページのパーツを選んでいれば、次の区切りの直前', () => {
    const r = root(`<p id="a"></p>${BR('k1')}<p id="c"></p>`);
    expect(insertTarget(r, 0)).toEqual({ kind: 'before', el: at(r, 'k1') });
    expect(insertTarget(r, 0, at(r, 'c'))).toEqual({ kind: 'before', el: at(r, 'k1') });
  });

  it('最後のページは末尾', () => {
    const r = root(`<p id="a"></p>${BR('k1')}<p id="c"></p>`);
    expect(insertTarget(r, 1)).toEqual({ kind: 'end' });
  });

  it('白紙のページはその区切りの直前、要素の無い白紙のページは次のページの先頭の直前', () => {
    const r1 = root(`<p id="a"></p>${BR('k1')}${BR('k2')}<p id="b"></p>`);
    expect(insertTarget(r1, 1)).toEqual({ kind: 'before', el: at(r1, 'k2') });
    const r2 = root('<p id="a"></p><p id="b" style="break-before:right"></p>');
    expect(insertTarget(r2, 1)).toEqual({ kind: 'before', el: at(r2, 'b') });
  });

  it('inline の break-after で分かれたページは、次のページの先頭の直前', () => {
    const r = root('<p id="a" style="break-after:page"></p><p id="b"></p>');
    expect(insertTarget(r, 0)).toEqual({ kind: 'before', el: at(r, 'b') });
  });

  it('次の区切りが固めた範囲の包みの中なら挿入できない', () => {
    const r = root(FROZEN(`<p id="a"></p>${BR('k1')}<p id="b"></p>`));
    expect(insertTarget(r, 0)).toEqual({ kind: 'blocked' });
  });

  it('白紙のページの区切りが包みの中なら挿入できない', () => {
    const r = root(`<p id="a"></p>${BR('k1')}${FROZEN(BR('k2'))}<p id="b"></p>`);
    expect(insertTarget(r, 1)).toEqual({ kind: 'blocked' });
  });

  it('次のページの先頭を包みが抱えていれば挿入できない', () => {
    const r = root(`<p id="a" style="break-after:page"></p>${FROZEN('<p id="b"></p>')}`);
    expect(insertTarget(r, 0)).toEqual({ kind: 'blocked' });
  });

  it('包みの中の最後のパーツでも、区切りが包みの外にあれば区切りの直前', () => {
    const r = root(`${FROZEN('<p id="a"></p>')}${BR('k1')}<p id="b"></p>`);
    expect(insertTarget(r, 0)).toEqual({ kind: 'before', el: at(r, 'k1') });
  });

  it('包みの中の最後のパーツで、後ろに区切りが無ければ末尾', () => {
    const r = root(`<p id="x"></p>${BR('k1')}${FROZEN('<p id="a"></p>')}`);
    expect(insertTarget(r, 1)).toEqual({ kind: 'end' });
  });

  it('包みで挿入できないページでも、根の直下のパーツを選んでいればその直後に入れられる', () => {
    const r = root(`<p id="s"></p>${FROZEN(`<p id="a"></p>${BR('k1')}`)}<p id="b"></p>`);
    expect(insertTarget(r, 0)).toEqual({ kind: 'blocked' });
    expect(insertTarget(r, 0, at(r, 's'))).toEqual({ kind: 'after', el: at(r, 's') });
  });

  it('包みの中の区切りが次のページの境目になるなら、最後のパーツの直後が包みでも挿入できない', () => {
    const r = root(`<p id="a"></p>${FROZEN(BR('k1'))}<p id="b"></p>`);
    expect(insertTarget(r, 0)).toEqual({ kind: 'blocked' });
  });

  it('範囲外のページで、後ろに区切りが無ければ末尾', () => {
    const r = root('<p id="a"></p>');
    expect(insertTarget(r, 5)).toEqual({ kind: 'end' });
  });
});
