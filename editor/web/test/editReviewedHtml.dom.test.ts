// =============================================================================
// editReviewedHtml.dom.test.ts — edit 申請の最終確定の切り貼り(戻す位置と止める入力)
// =============================================================================
// shared の `buildEditReviewedHtml` を画面と同じ `DOMParser` で回す。却下した削除を戻す位置
// (直前のパーツの後ろ・直後のパーツの前・白紙のページの区切りの前・申請版に無いページ)と、
// 原文の範囲を確かめられない入力で書かずに止めることを固定する。
import {
  buildEditReviewedHtml,
  buildHtmlDiff,
  buildReviewedHtmlCandidate,
  type CreateReviewPartDecision,
} from '@editor/shared';
import { describe, expect, it } from 'vitest';
import { defaultHtmlParser, type HtmlParser } from '@/lib/htmlParser';
import { linkedomParser } from '@/workers/htmlWorkerImpl';

const BREAK = '<div class="pagebreak"></div>';

/** 現行版 `base` から `html` への申請に `decisions` を当てて確定する本文。 */
const confirm = (base: string, html: string, decisions: CreateReviewPartDecision[]) =>
  buildEditReviewedHtml(
    { baseHtml: base, baseCss: '', html, partDecisions: decisions },
    defaultHtmlParser,
    base,
  );
const rejected = (...keys: string[]) =>
  keys.map((partKey) => ({ partKey, status: 'rejected' as const }));

describe('buildEditReviewedHtml の却下した削除を戻す位置', () => {
  it('直前に残るパーツが無ければ、直後のパーツの前へ戻す', () => {
    const base = '<body><p id="a">A</p>\n<p id="b">B</p></body>';
    const html = '<body><p id="b">B</p></body>';
    expect(confirm(base, html, rejected('a#1'))).toBe(
      '<body><p id="a">A</p>\n<p id="b">B</p></body>',
    );
  });

  it('戻す位置が却下した変更と重なれば、戻したパーツを変更の前に置く', () => {
    const base = '<body><p id="r">R</p>\n<p id="c">旧</p></body>';
    const html = '<body><p id="c">新</p></body>';
    expect(confirm(base, html, rejected('r#1', 'c#1'))).toBe(
      '<body><p id="r">R</p>\n<p id="c">旧</p></body>',
    );
  });

  it('パーツの無い白紙のページへは、そのページの区切りの前へ戻す', () => {
    const base = `<body><p>1</p>${BREAK}<p id="x">X</p>${BREAK}<p>3</p></body>`;
    const html = `<body><p>1</p>${BREAK}${BREAK}<p>3</p></body>`;
    expect(confirm(base, html, rejected('x#1'))).toBe(
      `<body><p>1</p>${BREAK}<p id="x">X</p>\n${BREAK}<p>3</p></body>`,
    );
  });

  it('申請版に無いページは、区切りを足して本文の末尾へ戻す', () => {
    const base = `<body><p>1</p>${BREAK}<p id="z">Z</p></body>`;
    const html = '<body><p>1</p></body>';
    expect(confirm(base, html, rejected('z#1'))).toBe(
      `<body><p>1</p>\n${BREAK}\n<p id="z">Z</p>\n</body>`,
    );
  });

  it('判定の無い比較元つきの申請は、変更が無ければ申請の本文をそのまま返す', () => {
    const html = '<body><p>同じ</p></body>';
    expect(
      buildEditReviewedHtml({ baseHtml: html, baseCss: '', html }, defaultHtmlParser, html),
    ).toBe(html);
  });
});

describe('buildEditReviewedHtml が書かずに止める入力', () => {
  it('原文の境界を読めない(閉じの対応が取れない)申請は 409', () => {
    const base = '<body><p class="x">旧</p></div></body>';
    const html = '<body><p class="x">新</p></div></body>';
    expect(() => confirm(base, html, rejected('.x#1'))).toThrow(
      expect.objectContaining({ kind: 'conflict', code: 'REVIEW_SPLICE_MISMATCH' }),
    );
  });

  it('表の地の文が表の外へ出る(DOMParser の foster parenting)申請は 409', () => {
    const base = '<body><p class="x">旧</p><table>注記<tr><td>1</td></tr></table></body>';
    const html = '<body><p class="x">新</p><table>注記<tr><td>1</td></tr></table></body>';
    expect(() => confirm(base, html, rejected('.x#1'))).toThrow(
      expect.objectContaining({ code: 'REVIEW_SPLICE_MISMATCH' }),
    );
  });
});

/** 画面のメインスレッド(`DOMParser`)とサーバ・Worker(linkedom)の両方で確定する本文。 */
const parsers: Array<[string, HtmlParser]> = [
  ['DOMParser', defaultHtmlParser],
  ['linkedom', linkedomParser],
];
const confirmWith = (
  parse: HtmlParser,
  base: string,
  html: string,
  decisions: CreateReviewPartDecision[],
) =>
  buildEditReviewedHtml(
    { baseHtml: base, baseCss: '', html, partDecisions: decisions },
    parse,
    base,
  );

describe.each(parsers)('削除と、それに代わる追加の両方を却下する(%s)', (_name, parse) => {
  it('区切りの後ろのページ: 追加を消し、削除したパーツを同じ位置へ戻す', () => {
    const base = `<body><p>1</p>${BREAK}<p id="z">Z</p></body>`;
    const html = `<body><p>1</p>${BREAK}<p id="n">N</p></body>`;
    expect(confirmWith(parse, base, html, rejected('z#1', 'n#1'))).toBe(
      `<body><p>1</p>${BREAK}<p id="z">Z</p>\n</body>`,
    );
  });

  it('1 ページだけの文書', () => {
    const base = '<body><p id="z">Z</p></body>';
    const html = '<body><p id="n">N</p></body>';
    expect(confirmWith(parse, base, html, rejected('z#1', 'n#1'))).toBe(
      '<body><p id="z">Z</p>\n</body>',
    );
  });

  it('次のパーツの inline の break-before で切れたページ', () => {
    const next = '<p id="c" style="break-before:page">C</p>';
    const base = `<body><p id="z">Z</p>${next}</body>`;
    const html = `<body><p id="n">N</p>${next}</body>`;
    expect(confirmWith(parse, base, html, rejected('z#1', 'n#1'))).toBe(
      `<body><p id="z">Z</p>\n${next}</body>`,
    );
  });
});

describe('本文直下の <style> と地の文の却下(DOMParser と linkedom で同じ結果)', () => {
  const cases: Array<[string, string, string, CreateReviewPartDecision[], string]> = [
    [
      '本文直下の <style> の変更',
      '<body><style>.a{color:red}</style>\n<p class="a">本文</p></body>',
      '<body><style>.a{color:blue}</style>\n<p class="a">本文</p></body>',
      rejected('#attached#1'),
      '<body><style>.a{color:red}</style>\n<p class="a">本文</p></body>',
    ],
    [
      '地の文の変更',
      '<body><p>1</p>\n  地の文 旧\n<p>2</p></body>',
      '<body><p>1</p>\n  地の文 新\n<p>2</p></body>',
      rejected('#text#1'),
      '<body><p>1</p>\n  地の文 旧\n<p>2</p></body>',
    ],
    [
      '直前に残るパーツが <style> の削除',
      '<body><style>.a{}</style>\n<p id="z">Z</p>\n<p id="b">B</p></body>',
      '<body><style>.a{}</style>\n<p id="b">B</p></body>',
      rejected('z#1'),
      '<body><style>.a{}</style>\n<p id="z">Z</p>\n<p id="b">B</p></body>',
    ],
  ];

  it.each(cases)('%s', (_name, base, html, decisions, expected) => {
    const viaLinkedom = confirmWith(linkedomParser, base, html, decisions);
    expect(viaLinkedom).toBe(expected);
    expect(confirmWith(defaultHtmlParser, base, html, decisions)).toBe(viaLinkedom);
  });
});

describe.each(parsers)(
  '前の要素の inline の break-after の後ろへ戻すページ(%s)',
  (_name, parse) => {
    const base = '<body><p style="break-after:page">1</p><p id="z">Z</p></body>';
    const html = '<body><p style="break-after:page">1</p></body>';

    it('確定の本文は区切りを足さずに戻す(白紙のページを作らない)', () => {
      expect(confirmWith(parse, base, html, rejected('z#1'))).toBe(
        '<body><p style="break-after:page">1</p>\n<p id="z">Z</p>\n</body>',
      );
    });

    it('画面の最終候補も同じく区切りを足さない', () => {
      const diff = buildHtmlDiff(base, html, parse);
      expect(buildReviewedHtmlCandidate(diff, rejected('z#1')).html).toBe(
        '<p style="break-after:page">1</p>\n<p id="z">Z</p>',
      );
    });
  },
);
