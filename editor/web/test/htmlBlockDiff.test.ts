import { describe, expect, it } from 'vitest';
import {
  buildHtmlDiff,
  HL_ADDED,
  HL_CHANGED,
  HL_DEL,
  HL_INS,
  HL_REMOVED,
} from '@/features/compare/htmlBlockDiff';

/** Wrap body fragments in a minimal HTML document (what renderJinja produces). */
function doc(...body: string[]): string {
  return `<!doctype html><html><body>${body.join('')}</body></html>`;
}

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
});
