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
      targetHtml: '',
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
    const r = rerenderUneditedJinjaParts({
      sourceHtml: src,
      catalog,
      sourceValues,
      targetValues,
      targetHtml: '',
    });
    expect(r.html).toBe(src);
    expect(r.edited).toEqual(['note-a#1']);
    expect(r.rerendered).toEqual([]);
  });

  it('属性の引用符や空白の書き方が変わっただけのパーツも edited に倒す', () => {
    const src = doc(
      "<section class='note' data-part-id='note-a'><p>交付ファンドの注記</p></section>",
    );
    const r = rerenderUneditedJinjaParts({
      sourceHtml: src,
      catalog,
      sourceValues,
      targetValues,
      targetHtml: '',
    });
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
      targetHtml: '',
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
      targetHtml: '',
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
      targetHtml: '',
    });
    expect(r.rerendered).toEqual(['note-a#1']);
    expect(r.html).toContain('<p>の注記</p>');
    expect(r.blanks).toEqual([{ partKey: 'note-a#1', missing: ['fund.name'], unsupported: [] }]);
  });

  it('同じパーツが 2 回あれば、出現ごとに判定する', () => {
    const src = doc(inserted('交付ファンド'), inserted('手で直した'));
    const r = rerenderUneditedJinjaParts({
      sourceHtml: src,
      catalog,
      sourceValues,
      targetValues,
      targetHtml: '',
    });
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
      targetHtml: '',
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
      targetHtml: '',
    });
    expect(r.html).toContain(`<p data-part-id='q"x'>全体ファンド</p>`);
  });

  it('data-part-id は根の属性の末尾に付ける(挿入時の addAttributes と同じ位置)', () => {
    const r = rerenderUneditedJinjaParts({
      sourceHtml: doc(inserted('交付ファンド')),
      catalog,
      sourceValues,
      targetValues,
      targetHtml: '',
    });
    expect(r.html).toContain(inserted('全体ファンド'));
  });

  it('自己終了の根でも、`/>` の前に付ける', () => {
    const r = rerenderUneditedJinjaParts({
      sourceHtml: doc('<img alt="交付ファンド" data-part-id="i" />'),
      catalog: new Map([['i', '<img alt="{{ fund.name }}" />']]),
      sourceValues,
      targetValues,
      targetHtml: '',
    });
    expect(r.html).toContain('<img alt="全体ファンド" data-part-id="i" />');
  });

  it('写し先の同じパーツも直していなければ、写し先のバイト列をそのまま使う', () => {
    // 写し先は別の書き方(属性間の空白)で挿入されている。描いた結果で置き換えると、生の HTML の
    // SHA-1 で比べるペア同期が「変わった」と見る。
    const current =
      '<section class="note"  data-part-id="note-a">\n<p>全体ファンドの注記</p>\n</section>';
    const r = rerenderUneditedJinjaParts({
      sourceHtml: doc(inserted('交付ファンド')),
      catalog,
      sourceValues,
      targetValues,
      targetHtml: doc(current),
    });
    expect(r.rerendered).toEqual(['note-a#1']);
    expect(r.html).toBe(doc(current));
  });

  it('写し先の同じパーツが直されていれば、写し先の値で描いた結果を使う', () => {
    const r = rerenderUneditedJinjaParts({
      sourceHtml: doc(inserted('交付ファンド')),
      catalog,
      sourceValues,
      targetValues,
      targetHtml: doc(inserted('全体ファンド(改)')),
    });
    expect(r.html).toBe(doc(inserted('全体ファンド')));
  });

  describe('safe で値の HTML をそのまま描くパーツ', () => {
    const safeCatalog = new Map([['s', '<section class="s">{{ note|safe }}</section>']]);
    const approved = (inner: string) =>
      doc(`<section class="s" data-part-id="s">${inner}</section>`);

    it('写し先の値が地の HTML なら描き直す(エスケープしない)', () => {
      const r = rerenderUneditedJinjaParts({
        sourceHtml: approved('交付<br>注記'),
        catalog: safeCatalog,
        sourceValues: { note: '交付<br>注記' },
        targetValues: { note: '全体<br>注記' },
        targetHtml: '',
      });
      expect(r.rerendered).toEqual(['s#1']);
      expect(r.html).toContain('全体<br>注記');
    });

    it.each([
      ['イベント属性', '<img src="x" onerror="alert(1)">'],
      ['`/` で区切ったイベント属性', '<img/src=x/onerror=alert(1)>'],
      ['javascript: の URL', '<a href="javascript:alert(1)">x</a>'],
      ['script 要素', '<script>alert(1)</script>'],
      ['svg の中の script', '<svg><script>alert(1)</script></svg>'],
      ['往復用の印', '<span class="jinja-chip jinja-var" data-jinja="e3sgeCB9fQ==">x</span>'],
    ])('写し先の値が%sを持てば、許可した形ではないのでエスケープして描き、警告に残す', (_, bad) => {
      const r = rerenderUneditedJinjaParts({
        sourceHtml: approved('交付<br>注記'),
        catalog: safeCatalog,
        sourceValues: { note: '交付<br>注記' },
        targetValues: { note: `全体${bad}` },
        targetHtml: '',
      });
      expect(r.rerendered).toEqual(['s#1']);
      expect(r.html).not.toContain(bad);
      expect(r.html).toContain('全体&lt;');
      expect(r.blanks).toEqual([{ partKey: 's#1', missing: [], unsupported: ['note|safe'] }]);
    });
  });

  it('パーツ自身が持つ能動コンテンツは、値を描き直しても並びが変わらないので描き直す', () => {
    const tpl = '<section class="j"><script>var a = 1;</script><p>{{ fund.name }}</p></section>';
    const r = rerenderUneditedJinjaParts({
      sourceHtml: doc(
        '<section class="j" data-part-id="j"><script>var a = 1;</script><p>交付ファンド</p></section>',
      ),
      catalog: new Map([['j', tpl]]),
      sourceValues,
      targetValues,
      targetHtml: '',
    });
    expect(r.rerendered).toEqual(['j#1']);
    expect(r.html).toContain('<p>全体ファンド</p>');
  });

  it('根が複数のパーツ(editor は先頭の根だけに data-part-id を付ける)は edited になる', () => {
    const src = doc('<p data-part-id="m">交付ファンド</p>');
    const r = rerenderUneditedJinjaParts({
      sourceHtml: src,
      catalog: new Map([['m', '<p>{{ fund.name }}</p><p>2 つ目</p>']]),
      sourceValues,
      targetValues,
      targetHtml: '',
    });
    expect(r.html).toBe(src);
    expect(r.edited).toEqual(['m#1']);
  });
});
