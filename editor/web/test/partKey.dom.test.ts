import type { Editor } from 'grapesjs';
import { describe, expect, it, vi } from 'vitest';
import { buildHtmlDiff } from '@/features/compare/htmlBlockDiff';
import {
  canvasRawKey,
  legacyPartKeyCount,
  pagesOf,
  partLabelMap,
  partOf,
  partPageIndexMap,
  partPathKeyFor,
  partsOf,
} from '@/features/editor/partKey';
import { partMapsFromHtml } from '@/features/reviews/reviewPartMaps';
import { occurrenceKey, rawKey, rawKeyFromParts } from '@/lib/blockKey';

/** innerHTML から canvas wrapper 相当の root 要素を作る(jsdom)。 */
function root(html: string): HTMLElement {
  const r = document.createElement('div');
  r.innerHTML = html.trim();
  return r;
}

const q = (r: HTMLElement, sel: string): HTMLElement => {
  const el = r.querySelector(sel);
  if (!(el instanceof HTMLElement)) throw new Error(`not found: ${sel}`);
  return el;
};

describe('blockKey.rawKey', () => {
  it('prefers data-part-id, then id, then first class, then tag', () => {
    expect(rawKey(q(root('<div data-part-id="cover" id="x" class="c">'), 'div'))).toBe('cover');
    expect(rawKey(q(root('<div id="x" class="c">'), 'div'))).toBe('x');
    expect(rawKey(q(root('<div class="c d">'), 'div'))).toBe('.c');
    expect(rawKey(q(root('<section>'), 'section'))).toBe('section');
  });
});

describe('blockKey.rawKeyFromParts', () => {
  it('rawKey(el) と同じ優先順で、要素を持たずにキーを作る', () => {
    expect(rawKeyFromParts({ partId: 'cover', id: 'x', firstClass: 'c', tag: 'div' })).toBe(
      'cover',
    );
    expect(rawKeyFromParts({ id: 'x', firstClass: 'c', tag: 'div' })).toBe('x');
    expect(rawKeyFromParts({ firstClass: 'c', tag: 'div' })).toBe('.c');
    expect(rawKeyFromParts({ tag: 'SECTION' })).toBe('section');
    // 空文字・null は「無し」として次の候補へ落ちる
    expect(rawKeyFromParts({ partId: '', id: null, firstClass: '', tag: 'p' })).toBe('p');
  });
});

describe('blockKey.occurrenceKey', () => {
  it('numbers same-key siblings in order (1-based)', () => {
    const r = root('<table class="s"></table><table class="s"></table><div></div>');
    const els = Array.from(r.children) as HTMLElement[];
    expect(occurrenceKey(els[0], els)).toBe('.s#1');
    expect(occurrenceKey(els[1], els)).toBe('.s#2');
    expect(occurrenceKey(els[2], els)).toBe('div#1');
  });
});

describe('partPathKeyFor — 版を跨いで安定', () => {
  it('同じ catalog パーツは基準日/版種が違っても同じキーになる', () => {
    const kofu = root(
      '<div data-part-id="cover">交付版 2024</div><table class="summary"><tbody><tr><td>100</td></tr></tbody></table>',
    );
    const zentai = root(
      '<div data-part-id="cover">全体版 2025</div><table class="summary"><tbody><tr><td>200</td></tr></tbody></table>',
    );
    const k1 = partPathKeyFor(q(kofu, '[data-part-id="cover"]'), kofu);
    const k2 = partPathKeyFor(q(zentai, '[data-part-id="cover"]'), zentai);
    expect(k1).toBe('cover#1');
    expect(k2).toBe(k1);
  });

  it('パーツ内の子要素を選んでも、囲うパーツのキーへ解決する', () => {
    const r = root(
      '<div data-part-id="cover">表紙</div><table class="summary"><tbody><tr><td>cell</td></tr></tbody></table>',
    );
    const fromCell = partPathKeyFor(q(r, 'td'), r);
    const fromTable = partPathKeyFor(q(r, 'table'), r);
    expect(fromCell).toBe('.summary#1');
    expect(fromCell).toBe(fromTable);
  });

  it('キーは区切りを跨いだ文書全体の通し番号で、ページを含まない', () => {
    const r = root(
      '<section class=s></section><div class=pagebreak></div><section class=s></section>',
    );
    const [first, , second] = Array.from(r.children) as HTMLElement[];
    expect(partPathKeyFor(first, r)).toBe('.s#1');
    expect(partPathKeyFor(second, r)).toBe('.s#2');
  });

  it('区切りを選ぶと null、パーツの中の子を選ぶと囲むパーツのキー', () => {
    const r = root(
      '<section class=s></section><div class=pagebreak></div><section class=s><p>x</p></section>',
    );
    expect(partPathKeyFor(q(r, '.pagebreak'), r)).toBeNull();
    expect(partPathKeyFor(q(r, 'p'), r)).toBe('.s#2');
  });

  it('根そのもの・根の外・数えない要素(<style>・赤入れ)を選ぶと null', () => {
    const r = root('<style>.a{}</style><p class="a">A</p><del data-redline=""><p>gone</p></del>');
    const outside = document.createElement('p');
    expect(partPathKeyFor(r, r)).toBeNull();
    expect(partPathKeyFor(outside, r)).toBeNull();
    expect(partPathKeyFor(q(r, 'style'), r)).toBeNull();
    expect(partPathKeyFor(q(r, 'del p'), r)).toBeNull();
  });

  it('前にページを 1 つ足しても、後ろの別クラスのパーツのキーは変わらない', () => {
    const before = root('<h1 class="t">A</h1><div class=pagebreak></div><p class="lead">B</p>');
    const after = root(
      '<h1 class="t">A</h1><div class=pagebreak></div><table class="new"></table>' +
        '<div class=pagebreak></div><p class="lead">B</p>',
    );
    expect(partPathKeyFor(q(after, '.lead'), after)).toBe(
      partPathKeyFor(q(before, '.lead'), before),
    );
    expect(partPathKeyFor(q(after, '.lead'), after)).toBe('.lead#1');
  });

  it('inline の改ページで分かれても、キーは通し番号のまま', () => {
    const r = root('<p class="a">1</p><p class="a" style="break-before:page">2</p>');
    const [, second] = Array.from(r.children) as HTMLElement[];
    expect(partPathKeyFor(second, r)).toBe('.a#2');
  });
});

describe('partsOf / partOf / pagesOf', () => {
  it('partsOf は区切りと数えない要素を除いた根の直下のパーツ', () => {
    const r = root(
      '<style>.a{}</style><p class="a">A</p><div class=pagebreak></div>' +
        '<span data-body-style=""></span><del data-redline=""></del><p class="b">B</p>',
    );
    expect(partsOf(r).map((e) => e.className)).toEqual(['a', 'b']);
    expect(pagesOf(r).map((p) => p.map((e) => e.className))).toEqual([['a'], ['b']]);
  });

  it('partOf は根の直下のパーツまでさかのぼり、パーツでなければ null', () => {
    const r = root('<div class="x"><span>in</span></div><div class=pagebreak></div>');
    expect(partOf(q(r, 'span'), r)).toBe(q(r, '.x'));
    expect(partOf(q(r, '.pagebreak'), r)).toBeNull();
  });

  it('パーツが無い根は 1 ページ・0 パーツ', () => {
    const r = root('');
    expect(partsOf(r)).toEqual([]);
    expect(pagesOf(r)).toEqual([[]]);
    expect(partLabelMap(r).size).toBe(0);
  });
});

describe('legacyPartKeyCount — 旧形式(ページ/パーツ)のキーを数える', () => {
  it('/ を含むキーだけを数える', () => {
    expect(legacyPartKeyCount(['.s#1', 'body#1/.s#1', '.page#2/.x#1'])).toBe(2);
    expect(legacyPartKeyCount([])).toBe(0);
    expect(legacyPartKeyCount(new Set(['cover#1']))).toBe(0);
  });
});

describe('partLabelMap — 全パーツの人間向けラベル', () => {
  it('各パーツに ページN・パーツM を振り、キーは partPathKeyFor と一致する', () => {
    const r = root(
      '<div data-part-id="cover">表紙</div><table class="summary"></table>' +
        '<div class=pagebreak></div><h1 class="t">本文</h1>',
    );
    const map = partLabelMap(r);
    const coverKey = partPathKeyFor(q(r, '[data-part-id="cover"]'), r);
    const summaryKey = partPathKeyFor(q(r, '.summary'), r);
    const bodyKey = partPathKeyFor(q(r, '.t'), r);
    expect(coverKey).toBe('cover#1');
    expect(map.get(coverKey ?? '')).toBe('ページ1・パーツ1');
    expect(map.get(summaryKey ?? '')).toBe('ページ1・パーツ2');
    expect(map.get(bodyKey ?? '')).toBe('ページ2・パーツ1');
    expect(map.size).toBe(3);
  });

  it('2 ページ目の先頭のパーツは ページ2・パーツ1、ページ index は 1', () => {
    const r = root(
      '<section class=s></section><div class=pagebreak></div><section class=s></section>',
    );
    expect(partLabelMap(r).get('.s#2')).toBe('ページ2・パーツ1');
    expect(partPageIndexMap(r).get('.s#2')).toBe(1);
  });
});

describe('canvasRawKey — canvas 側は id をモデルの明示属性から読む', () => {
  /** `Components.getById` だけを持つ最小の `Editor` 相当。 */
  function fakeEditor(attrsById: Record<string, Record<string, unknown>>): Editor {
    return {
      Components: { getById: (id: string) => ({ get: () => attrsById[id] }) },
    } as unknown as Editor;
  }

  it('モデル属性に id が無ければ GrapesJS の自動 id を無視し、class/tag へ落ちる', () => {
    const r = root('<p class="lead" id="i1">A</p><p class="lead" id="i2">B</p>');
    const els = Array.from(r.children) as HTMLElement[];
    const keyOf = canvasRawKey(fakeEditor({ i1: {}, i2: {} }));
    expect(occurrenceKey(els[0], els, keyOf)).toBe('.lead#1');
    expect(occurrenceKey(els[1], els, keyOf)).toBe('.lead#2');
  });

  it('モデル属性に明示 id があれば、その id をキーへ残す', () => {
    const r = root('<p class="lead" id="i1">A</p>');
    const el = q(r, 'p');
    const keyOf = canvasRawKey(fakeEditor({ i1: { id: 'summary' } }));
    expect(occurrenceKey(el, [el], keyOf)).toBe('summary#1');
  });

  it('data-part-id は明示 id より優先する', () => {
    const r = root('<p class="lead" id="i1" data-part-id="cover">A</p>');
    const el = q(r, 'p');
    const keyOf = canvasRawKey(fakeEditor({ i1: { id: 'summary' } }));
    expect(keyOf(el)).toBe('cover');
  });

  it('id もクラスも無い要素はタグ名で表し、GrapesJS の自動 id を引かない', () => {
    const ed = { Components: { getById: vi.fn(() => undefined) } } as unknown as Editor;
    const r = root('<section>x</section>');
    expect(canvasRawKey(ed)(q(r, 'section'))).toBe('section');
    expect(ed.Components.getById).not.toHaveBeenCalled();
  });
});

describe('canvasRawKey — 承認タブ(静的パース)とのキー集合一致', () => {
  it('canvas 側に自動 id が付いていても、静的パース側と同じキー集合になる', () => {
    // data-part-id を持たないテンプレート(seed テンプレートと同条件)を模す。
    const html =
      '<table class="summary"></table><h1 class="t">A</h1>' +
      '<div class="pagebreak"></div><p class="lead">B</p>';
    // canvas 側は GrapesJS が全要素へ揮発性の id(ccid)を付けて回る。モデル側の明示属性は
    // どの要素も持たない(= 静的パース側と同じく class/tag へ落ちるべき)。
    const canvasHtml = html.replace(
      /<(div|table|h1|p)( class="[^"]+")?>/g,
      (_m, tag, cls) => `<${tag}${cls ?? ''} id="i${tag}">`,
    );
    const canvasRoot = root(canvasHtml);
    const ed = { Components: { getById: () => ({ get: () => undefined }) } } as unknown as Editor;
    const canvasKeys = [...partLabelMap(canvasRoot, canvasRawKey(ed)).keys()].sort();
    const staticKeys = [...partMapsFromHtml(html).labels.keys()].sort();
    expect(canvasKeys).toEqual(staticKeys);
  });
});

describe('canvas・承認タブ・比較が同じパーツを同じキーと番号で数える', () => {
  it('<style>・地の文・赤入れ・区切りを含む文書で、3 者のキーとラベルが一致する', () => {
    // 保存される文書(承認・比較が読む)。本文の `<style>` と、根の直下の地の文を含む。
    const html =
      '<style>.a{color:red}</style>地の文<p class="a">A</p><p class="a">A2</p>' +
      '<div class="pagebreak"></div>前置き<section class="s">S</section>' +
      '<div class="pagebreak"></div><style>.b{}</style><p class="a">A3</p>';
    // canvas の生 DOM。`<style>` は置き場の要素、赤入れ表示の削除要素が兄弟に挟まる。
    const canvas = root(
      '<span data-body-style=""></span>地の文<p class="a">A</p>' +
        '<del data-redline="" class="redline-block"><p class="a">gone</p></del><p class="a">A2</p>' +
        '<div class="pagebreak"></div>前置き<section class="s">S</section>' +
        '<div class="pagebreak"></div><span data-body-style=""></span><p class="a">A3</p>',
    );
    const canvasLabels = partLabelMap(canvas);
    const reviewLabels = partMapsFromHtml(html).labels;
    const diffLabels = new Map(
      buildHtmlDiff(html, html)
        .pages.flatMap((p) => p.blocks)
        .filter((b) => b.label.includes('・'))
        .map((b) => [b.partKey, b.label]),
    );
    const want = [
      ['.a#1', 'ページ1・パーツ1'],
      ['.a#2', 'ページ1・パーツ2'],
      ['.s#1', 'ページ2・パーツ1'],
      ['.a#3', 'ページ3・パーツ1'],
    ];
    expect([...canvasLabels]).toEqual(want);
    expect([...reviewLabels]).toEqual(want);
    expect([...diffLabels]).toEqual(want);
  });
});

describe('赤入れ装飾はパーツとして数えない', () => {
  it('[data-redline] の兄弟が挿入されてもパーツ採番とキーが変わらない', () => {
    const plain = root('<p class="a">A</p><p class="b">B</p>');
    const withDel = root(
      '<p class="a">A</p><del data-redline="" class="redline-block"><p class="x">gone</p></del><p class="b">B</p>',
    );
    expect(partsOf(withDel).map((e) => e.className)).toEqual(
      partsOf(plain).map((e) => e.className),
    );
    expect(partPathKeyFor(q(withDel, '.b'), withDel)).toBe(partPathKeyFor(q(plain, '.b'), plain));
    expect([...partLabelMap(withDel)]).toEqual([...partLabelMap(plain)]);
  });
});
