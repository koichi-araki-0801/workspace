import { describe, expect, it } from 'vitest';
import { partEls, partLabelMap, partPathKeyFor } from '@/features/editor/partKey';
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
      '<div class="page"><div data-part-id="cover">交付版 2024</div><table class="summary"><tbody><tr><td>100</td></tr></tbody></table></div>',
    );
    const zentai = root(
      '<div class="page"><div data-part-id="cover">全体版 2025</div><table class="summary"><tbody><tr><td>200</td></tr></tbody></table></div>',
    );
    const k1 = partPathKeyFor(q(kofu, '[data-part-id="cover"]'), kofu);
    const k2 = partPathKeyFor(q(zentai, '[data-part-id="cover"]'), zentai);
    expect(k1).toBe('.page#1/cover#1');
    expect(k2).toBe(k1);
  });

  it('パーツ内の子要素を選んでも、囲うパーツのキーへ解決する', () => {
    const r = root(
      '<div class="page"><div data-part-id="cover">表紙</div><table class="summary"><tbody><tr><td>cell</td></tr></tbody></table></div>',
    );
    const fromCell = partPathKeyFor(q(r, 'td'), r);
    const fromTable = partPathKeyFor(q(r, 'table'), r);
    expect(fromCell).toBe('.page#1/.summary#1');
    expect(fromCell).toBe(fromTable);
  });

  it('同種パーツの複数挿入は出現順 #n で区別する', () => {
    const r = root(
      '<div class="page"><table class="summary"></table><table class="summary"></table></div>',
    );
    const tables = partEls(q(r, '.page')).filter((e) => e.tagName === 'TABLE');
    expect(partPathKeyFor(tables[0], r)).toBe('.page#1/.summary#1');
    expect(partPathKeyFor(tables[1], r)).toBe('.page#1/.summary#2');
  });

  it('.page が無い構成では body#1 をページアンカーにする', () => {
    const r = root('<div data-part-id="solo">x</div>');
    expect(partPathKeyFor(q(r, '[data-part-id="solo"]'), r)).toBe('body#1/solo#1');
  });

  it('.page 要素自体を選んでも安定なキーを返す(劣化せず文字列)', () => {
    const r = root('<div class="page"><h1 class="t">A</h1></div>');
    const key = partPathKeyFor(q(r, '.page'), r);
    expect(typeof key).toBe('string');
    expect(key?.startsWith('.page#1/')).toBe(true);
  });

  it('ページ番号は出現順(2 ページ目のパーツは .page#2)', () => {
    const r = root(
      '<div class="page"><h1 class="t">A</h1></div><div class="page"><h1 class="t">B</h1></div>',
    );
    const second = q(r.children[1] as HTMLElement, 'h1');
    expect(partPathKeyFor(second, r)).toBe('.page#2/.t#1');
  });
});

describe('partLabelMap — 全パーツの人間向けラベル', () => {
  it('各パーツに ページN・パーツM を通し番号で振り、キーは partPathKeyFor と一致する', () => {
    const r = root(
      '<div class="page"><div data-part-id="cover">表紙</div><table class="summary"></table></div>' +
        '<div class="page"><h1 class="t">本文</h1></div>',
    );
    const map = partLabelMap(r);
    // 同じキー体系(partPathKeyFor と一致)でラベルが引ける。
    const coverKey = partPathKeyFor(q(r, '[data-part-id="cover"]'), r);
    const summaryKey = partPathKeyFor(q(r, '.summary'), r);
    const bodyKey = partPathKeyFor(q(r, '.t'), r);
    expect(coverKey).toBe('.page#1/cover#1');
    expect(map.get(coverKey ?? '')).toBe('ページ1・パーツ1');
    expect(map.get(summaryKey ?? '')).toBe('ページ1・パーツ2');
    expect(map.get(bodyKey ?? '')).toBe('ページ2・パーツ1');
    expect(map.size).toBe(3);
  });

  it('.page が無い構成は body を 1 ページ扱いにする', () => {
    const r = root('<div data-part-id="solo">x</div><p>y</p>');
    const map = partLabelMap(r);
    expect(map.get('body#1/solo#1')).toBe('ページ1・パーツ1');
    expect(map.get('body#1/p#1')).toBe('ページ1・パーツ2');
  });
});

describe('partEls — 赤入れ装飾はパーツとして数えない', () => {
  it('[data-redline] の兄弟が挿入されてもパーツ採番とキーが変わらない', () => {
    const plain = root('<div class="page"><p class="a">A</p><p class="b">B</p></div>');
    const withDel = root(
      '<div class="page"><p class="a">A</p><del data-redline="" class="redline-block"><p class="x">gone</p></del><p class="b">B</p></div>',
    );
    const pagePlain = q(plain, '.page');
    const pageDel = q(withDel, '.page');
    expect(partEls(pageDel).map((e) => e.className)).toEqual(
      partEls(pagePlain).map((e) => e.className),
    );
    expect(partPathKeyFor(q(withDel, '.b'), withDel)).toBe(partPathKeyFor(q(plain, '.b'), plain));
    expect([...partLabelMap(withDel).values()]).toEqual([...partLabelMap(plain).values()]);
  });
});
