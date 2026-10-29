// =============================================================================
// reviewParts.test.ts — パーツ判定を確定HTMLへ適用するための原文パーツ抽出
// =============================================================================
// 承認画面と同じ `<アンカー>#<文書全体の通し番号>` で本文直下のパーツを同定し、
// 元HTML上の範囲を保持する。確定保存はこの範囲だけを削除し、Jinja原文・改ページ・
// コメント・空白など判定対象外の文字列を変更しない。

import { describe, expect, it } from 'vitest';
import {
  buildCreateReviewedHtml,
  extractBodyUnits,
  extractReviewParts,
} from '../src/html/reviewParts';

describe('extractReviewParts', () => {
  it('data-part-id、id、先頭class、タグ名の優先順でキーを作る', () => {
    const html =
      '<body>' +
      '<section data-part-id="catalog" id="ignored" class="ignored">A</section>' +
      '<section id="explicit" class="ignored">B</section>' +
      '<section class="first second">C</section>' +
      '<article>D</article>' +
      '</body>';

    const parts = extractReviewParts(html);

    expect(parts.map((part) => part.partKey)).toEqual([
      'catalog#1',
      'explicit#1',
      '.first#1',
      'article#1',
    ]);
    expect(parts.map((part) => part.html)).toEqual([
      '<section data-part-id="catalog" id="ignored" class="ignored">A</section>',
      '<section id="explicit" class="ignored">B</section>',
      '<section class="first second">C</section>',
      '<article>D</article>',
    ]);
  });

  it('同じアンカーは改ページをまたいでも文書全体の出現順で採番する', () => {
    const html =
      '<body>' +
      '<section class="item">A</section>' +
      '<div class="pagebreak"></div>' +
      '<section class="item">B</section>' +
      '<div class="pagebreak"></div>' +
      '<section class="item">C</section>' +
      '</body>';

    const parts = extractReviewParts(html);

    expect(parts.map((part) => part.partKey)).toEqual(['.item#1', '.item#2', '.item#3']);
  });

  it('styleとdiv.pagebreakを除外し、パーツ内部の子要素を別パーツにしない', () => {
    const html =
      '<html><head><style>.x{color:red}</style></head><body>' +
      '<style>.y{color:blue}</style>' +
      '<section data-part-id="outer">' +
      '<div data-part-id="nested">子</div>' +
      '</section>' +
      '<div class="pagebreak"></div>' +
      '<p>末尾</p>' +
      '</body></html>';

    const parts = extractReviewParts(html);

    expect(parts.map((part) => part.partKey)).toEqual(['outer#1', 'p#1']);
    expect(parts[0]?.html).toContain('data-part-id="nested"');
  });

  it('抽出範囲は元HTMLの該当outerHTMLと一致する', () => {
    const html =
      '<body>\n' +
      '  <section data-part-id="a">{{ fund.name }}</section>\n' +
      '  <div class="pagebreak"></div>\n' +
      '  <section data-part-id="b">B</section>\n' +
      '</body>';

    const parts = extractReviewParts(html);

    for (const part of parts) {
      expect(html.slice(part.start, part.end)).toBe(part.html);
    }
  });

  it.each([
    '<section data-part-id="{{ fund.code }}">A</section>',
    '<section id="{{ fund.code }}">A</section>',
    '<section class="part-{{ fund.code }} other">A</section>',
  ])('キーに採用されるアンカーへJinjaを含む場合は拒否する: %s', (part) => {
    expect(() => extractReviewParts(`<body>${part}</body>`)).toThrow(
      'パーツ識別子にJinjaを使用できません',
    );
  });

  it('採用されない属性にJinjaがあっても、優先アンカーが固定なら抽出できる', () => {
    const html =
      '<body>' +
      '<section data-part-id="fixed" id="{{ fund.code }}" ' +
      'class="part-{{ fund.code }}">A</section>' +
      '</body>';

    expect(extractReviewParts(html).map((part) => part.partKey)).toEqual(['fixed#1']);
  });

  it('完全HTMLではbody直下だけを抽出し、head内の要素を含めない', () => {
    const html =
      '<!doctype html><html><head>' +
      '<section data-part-id="head-part">対象外</section>' +
      '</head><body class="report">' +
      '<section data-part-id="body-part">対象</section>' +
      '</body></html>';

    const parts = extractReviewParts(html);

    expect(parts.map((part) => part.partKey)).toEqual(['body-part#1']);
    expect(parts[0]?.html).toBe('<section data-part-id="body-part">対象</section>');
    expect(html.slice(parts[0]?.start, parts[0]?.end)).toBe(parts[0]?.html);
  });

  it('bodyのない本文断片は入力全体の直下を抽出する', () => {
    const html =
      '<section data-part-id="first">A</section>' +
      '<div class="pagebreak"></div>' +
      '<section data-part-id="second">B</section>';

    expect(extractReviewParts(html).map((part) => part.partKey)).toEqual(['first#1', 'second#1']);
  });

  it('コメント・属性値・raw-text内のbody表記を実bodyと誤認しない', () => {
    const html =
      '<html><head>' +
      '<!-- <body><section data-part-id="comment">対象外</section></body> -->' +
      '<meta content="<body>">' +
      '<style>body::before{content:"<body>"}</style>' +
      '</head><body>' +
      '<script>const x = "</body>";</script>' +
      '<section data-part-id="real">対象</section>' +
      '</body></html>';

    expect(extractReviewParts(html).map((part) => part.partKey)).toEqual(['script#1', 'real#1']);
  });

  it.each([
    '<html><head></head><body><section data-part-id="a">A</section></html>',
    '<html><head></head><section data-part-id="a">A</section></body></html>',
  ])('bodyの開始・終了が片方だけのHTMLは拒否する: %s', (html) => {
    expect(() => extractReviewParts(html)).toThrow('HTMLのbody境界を確認できません');
  });

  it('閉じタグを確定できないHTMLは部分結果を返さず拒否する', () => {
    const html =
      '<section data-part-id="complete">A</section>' + '<section data-part-id="broken">B';

    expect(() => extractReviewParts(html)).toThrow('HTMLのパーツ境界を確認できません');
  });
  describe('buildCreateReviewedHtml', () => {
    const sourceHtml =
      '<!doctype html><html><head>' +
      '<style>.report{color:{{ fund.color }}}</style>' +
      '</head><body>' +
      '<!-- 本文開始 -->' +
      '<section data-part-id="cover">{{ fund.name }}</section>' +
      '<div class="pagebreak"></div>' +
      '<section data-part-id="cost">費用 {{ fund.cost }}</section>' +
      '<section data-part-id="note">注記 {{ fund.note }}</section>' +
      '</body></html>';

    const filledHtml =
      '<!doctype html><html><head>' +
      '<style>.report{color:red}</style>' +
      '</head><body>' +
      '<!-- 本文開始 -->' +
      '<section data-part-id="cover">ダミー高利回り債券オープン</section>' +
      '<div class="pagebreak"></div>' +
      '<section data-part-id="cost">費用 1.25%</section>' +
      '<section data-part-id="note">注記 サンプル</section>' +
      '</body></html>';

    it('原文と値入りHTMLのキーが一致すれば、承認済みを残し却下済みを原文から除外する', () => {
      const result = buildCreateReviewedHtml(sourceHtml, filledHtml, [
        { partKey: 'cover#1', status: 'approved' },
        { partKey: 'cost#1', status: 'rejected' },
        { partKey: 'note#1', status: 'approved' },
      ]);

      expect(result).toContain('<section data-part-id="cover">{{ fund.name }}</section>');
      expect(result).not.toContain('data-part-id="cost"');
      expect(result).toContain('<section data-part-id="note">注記 {{ fund.note }}</section>');
    });

    it('Jinja原文、head、コメント、改ページを変更しない', () => {
      const result = buildCreateReviewedHtml(sourceHtml, filledHtml, [
        { partKey: 'cover#1', status: 'approved' },
        { partKey: 'cost#1', status: 'rejected' },
        { partKey: 'note#1', status: 'approved' },
      ]);

      expect(result).toContain('<style>.report{color:{{ fund.color }}}</style>');
      expect(result).toContain('<!-- 本文開始 -->');
      expect(result).toContain('<div class="pagebreak"></div>');
      expect(result).toContain('<!doctype html>');
    });

    it('原文と値入りHTMLのパーツ数が違えば拒否する', () => {
      const fewerFilled =
        '<body>' +
        '<section data-part-id="cover">表紙</section>' +
        '<section data-part-id="cost">費用</section>' +
        '</body>';

      expect(() =>
        buildCreateReviewedHtml(sourceHtml, fewerFilled, [
          { partKey: 'cover#1', status: 'approved' },
          { partKey: 'cost#1', status: 'approved' },
          { partKey: 'note#1', status: 'approved' },
        ]),
      ).toThrow('Jinja原文と値入りHTMLのパーツ構造が一致しません');
    });

    it('原文と値入りHTMLのパーツキーが違えば拒否する', () => {
      const differentFilled = filledHtml.replace('data-part-id="cost"', 'data-part-id="fee"');

      expect(() =>
        buildCreateReviewedHtml(sourceHtml, differentFilled, [
          { partKey: 'cover#1', status: 'approved' },
          { partKey: 'cost#1', status: 'approved' },
          { partKey: 'note#1', status: 'approved' },
        ]),
      ).toThrow('Jinja原文と値入りHTMLのパーツ構造が一致しません');
    });

    it('原文と値入りHTMLのパーツ順が違えば拒否する', () => {
      const reorderedFilled =
        '<body>' +
        '<section data-part-id="cost">費用</section>' +
        '<section data-part-id="cover">表紙</section>' +
        '<section data-part-id="note">注記</section>' +
        '</body>';

      expect(() =>
        buildCreateReviewedHtml(sourceHtml, reorderedFilled, [
          { partKey: 'cover#1', status: 'approved' },
          { partKey: 'cost#1', status: 'approved' },
          { partKey: 'note#1', status: 'approved' },
        ]),
      ).toThrow('Jinja原文と値入りHTMLのパーツ構造が一致しません');
    });

    it('本文に無いパーツの pending(取り消しで残った判定)は数えず、承認・却下は今どおり拒否する', () => {
      const known = [
        { partKey: 'cover#1', status: 'approved' },
        { partKey: 'cost#1', status: 'rejected' },
        { partKey: 'note#1', status: 'approved' },
      ] as const;
      expect(() =>
        buildCreateReviewedHtml(sourceHtml, filledHtml, [
          ...known,
          { partKey: 'gone#1', status: 'pending' },
        ]),
      ).not.toThrow();
      for (const status of ['approved', 'rejected'] as const) {
        expect(() =>
          buildCreateReviewedHtml(sourceHtml, filledHtml, [
            ...known,
            { partKey: 'gone#1', status },
          ]),
        ).toThrow('現在の本文に存在しないパーツ判定があります: gone#1');
      }
    });

    it('未判定パーツがあれば拒否する', () => {
      expect(() =>
        buildCreateReviewedHtml(sourceHtml, filledHtml, [
          { partKey: 'cover#1', status: 'approved' },
          { partKey: 'cost#1', status: 'pending' },
          { partKey: 'note#1', status: 'approved' },
        ]),
      ).toThrow('未判定のパーツがあるため最終確定できません');
    });

    it('判定が保存されていないパーツがあれば拒否する', () => {
      expect(() =>
        buildCreateReviewedHtml(sourceHtml, filledHtml, [
          { partKey: 'cover#1', status: 'approved' },
          { partKey: 'cost#1', status: 'approved' },
        ]),
      ).toThrow('判定が保存されていないパーツがあるため最終確定できません');
    });

    it('現在の本文に存在しない判定キーがあれば拒否する', () => {
      expect(() =>
        buildCreateReviewedHtml(sourceHtml, filledHtml, [
          { partKey: 'cover#1', status: 'approved' },
          { partKey: 'cost#1', status: 'approved' },
          { partKey: 'note#1', status: 'approved' },
          { partKey: 'unknown#1', status: 'approved' },
        ]),
      ).toThrow('現在の本文に存在しないパーツ判定があります');
    });

    it('同じパーツキーの判定が複数あれば拒否する', () => {
      expect(() =>
        buildCreateReviewedHtml(sourceHtml, filledHtml, [
          { partKey: 'cover#1', status: 'approved' },
          { partKey: 'cover#1', status: 'rejected' },
          { partKey: 'cost#1', status: 'approved' },
          { partKey: 'note#1', status: 'approved' },
        ]),
      ).toThrow('同じパーツの判定が複数あります');
    });
  });
});

describe('extractBodyUnits', () => {
  const names = (html: string) => extractBodyUnits(html).units.map((u) => u.name);
  const texts = (html: string) =>
    extractBodyUnits(html).units.map((u) => html.slice(u.start, u.end));

  it('本文直下の要素(style と区切りを含む)と空白でない地の文を文書順に返す', () => {
    const html =
      '<!doctype html><html><head><style>.a{}</style></head><body>\n' +
      '<style>.b{}</style>\n<p>a</p>地の文<!-- c -->続き\n' +
      '<div class="pagebreak"></div>\n<img src="x.png">\n</body></html>\n';
    expect(names(html)).toEqual(['style', 'p', '#text', '#text', 'div', 'img']);
    expect(texts(html)).toEqual([
      '<style>.b{}</style>',
      '<p>a</p>',
      '地の文',
      '続き\n',
      '<div class="pagebreak"></div>',
      '<img src="x.png">',
    ]);
    expect(html.slice(extractBodyUnits(html).bodyEnd)).toBe('</body></html>\n');
  });

  it('body の無い断片は入力全体を本文として読む', () => {
    const html = '<section>A</section>\n  <p>B<b>C</b></p>';
    expect(names(html)).toEqual(['section', 'p']);
    expect(extractBodyUnits(html).bodyEnd).toBe(html.length);
  });

  it('境界を確かめられない入力は拒否する', () => {
    expect(() => extractBodyUnits('<body><div><p>a</div></body>')).toThrow(
      'HTMLのパーツ境界を確認できません',
    );
  });

  it('コメントの範囲を数えても extractReviewParts のキーは変わらない', () => {
    expect(
      extractReviewParts('<body><!-- x --><p>a</p><?pi?><p>b</p></body>').map((p) => p.partKey),
    ).toEqual(['p#1', 'p#2']);
  });
});
