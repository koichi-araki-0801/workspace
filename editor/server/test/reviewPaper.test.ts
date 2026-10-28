// =============================================================================
// reviewPaper.test.ts — 承認タブの左右の紙面の本文(判定・空き枠・番号)
// =============================================================================
// 差分は実パーサ(server の `linkedomParser`)で `buildHtmlDiff` に通して作る。

import {
  buildHtmlDiff,
  buildReviewPaper,
  numberChangedParts,
  type PaperDecision,
  REVIEW_GHOST_TEXT,
} from '@editor/shared';
import { describe, expect, it } from 'vitest';
import { linkedomParser as parse } from '../src/util/linkedomParser.js';

const BREAK = '\n<div class="pagebreak"></div>\n';

// 1 頁目: <style>・地の文・same(id/style 付き)・changed(b)・added(n)・removed(c)。2 頁目: same。
const BEFORE =
  '<style>.a{}</style>地の文<div id="a" style="color:red"><p>共通</p></div>' +
  '<p id="b">交付運用報告書（現行版）</p><p id="c">削除C</p>' +
  `${BREAK}<p>二頁</p>`;
const AFTER =
  '<style>.a{}</style>地の文<div id="a" style="color:red"><p>共通</p></div>' +
  '<p id="b">交付運用報告書（交付版）</p><p id="n">新規N</p>' +
  `${BREAK}<p>二頁</p>`;

const diff = buildHtmlDiff(BEFORE, AFTER, parse);
const parts = numberChangedParts(diff);
const noOf = (partKey: string): number => parts.find((p) => p.partKey === partKey)?.no ?? -1;

type Diff = typeof diff;

function paper(opts: {
  side: 'before' | 'after';
  decisions?: Record<string, PaperDecision>;
  highlight?: boolean;
  d?: Diff;
}) {
  const d = opts.d ?? diff;
  return buildReviewPaper({
    diff: d,
    parts: opts.d === undefined ? parts : numberChangedParts(d),
    decisionOf: (k) => opts.decisions?.[k] ?? 'pending',
    side: opts.side,
    highlight: opts.highlight ?? false,
    parse,
  });
}

/** id を持つ要素の開始タグ(属性の並びは実装依存なので、並びを問わず確かめるために切り出す)。 */
const openTag = (html: string, id: string): string =>
  html.match(new RegExp(String.raw`<[a-z]+[^>]*\bid="${id}"[^>]*>`))?.[0] ?? '';

const textOf = (html: string): string => parse(html).body.textContent ?? '';

describe('buildReviewPaper', () => {
  it('右面: 未判定と承認は申請版、却下した変更は現行版に戻して札を付ける (D9)', () => {
    const pending = paper({ side: 'after' }).html;
    expect(pending).toContain('交付運用報告書（交付版）');
    expect(pending).not.toContain('data-review-keep');

    const approved = paper({ side: 'after', decisions: { 'b#1': 'approved' } }).html;
    expect(approved).toContain('交付運用報告書（交付版）');

    const rejected = paper({ side: 'after', decisions: { 'b#1': 'rejected' } }).html;
    expect(openTag(rejected, 'b')).toContain(`data-review-no="${noOf('b#1')}"`);
    expect(openTag(rejected, 'b')).toContain('data-review-keep=""');
    expect(textOf(rejected)).toContain('交付運用報告書（現行版）');
    expect(textOf(rejected)).not.toContain('交付運用報告書（交付版）');
  });

  it('右面: 却下した削除は現行版の中身が戻り data-review-keep が付く', () => {
    const html = paper({ side: 'after', decisions: { 'c#1': 'rejected' } }).html;
    expect(openTag(html, 'c')).toContain('data-review-keep=""');
    expect(openTag(html, 'c')).toContain(`data-review-no="${noOf('c#1')}"`);
    expect(html).toContain('削除C</p>');
    expect(html).not.toContain('data-review-ghost="removed"');
  });

  it('右面: 却下していない削除は「（なし・削除）」、却下した追加は「（却下のため追加しない）」の枠', () => {
    const html = paper({ side: 'after' }).html;
    expect(html).toContain(
      `<div data-review-ghost="removed" data-review-no="${noOf('c#1')}">${REVIEW_GHOST_TEXT.removed}</div>`,
    );
    expect(html).not.toContain('削除C');
    const rejected = paper({ side: 'after', decisions: { 'n#1': 'rejected' } }).html;
    expect(rejected).toContain(
      `<div data-review-ghost="rejected-added" data-review-no="${noOf('n#1')}">${REVIEW_GHOST_TEXT.rejectedAdded}</div>`,
    );
    expect(rejected).not.toContain('新規N');
  });

  it('左面: 追加パーツの位置に「（なし・新規追加）」の枠を置く', () => {
    const html = paper({ side: 'before' }).html;
    expect(html).toContain(
      `<div data-review-ghost="added" data-review-no="${noOf('n#1')}">${REVIEW_GHOST_TEXT.added}</div>`,
    );
    expect(html).toContain('削除C</p>');
    expect(html).not.toContain('新規N');
    // 追加の枠は、比較元の並びで b の後ろ
    expect(html.indexOf('現行版）')).toBeLessThan(html.indexOf('data-review-ghost="added"'));
    // 左面は判定の影響を受けない
    expect(paper({ side: 'before', decisions: { 'b#1': 'rejected' } }).html).toBe(html);
  });

  it('番号の付いた要素は data-review-no を持ち、移動したパーツは両面とも同じ番号', () => {
    const left = paper({ side: 'before' }).html;
    const right = paper({ side: 'after' }).html;
    expect(openTag(left, 'b')).toContain(`data-review-no="${noOf('b#1')}"`);
    expect(openTag(right, 'b')).toContain(`data-review-no="${noOf('b#1')}"`);
    expect(openTag(right, 'a')).not.toContain('data-review-no');
  });

  it('ページを移ったパーツは削除と追加が 1 件にまとまり、両面で同じ番号が出る', () => {
    // 1 頁目の末尾の段落を、そのまま 2 頁目の先頭へ移す(位置が揃うので同じ partKey の対になる)。
    const moved = buildHtmlDiff(`<p>先頭</p><p>移動</p>`, `<p>先頭</p>${BREAK}<p>移動</p>`, parse);
    const movedParts = numberChangedParts(moved);
    expect(movedParts).toHaveLength(1);
    expect(movedParts[0].kind).toBe('changed');
    const no = `data-review-no="${movedParts[0].no}"`;
    for (const side of ['before', 'after'] as const) {
      const html = paper({ side, d: moved }).html;
      expect(html.split(no)).toHaveLength(3); // 元の位置と移動先の 2 か所
    }
  });

  it('位置がずれて対にならない移動は、別々の番号になる', () => {
    const moved = buildHtmlDiff(
      `<p>先頭</p><p>移動する段落</p>${BREAK}<p>末尾</p>`,
      `<p>先頭</p>${BREAK}<p>末尾</p><p>移動する段落</p>`,
      parse,
    );
    const movedParts = numberChangedParts(moved);
    expect(movedParts.map((p) => p.kind)).toEqual(['removed', 'added']);
    expect(new Set(movedParts.map((p) => p.no)).size).toBe(2);
  });

  it('番号を付けても changed / added の要素の id・style などの既存属性は保たれる', () => {
    const d = buildHtmlDiff(
      '<p id="x" style="color:red" class="k">旧</p>',
      '<p id="x" style="color:red" class="k">新</p><div id="y" style="margin:0" title="t">追加</div>',
      parse,
    );
    const html = paper({ side: 'after', d }).html;
    for (const tag of [openTag(html, 'x'), openTag(html, 'y')]) {
      expect(tag).toContain('data-review-no=');
    }
    expect(openTag(html, 'x')).toContain('style="color:red"');
    expect(openTag(html, 'x')).toContain('class="k"');
    expect(openTag(html, 'y')).toContain('style="margin:0"');
    expect(openTag(html, 'y')).toContain('title="t"');
  });

  it('既存の id・style 属性を変えず、空き枠も style 属性を持たない', () => {
    for (const side of ['before', 'after'] as const) {
      const html = paper({ side, decisions: { 'n#1': 'rejected' } }).html;
      expect(html).toContain('<div id="a" style="color:red">');
      const ghosts = html.match(/<div data-review-ghost[^>]*>/g) ?? [];
      expect(ghosts.length).toBeGreaterThan(0);
      for (const g of ghosts) expect(g).not.toContain('style');
    }
  });

  it('ページの区切りを保ち、pageCount は区切りの数 + 1', () => {
    for (const side of ['before', 'after'] as const) {
      const p = paper({ side });
      expect(p.html.split(BREAK)).toHaveLength(2);
      expect(p.pageCount).toBe(2);
    }
  });

  it('全部 same の文書は、左右とも rawBeforeHtml を差分の並びで連結したものと一致する', () => {
    const same = buildHtmlDiff(BEFORE, BEFORE, parse);
    const expected = same.pages
      .map((pg) => pg.blocks.map((b) => b.rawBeforeHtml).join('\n'))
      .join(BREAK);
    expect(expected).toContain('<style>.a{}</style>');
    for (const side of ['before', 'after'] as const) {
      expect(paper({ side, d: same }).html).toBe(expected);
      expect(paper({ side, d: same, highlight: true }).html).toBe(expected);
    }
  });

  it('本文直下の地の文(要素でないテキスト)や <style> も落とさずに両面へ出す', () => {
    for (const side of ['before', 'after'] as const) {
      const html = paper({ side }).html;
      expect(html).toContain('<style>.a{}</style>');
      expect(textOf(html)).toContain('地の文');
    }
    const d = buildHtmlDiff('前の文<p>x</p>', '後の文<p>x</p>', parse);
    expect(textOf(paper({ side: 'after', d }).html)).toContain('後の文');
    expect(textOf(paper({ side: 'before', d }).html)).toContain('前の文');
  });

  it('要素で包めない断片(純粋な地の文・style)には番号の属性を付けず、そのまま返す', () => {
    const base = buildHtmlDiff('<p>x</p>', '<p>x</p>', parse);
    const b = base.pages[0].blocks[0];
    const fake: Diff = {
      ...base,
      pages: [
        {
          ...base.pages[0],
          blocks: [
            {
              ...b,
              key: 't#1',
              partKey: 't#1',
              status: 'changed',
              rawBeforeHtml: '旧',
              rawAfterHtml: '新',
              beforeHtml: '旧',
              afterHtml: '新',
            },
            {
              ...b,
              key: 's#1',
              partKey: 's#1',
              status: 'changed',
              rawBeforeHtml: '<style>.a{}</style>',
              rawAfterHtml: '<style>.b{}</style>',
              beforeHtml: '<style>.a{}</style>',
              afterHtml: '<style>.b{}</style>',
            },
          ],
          beforeKeys: ['t#1', 's#1'],
          afterKeys: ['t#1', 's#1'],
        },
      ],
    };
    expect(paper({ side: 'after', d: fake }).html).toBe('新\n<style>.b{}</style>');
    expect(paper({ side: 'before', d: fake }).html).toBe('旧\n<style>.a{}</style>');
  });

  it('highlight=false では cmp-ins / cmp-del を含まず、true では着色済みを使う', () => {
    const plain = paper({ side: 'after', highlight: false }).html;
    expect(plain).not.toMatch(/cmp-/);
    expect(paper({ side: 'after', highlight: true }).html).toContain('cmp-ins');
    expect(paper({ side: 'before', highlight: false }).html).not.toMatch(/cmp-/);
    expect(paper({ side: 'before', highlight: true }).html).toContain('cmp-del');
  });

  it('判定が無い・pending の変更は申請版のまま(最終確定の候補とは違う)', () => {
    const none = paper({ side: 'after' }).html;
    const pending = paper({
      side: 'after',
      decisions: { 'b#1': 'pending', 'n#1': 'pending' },
    }).html;
    expect(pending).toBe(none);
    expect(textOf(none)).toContain('新規N');
    expect(textOf(none)).toContain('交付運用報告書（交付版）');
  });

  it('片面にしか無いページは、空なら出さず、あれば区切りでつなぐ', () => {
    const d = buildHtmlDiff(`<p>一</p>${BREAK}<p>二</p>`, '<p>一</p>', parse);
    expect(paper({ side: 'before', d }).pageCount).toBe(2);
    const right = paper({ side: 'after', d });
    expect(right.html).toContain('data-review-ghost="removed"');
    expect(right.pageCount).toBe(2);
    const back = paper({ side: 'after', d, decisions: { 'p#2': 'rejected' } });
    expect(textOf(back.html)).toContain('二');
  });
});
