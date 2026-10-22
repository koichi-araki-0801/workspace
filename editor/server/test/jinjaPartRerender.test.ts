// =============================================================================
// jinjaPartRerender.test.ts — 編集タブで挿入した Jinja パーツの、写し先の値での描き直し
// =============================================================================
// 挿入したままのパーツ(カタログの `内容HTML` を写し元の値で描いた形と一致)だけを写し先の値で
// 描き直す。書き方が少しでも違えば「直した」に倒し、承認された HTML を捨てない。
import { describe, expect, it } from 'vitest';
import { normalizePartHtml, rerenderUneditedJinjaParts } from '../src/sync/jinjaPartRerender.js';

const CONTENT = '<section class="note"><p>{{ fund.name }}の注記</p></section>';
const catalog = new Map([['note-a', CONTENT]]);
const sourceValues = { fund: { name: '交付ファンド' } };
const targetValues = { fund: { name: '全体ファンド' } };
const inserted = (text: string) =>
  `<section class="note" data-part-id="note-a"><p>${text}の注記</p></section>`;
const doc = (...parts: string[]) => `<div class="page">\n${parts.join('\n')}\n</div>`;

describe('normalizePartHtml', () => {
  it('data-part-id を除き、タグ間の空白を消し、連続空白を 1 つにする', () => {
    expect(normalizePartHtml('<div  class="a"  data-part-id="x">\n  <p>a   b</p>\n</div>')).toBe(
      '<div class="a"><p>a b</p></div>',
    );
  });

  it('属性の並べ替えはしない', () => {
    expect(normalizePartHtml('<p class="a" id="b"></p>')).not.toBe(
      normalizePartHtml('<p id="b" class="a"></p>'),
    );
  });
});

describe('rerenderUneditedJinjaParts', () => {
  it('直していないパーツは写し先の値で描き直し、data-part-id を保つ', () => {
    const r = rerenderUneditedJinjaParts({
      sourceHtml: doc(inserted('交付ファンド')),
      catalog,
      sourceValues,
      targetValues,
    });
    expect(r.rerendered).toEqual(['note-a#1']);
    expect(r.edited).toEqual([]);
    expect(r.html).toContain('全体ファンドの注記');
    expect(r.html).not.toContain('交付ファンド');
    expect(r.html).toContain('data-part-id="note-a"');
    expect(r.blanks).toEqual([]);
  });

  it('文言を直したパーツはそのまま残し edited に入れる', () => {
    const src = doc(
      '<section class="note" data-part-id="note-a"><p>交付ファンドの注記(改)</p></section>',
    );
    const r = rerenderUneditedJinjaParts({ sourceHtml: src, catalog, sourceValues, targetValues });
    expect(r.html).toBe(src);
    expect(r.edited).toEqual(['note-a#1']);
    expect(r.rerendered).toEqual([]);
  });

  it('属性の引用符や空白の書き方が変わっただけのパーツも edited に倒す', () => {
    const src = doc(
      "<section class='note' data-part-id='note-a'><p>交付ファンドの注記</p></section>",
    );
    const r = rerenderUneditedJinjaParts({ sourceHtml: src, catalog, sourceValues, targetValues });
    expect(r.html).toBe(src);
    expect(r.edited).toEqual(['note-a#1']);
  });

  it('カタログに無い・Jinja を含まないパーツは触らない', () => {
    const src = doc(
      '<section data-part-id="plain"><p>固定文</p></section>',
      '<section data-part-id="ghost"><p>x</p></section>',
    );
    const r = rerenderUneditedJinjaParts({
      sourceHtml: src,
      catalog: new Map([['plain', '<section><p>固定文</p></section>']]),
      sourceValues,
      targetValues,
    });
    expect(r).toEqual({ html: src, rerendered: [], edited: [], blanks: [] });
  });

  it('描画が例外のパーツはそのまま edited', () => {
    const src = doc('<section data-part-id="broken"><p></p></section>');
    const r = rerenderUneditedJinjaParts({
      sourceHtml: src,
      catalog: new Map([['broken', '<section><p>{% if a %}</p></section>']]),
      sourceValues,
      targetValues,
    });
    expect(r.html).toBe(src);
    expect(r.edited).toEqual(['broken#1']);
  });

  it('写し先で値が欠けたパーツは空欄で描き、blanks に欠けた名前を返す', () => {
    const r = rerenderUneditedJinjaParts({
      sourceHtml: doc(inserted('交付ファンド')),
      catalog,
      sourceValues,
      targetValues: {},
    });
    expect(r.rerendered).toEqual(['note-a#1']);
    expect(r.html).toContain('<p>の注記</p>');
    expect(r.blanks).toEqual([{ partKey: 'note-a#1', missing: ['fund.name'], unsupported: [] }]);
  });

  it('同じパーツが 2 回あれば、出現ごとに判定する', () => {
    const src = doc(inserted('交付ファンド'), inserted('手で直した'));
    const r = rerenderUneditedJinjaParts({ sourceHtml: src, catalog, sourceValues, targetValues });
    expect(r.rerendered).toEqual(['note-a#1']);
    expect(r.edited).toEqual(['note-a#2']);
    expect(r.html).toContain('全体ファンドの注記');
    expect(r.html).toContain('手で直したの注記');
  });

  it('描けない書き方は空欄で描き直し、blanks の unsupported に返す', () => {
    const r = rerenderUneditedJinjaParts({
      sourceHtml: doc('<p data-part-id="u">交付ファンド</p>'),
      catalog: new Map([['u', '<p>{{ fund.name }}{{ f() }}</p>']]),
      sourceValues,
      targetValues,
    });
    expect(r.html).toContain('<p data-part-id="u">全体ファンド</p>');
    expect(r.blanks).toEqual([{ partKey: 'u#1', missing: [], unsupported: ['f()'] }]);
  });

  it('id に二重引用符を含むパーツは、単引用符で data-part-id を付け直す', () => {
    const r = rerenderUneditedJinjaParts({
      sourceHtml: doc(`<p data-part-id='q"x'>交付ファンド</p>`),
      catalog: new Map([['q"x', '<p>{{ fund.name }}</p>']]),
      sourceValues,
      targetValues,
    });
    expect(r.html).toContain(`<p data-part-id='q"x'>全体ファンド</p>`);
  });
});
