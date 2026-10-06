import { describe, expect, it } from 'vitest';
import {
  buildDiffDoc,
  buildHtmlDiff,
  buildHtmlDiffAligned,
  diffHighlightCss,
  HL_ADDED,
  HL_CHANGED,
  HL_DEL,
  HL_INS,
  HL_REMOVED,
  type PagePair,
} from '@/features/compare/htmlBlockDiff';
import { splitPages } from '@/lib/pageBreaks';

/** Wrap body fragments in a minimal HTML document (what renderJinja produces). */
function doc(...body: string[]): string {
  return `<!doctype html><html><body>${body.join('')}</body></html>`;
}

/** 根の直下に置く改ページの区切り。 */
const PB = '<div class="pagebreak"></div>';

describe('buildHtmlDiff', () => {
  it('reports no changes for identical documents', () => {
    const html = doc('<p id="a">hello</p>', '<p id="b">world</p>');
    const diff = buildHtmlDiff(html, html);
    expect(diff.changedPageCount).toBe(0);
    expect(diff.pages).toHaveLength(1);
    expect(diff.pages[0].blocks.every((b) => b.status === 'same')).toBe(true);
    expect(diff.pages[0].afterHtml).not.toContain(HL_INS);
    expect(diff.pages[0].beforeHtml).not.toContain(HL_DEL);
  });

  it('body 直下の地の文もパーツとして拾う(要素だけを内容としない)', () => {
    // `<body>` 直下のテキストノードが要素で包まれていなくても、変更が差分に現れること。
    const before = '<body>手数料は10%<div id="k">x</div></body>';
    const after = '<body>手数料は90%<div id="k">x</div></body>';
    const diff = buildHtmlDiff(before, after);
    expect(diff.changedPageCount).toBe(1);
    expect(diff.pages[0].changedBlockCount).toBeGreaterThan(0);
    const afterMarkup = diff.pages
      .flatMap((p) => p.blocks)
      .map((b) => b.afterHtml)
      .join('');
    expect(afterMarkup).toContain('90'); // 地の文の変更後の値が差分に現れる
  });

  it('flags a changed block and highlights the changed words per pane', () => {
    const before = doc('<p id="a">old</p>');
    const after = doc('<p id="a">new</p>');
    const diff = buildHtmlDiff(before, after);
    expect(diff.changedPageCount).toBe(1);
    const page = diff.pages[0];
    expect(page.changedBlockCount).toBe(1);
    expect(page.blocks[0].status).toBe('changed');
    // 削除語句は before ペインのみ、挿入語句は after ペインのみに着色される。
    expect(page.beforeHtml).toContain(`<span class="${HL_DEL}">old</span>`);
    expect(page.beforeHtml).not.toContain(HL_INS);
    expect(page.afterHtml).toContain(`<span class="${HL_INS}">new</span>`);
    expect(page.afterHtml).not.toContain(HL_DEL);
  });

  it('highlights only the changed words within a sentence, leaving the rest plain', () => {
    const before = doc('<p>sales grew by 105 percent this year</p>');
    const after = doc('<p>sales grew by 112 percent this year</p>');
    const page = buildHtmlDiff(before, after).pages[0];
    expect(page.beforeHtml).toContain(`<span class="${HL_DEL}">105</span>`);
    expect(page.afterHtml).toContain(`<span class="${HL_INS}">112</span>`);
    // 変わっていない語は素のテキストのまま(span に包まれない)。
    expect(page.afterHtml).toContain('sales grew by ');
    expect(page.afterHtml).toContain(' percent this year');
    expect(page.afterHtml).not.toContain('>sales<');
  });

  it('descends into nested elements and highlights only the changed child', () => {
    const before = doc('<div id="card"><p class="a">keep</p><p class="b">old</p></div>');
    const after = doc('<div id="card"><p class="a">keep</p><p class="b">new</p></div>');
    const page = buildHtmlDiff(before, after).pages[0];
    expect(page.blocks[0].status).toBe('changed');
    // 変わった子 (.b) だけが着色され、変わらない子 (.a) は素のまま。
    expect(page.afterHtml).toContain(`<span class="${HL_INS}">new</span>`);
    expect(page.afterHtml).toContain('<p class="a">keep</p>');
  });

  it('does character-level diffing for CJK text', () => {
    const before = doc('<p>前年比は横ばいでした</p>');
    const after = doc('<p>前年比は増加でした</p>');
    const page = buildHtmlDiff(before, after).pages[0];
    // 変わった文字 (横ばい→増加) だけが着色され、前後の共通文字は素のまま。
    expect(page.beforeHtml).toContain(HL_DEL);
    expect(page.afterHtml).toContain(HL_INS);
    expect(page.afterHtml).toContain('前年比は');
    expect(page.afterHtml).toContain('でした');
    expect(page.afterHtml).not.toContain(`<span class="${HL_INS}">前年比は`);
  });

  it('marks an added block (after only) with HL_ADDED in the after pane only', () => {
    const before = doc('<p id="a">a</p>');
    const after = doc('<p id="a">a</p>', '<p id="b">b</p>');
    const diff = buildHtmlDiff(before, after);
    const page = diff.pages[0];
    const added = page.blocks.find((b) => b.key.startsWith('b'));
    expect(added?.status).toBe('added');
    expect(page.afterHtml).toContain(HL_ADDED);
    expect(page.beforeHtml).not.toContain(HL_ADDED);
  });

  it('marks a removed block (before only) with HL_REMOVED in the before pane only', () => {
    const before = doc('<p id="a">a</p>', '<p id="gone">x</p>');
    const after = doc('<p id="a">a</p>');
    const diff = buildHtmlDiff(before, after);
    const page = diff.pages[0];
    const removed = page.blocks.find((b) => b.key.startsWith('gone'));
    expect(removed?.status).toBe('removed');
    expect(page.beforeHtml).toContain(HL_REMOVED);
    expect(page.afterHtml).not.toContain(HL_REMOVED);
  });

  it('splits into pages at page-break markers (legacy and modern spellings)', () => {
    const html = doc(
      '<p>p1</p>',
      '<p style="page-break-before: always">p2</p>',
      '<p style="break-before: page">p3</p>',
    );
    const diff = buildHtmlDiff(html, html);
    expect(diff.pages).toHaveLength(3);
  });

  it('honors a page-break-after marker', () => {
    const html = doc('<p style="page-break-after: always">p1</p>', '<p>p2</p>');
    const diff = buildHtmlDiff(html, html);
    expect(diff.pages).toHaveLength(2);
  });

  // 改ページは根(body)の直下の `div.pagebreak` で表す。区切りの要素自身はパーツに数えない
  // (canvas・承認タブ・メモのキーと同じ数え方。`lib/pageBreaks.ts`)。
  it('splits at body-level div.pagebreak and keeps the break out of every page', () => {
    const html = doc(
      '<section id="s1">p1</section>',
      PB,
      '<section id="s2">p2</section>',
      PB,
      '<section id="s3">p3</section>',
    );
    const diff = buildHtmlDiff(html, html);
    // ページ数 = 区切りの数 + 1。
    expect(diff.pages).toHaveLength(3);
    for (const page of diff.pages) {
      expect(page.blocks).toHaveLength(1);
      expect(page.blocks.some((b) => b.key.startsWith('.pagebreak'))).toBe(false);
      expect(page.afterHtml).not.toContain('pagebreak');
    }
  });

  it('splits on div.pagebreak even when no CSS is supplied', () => {
    const html = doc('<p>p1</p>', PB, '<p>p2</p>');
    expect(buildHtmlDiff(html, html, undefined, undefined).pages).toHaveLength(2);
  });

  // CSS は判定に使わない。クラスに改ページを当てた CSS だけでは分けない。
  it('does not split on CSS class breaks (CSS is not used for page detection)', () => {
    const html = doc('<div class="x">p1</div>', '<div class="x">p2</div>');
    const css = '.x{page-break-after:always}';
    expect(buildHtmlDiff(html, html, css, css).pages).toHaveLength(1);
  });

  it('ignores leading, trailing and consecutive breaks (no empty pages)', () => {
    const html = doc(PB, '<p>p1</p>', PB, PB, '<p>p2</p>', PB);
    const diff = buildHtmlDiff(html, html);
    expect(diff.pages).toHaveLength(2);
    expect(diff.pages.every((p) => p.blocks.length === 1)).toBe(true);
  });

  // 承認タブは `splitPages(body.children)` でページを数え、その番号を `diff.pages` と突き合わせる。
  // 直下の地の文(合成 span で包んでパーツにする)とコメントが、ページを作ったりずらしたり
  // してはいけない。
  it('agrees with splitPages(body.children) when text and comments sit between elements', () => {
    const html = doc(
      'lead text',
      '<p id="a">a</p>',
      '<!-- c1 -->',
      'tail of page 1',
      PB,
      'head of page 2',
      '<p id="b">b</p>',
      PB,
      '<!-- c2 -->',
      PB,
      '<p id="c" style="page-break-after: always">c</p>',
      'after inline break',
      '<p id="d">d</p>',
      PB,
      'trailing text only',
    );
    const body = new DOMParser().parseFromString(html, 'text/html').body;
    const expected = splitPages(Array.from(body.children)).pages;
    const diff = buildHtmlDiff(html, html);
    expect(diff.pages).toHaveLength(expected.length);
    expect(diff.beforePageCount).toBe(expected.length);
    expect(diff.afterPageCount).toBe(expected.length);
    // 各ページの要素のパーツは splitPages と同じ並び。地の文は隣のパーツのページへ入る。
    expect(
      diff.pages.map((p) =>
        p.blocks.filter((b) => !b.partKey.startsWith('#text')).map((b) => b.key),
      ),
    ).toEqual(expected.map((page) => page.map((el) => `${el.id}#1`)));
    const texts = diff.pages.map((p) => p.afterHtml);
    expect(texts[0]).toContain('lead text');
    expect(texts[0]).toContain('tail of page 1');
    expect(texts[1]).toContain('head of page 2');
    expect(texts[2]).not.toContain('after inline break');
    expect(texts[3]).toContain('after inline break');
    expect(texts[3]).toContain('trailing text only');
  });

  it('keys blocks by data-part-id over id/class/tag', () => {
    // same id but different part-id → treated as distinct (one removed, one added)
    const before = doc('<div data-part-id="P1" id="x">a</div>');
    const after = doc('<div data-part-id="P2" id="x">a</div>');
    const diff = buildHtmlDiff(before, after);
    const statuses = diff.pages[0].blocks.map((b) => b.status).sort();
    expect(statuses).toEqual(['added', 'removed']);
  });

  it('falls back to class then tag for the block key', () => {
    const before = doc('<section class="hero">a</section>', '<footer>f</footer>');
    const after = doc('<section class="hero">changed</section>', '<footer>f</footer>');
    const diff = buildHtmlDiff(before, after);
    const page = diff.pages[0];
    expect(page.blocks.find((b) => b.key.startsWith('.hero'))?.status).toBe('changed');
    expect(page.blocks.find((b) => b.key.startsWith('footer'))?.status).toBe('same');
  });

  it('disambiguates repeated anchors within a page (#1, #2)', () => {
    const before = doc('<p class="row">1</p>', '<p class="row">2</p>');
    const after = doc('<p class="row">1</p>', '<p class="row">changed</p>');
    const diff = buildHtmlDiff(before, after);
    const page = diff.pages[0];
    expect(page.blocks.map((b) => b.key)).toEqual(['.row#1', '.row#2']);
    expect(page.blocks[0].status).toBe('same');
    expect(page.blocks[1].status).toBe('changed');
  });

  it('marks a same-key top-level block whose tag changed as wholly changed (both panes)', () => {
    // 同じアンカー(id)でも tag が違えば、語句 diff に降りず要素ごと変更扱いにする。
    const before = doc('<p id="x">a</p>');
    const after = doc('<div id="x">a</div>');
    const page = buildHtmlDiff(before, after).pages[0];
    expect(page.blocks[0].status).toBe('changed');
    expect(page.beforeHtml).toContain(HL_CHANGED);
    expect(page.afterHtml).toContain(HL_CHANGED);
  });

  it('marks an attribute-only block change wholly (no inner text to diff)', () => {
    // 子は同一で親の属性だけ違う → 降りても着色対象が無く、要素ごと変更扱い。
    const before = doc('<div id="c" data-x="1"><p id="k">same</p></div>');
    const after = doc('<div id="c" data-x="2"><p id="k">same</p></div>');
    const page = buildHtmlDiff(before, after).pages[0];
    expect(page.blocks[0].status).toBe('changed');
    expect(page.afterHtml).toContain(HL_CHANGED);
  });

  it('descends into children: highlights an added and a removed child within a changed block', () => {
    const before = doc('<div id="c"><p id="keep">x</p><p id="gone">g</p></div>');
    const after = doc('<div id="c"><p id="keep">x</p><p id="new">n</p></div>');
    const page = buildHtmlDiff(before, after).pages[0];
    expect(page.blocks[0].status).toBe('changed');
    // 追加された子は after ペインに HL_ADDED、削除された子は before ペインに HL_REMOVED。
    expect(page.afterHtml).toContain(HL_ADDED);
    expect(page.beforeHtml).toContain(HL_REMOVED);
  });

  it('descends into children: a same-key child whose tag changed becomes removed+added', () => {
    const before = doc('<div id="c"><p id="k">x</p></div>');
    const after = doc('<div id="c"><span id="k">x</span></div>');
    const page = buildHtmlDiff(before, after).pages[0];
    expect(page.blocks[0].status).toBe('changed');
    // 同キーだが種別/tag違いの子 → before に HL_REMOVED, after に HL_ADDED。
    expect(page.beforeHtml).toContain(HL_REMOVED);
    expect(page.afterHtml).toContain(HL_ADDED);
  });

  it('descends two levels: a nested attribute-only change marks the inner element wholly', () => {
    const before = doc('<div id="c"><section id="s" data-x="1"><p id="k">same</p></section></div>');
    const after = doc('<div id="c"><section id="s" data-x="2"><p id="k">same</p></section></div>');
    const page = buildHtmlDiff(before, after).pages[0];
    expect(page.blocks[0].status).toBe('changed');
    expect(page.afterHtml).toContain(HL_CHANGED);
  });

  it('handles a page-count mismatch (extra before page → all removed)', () => {
    const before = doc('<p>p1</p>', '<p style="page-break-before: always">p2</p>');
    const after = doc('<p>p1</p>');
    const diff = buildHtmlDiff(before, after);
    expect(diff.pages).toHaveLength(2);
    expect(diff.pages[1].blocks.every((b) => b.status === 'removed')).toBe(true);
    expect(diff.pages[1].changed).toBe(true);
  });

  // 比較画面のページずらしで使う、ユーザー指定の対応付けで diff する版。
  it('reports before/after page counts', () => {
    const before = doc('<p>p1</p>', '<p style="page-break-before: always">p2</p>');
    const after = doc(
      '<p>p1</p>',
      '<p style="page-break-before: always">p2</p>',
      '<p style="page-break-before: always">p3</p>',
    );
    const diff = buildHtmlDiff(before, after);
    expect(diff.beforePageCount).toBe(2);
    expect(diff.afterPageCount).toBe(3);
  });
});

describe('buildHtmlDiffAligned', () => {
  // ページ A4 区切りつきの 3 ページ文書を作る(各 p が 1 ページ)。
  const br = 'style="page-break-before: always"';
  function pages3(p1: string, p2: string, p3: string): string {
    return doc(`<p>${p1}</p>`, `<p ${br}>${p2}</p>`, `<p ${br}>${p3}</p>`);
  }

  it('恒等 pairs は buildHtmlDiff と同一結果になる', () => {
    const before = pages3('a', 'b', 'c');
    const after = pages3('a', 'X', 'c');
    const identity: PagePair[] = [
      { before: 0, after: 0 },
      { before: 1, after: 1 },
      { before: 2, after: 2 },
    ];
    const aligned = buildHtmlDiffAligned(before, after, undefined, undefined, identity);
    const plain = buildHtmlDiff(before, after);
    expect(aligned).toEqual(plain);
  });

  it('比較先を +1 ずらすと、本来ずれていた同一ページ対が same になる', () => {
    // after に 1 ページ(X)が先頭挿入され、以降が 1 つ後ろへずれたケース。区切りで分けたページ
    // なら、各ページの markup は位置に依らず同一になり、ずらしの効果を純粋に見られる。
    const before = doc('<p>a</p>', PB, '<p>b</p>', PB, '<p>c</p>');
    const after = doc('<p>X</p>', PB, '<p>a</p>', PB, '<p>b</p>', PB, '<p>c</p>');
    // 比較元 i ↔ 比較先 i+1 に揃える。
    const pairs: PagePair[] = [
      { before: 0, after: 1 },
      { before: 1, after: 2 },
      { before: 2, after: 3 },
    ];
    const diff = buildHtmlDiffAligned(before, after, undefined, undefined, pairs);
    expect(diff.changedPageCount).toBe(0);
    expect(diff.pages.every((p) => !p.changed)).toBe(true);
  });

  it('片側 null の pair は全 added / 全 removed になる', () => {
    const before = pages3('a', 'b', 'c');
    const after = pages3('a', 'b', 'c');
    const pairs: PagePair[] = [
      { before: 0, after: null }, // 比較先なし → removed
      { before: null, after: 1 }, // 比較元なし → added
    ];
    const diff = buildHtmlDiffAligned(before, after, undefined, undefined, pairs);
    expect(diff.pages[0].blocks.every((b) => b.status === 'removed')).toBe(true);
    expect(diff.pages[1].blocks.every((b) => b.status === 'added')).toBe(true);
  });
});

// 承認画面のパーツ単位プレビューが使う、`DiffBlock` のパーツ別前後 HTML とラベル採番。
describe('DiffBlock part-level before/after + labels', () => {
  it('exposes per-part colored before/after HTML and ページN・パーツM labels', () => {
    const before = doc('<p id="a">old</p>', '<p id="b">keep</p>');
    const after = doc('<p id="a">new</p>', '<p id="b">keep</p>');
    const page = buildHtmlDiff(before, after).pages[0];

    const changed = page.blocks.find((b) => b.status === 'changed');
    expect(changed?.label).toBe('ページ1・パーツ1');
    expect(changed?.beforeHtml).toContain(`<span class="${HL_DEL}">old</span>`);
    expect(changed?.afterHtml).toContain(`<span class="${HL_INS}">new</span>`);

    // 2 つ目の top-level block は同ページのパーツ2(無変更)。
    const same = page.blocks.find((b) => b.status === 'same');
    expect(same?.label).toBe('ページ1・パーツ2');
  });

  it('numbers parts per page across page breaks', () => {
    const sec = (id: string, body: string) => `<section id="${id}">${body}</section>`;
    const before = doc(sec('p0', '<p>a</p>'), PB, sec('p1', '<p>b</p>'));
    const after = doc(sec('p0', '<p>a</p>'), PB, sec('p1', '<p>B</p>'));
    const diff = buildHtmlDiff(before, after);

    // 2 ページ目の唯一のパーツ。ページ採番は 1 起点で、区切りはパーツに数えない。
    expect(diff.pages[1].blocks).toHaveLength(1);
    expect(diff.pages[1].blocks[0].label).toBe('ページ2・パーツ1');
    expect(diff.pages[1].blocks[0].status).toBe('changed');
  });

  // メモ・修正履歴のキーと同じ、文書全体での `<アンカー>#<通し番号>`。ページ内の整列キー
  // `key` はページごとの番号のまま。
  it('gives each block a document-wide partKey (anchor#n across pages)', () => {
    const before = doc('<p class="s">a</p>', PB, '<p class="s">b</p>');
    const after = doc('<p class="s">a</p>', PB, '<p class="s">B</p>');
    const diff = buildHtmlDiff(before, after);
    expect(diff.pages[0].blocks[0].partKey).toBe('.s#1');
    const second = diff.pages[1].blocks[0];
    expect(second.key).toBe('.s#1');
    expect(second.partKey).toBe('.s#2');
    expect(second.label).toBe('ページ2・パーツ1');
  });

  it('partKey of a removed block comes from the before document', () => {
    const before = doc('<p class="s">a</p>', PB, '<p class="s">b</p>', '<p class="s">c</p>');
    const after = doc('<p class="s">a</p>', PB, '<p class="s">b</p>');
    const page = buildHtmlDiff(before, after).pages[1];
    const removed = page.blocks.find((b) => b.status === 'removed');
    expect(removed?.partKey).toBe('.s#3');
    // 無変更ページ(高速パス)でも partKey を持つ。
    expect(buildHtmlDiff(before, before).pages[1].blocks.map((b) => b.partKey)).toEqual([
      '.s#2',
      '.s#3',
    ]);
  });

  it('leaves the before pane empty for added parts and after pane empty for removed', () => {
    const before = doc('<p id="keep">x</p>');
    const after = doc('<p id="keep">x</p>', '<p id="fresh">y</p>');
    const page = buildHtmlDiff(before, after).pages[0];
    const added = page.blocks.find((b) => b.status === 'added');
    expect(added?.beforeHtml).toBe('');
    expect(added?.afterHtml).toContain('fresh');
  });

  it('removed パーツのラベルは after 側の続き番号になり、同一ページ内で重複しない', () => {
    // before [a,b,c] から b を削除 → after [a,c]。removed の b へ before 側 index(=2)を
    // そのまま使うと after 側 c(パーツ2)と同名になる退行の再発防止。
    const before = doc('<p id="a">a</p>', '<p id="b">b</p>', '<p id="c">c</p>');
    const after = doc('<p id="a">a</p>', '<p id="c">c</p>');
    const page = buildHtmlDiff(before, after).pages[0];

    const labels = page.blocks.map((b) => b.label);
    expect(new Set(labels).size).toBe(labels.length);
    // removed は after 側パーツ数(2)の続き番号で採番される。
    const removed = page.blocks.find((b) => b.status === 'removed');
    expect(removed?.label).toBe('ページ1・パーツ3');
    // after 側の現行パーツ(a, c)は従来どおり DOM 順で 1..N。
    const sameLabels = page.blocks.filter((b) => b.status === 'same').map((b) => b.label);
    expect(sameLabels).toEqual(['ページ1・パーツ1', 'ページ1・パーツ2']);
  });
});

describe('diffHighlightCss / buildDiffDoc（承認・比較で共有する iframe 組み立て）', () => {
  it('着色ルール(.cmp-*)は共通で、body padding だけ引数で変わる', () => {
    const a = diffHighlightCss(14);
    const b = diffHighlightCss(18);
    expect(a).toContain('padding:14px');
    expect(b).toContain('padding:18px');
    // padding 以外(着色ルール)は両者で完全一致する。
    expect(a.replace('padding:14px', 'padding:Npx')).toBe(b.replace('padding:18px', 'padding:Npx'));
    for (const cls of [HL_CHANGED, HL_ADDED, HL_REMOVED, HL_INS, HL_DEL]) {
      expect(a).toContain(`.${cls}{`);
    }
  });

  it('buildDiffDoc は版 CSS とハイライト CSS を両方 head に載せて本文を包む', () => {
    const html = buildDiffDoc('<p>x</p>', '.fund{}', diffHighlightCss(14));
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<style>.fund{}</style>');
    expect(html).toContain('padding:14px');
    expect(html).toContain('<body><p>x</p></body>');
  });
});
