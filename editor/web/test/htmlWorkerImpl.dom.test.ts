// =============================================================================
// htmlWorkerImpl.test.ts — Worker(linkedom)経路と メイン(jsdom DOMParser)経路の
// 出力パリティ検証
// =============================================================================
// 「DOM 実装を注入して 1 実装を共有する」設計の妥当性を、同一入力に対する
// jsdom 既定経路と linkedom 経路の出力一致で担保する。
import { describe, expect, it } from 'vitest';
import { buildHtmlDiff, type HtmlDiff } from '@/features/compare/htmlBlockDiff';
import { rtComment } from '@/lib/jinjaAttrs';
import { toTemplate } from '@/lib/jinjaMask';
import { htmlWorkerImpl } from '@/workers/htmlWorkerImpl';

// 改ページは根の直下の `div.pagebreak` で表す。CSS は判定に使わないが、Worker の契約どおり渡す。
const css = '.pagebreak { break-after: page; }';
const page = (n: number, body: string) => `<section id="p${n}">${body}</section>`;
const build = (pages: string[]) =>
  `<!doctype html><html><body>${pages.join('<div class="pagebreak"></div>')}</body></html>`;

// linkedom はtableの暗黙`<tbody>`を補わない(browser/jsdomは補う)。表示用HTMLと
// 装飾前の生HTMLの両方に同じ直列化差が現れるため、このパリティ比較では`tbody`タグを
// 正規化して、DOM実装によらない差分分類・キー・本文の一致を検証する。

function stripTbody(diff: HtmlDiff): HtmlDiff {
  const s = (h: string) => h.replace(/<\/?tbody>/gi, '');
  return {
    ...diff,
    pages: diff.pages.map((p) => ({
      ...p,
      beforeHtml: s(p.beforeHtml),
      afterHtml: s(p.afterHtml),
      // パーツ単位の前後 HTML(承認画面用)も同じ tbody 差を含むため正規化する。
      blocks: p.blocks.map((b) => ({
        ...b,
        beforeHtml: s(b.beforeHtml),
        afterHtml: s(b.afterHtml),
        rawBeforeHtml: s(b.rawBeforeHtml),
        rawAfterHtml: s(b.rawAfterHtml),
      })),
    })),
  };
}

describe('htmlWorkerImpl linkedom parity', () => {
  it('buildHtmlDiff: jsdom と linkedom で HtmlDiff が一致(tbody 正規化後)', () => {
    const before = build([
      page(0, '<p>序文の段落です</p>'),
      page(1, '<table><tr><td>売上</td><td>100</td></tr></table>'),
      page(2, '<p>結びの言葉</p>'),
    ]);
    const after = build([
      page(0, '<p>序文の段落です</p>'),
      page(1, '<table><tr><td>売上</td><td>200</td></tr></table>'),
      page(2, '<p>結びの言葉(改訂)</p>'),
    ]);
    const viaJsdom = buildHtmlDiff(before, after, css, css);
    const viaLinkedom = htmlWorkerImpl.buildHtmlDiff(before, after, css, css);
    // linkedom(`Node` グローバルが無い)でも区切りで 3 ページに分かれ、区切りはパーツに
    // 数えない。パーツの文書全体のキーも持つ。
    expect(viaLinkedom.pages).toHaveLength(3);
    expect(viaLinkedom.pages.map((p) => p.blocks.map((b) => b.partKey))).toEqual([
      ['p0#1'],
      ['p1#1'],
      ['p2#1'],
    ]);
    // changedPageCount や status 分類は完全一致、表示 HTML は tbody 正規化後に一致。
    expect(viaLinkedom.changedPageCount).toBe(viaJsdom.changedPageCount);
    expect(stripTbody(viaLinkedom)).toEqual(stripTbody(viaJsdom));
  });
  it('buildHtmlDiff: 既存の直下パーツを維持し、申請版だけのパーツを added にする', () => {
    const before =
      '<!doctype html><html><head></head><body>' +
      '<section class="cover_header"><p>表紙</p></section>' +
      '<section class="cover_report"><p>報告書</p></section>' +
      '<section class="cover_body"><p>本文</p></section>' +
      '<div class="pagebreak"></div>' +
      '<section class="report_item_1"><p>運用経過</p></section>' +
      '<section class="report_item_2"><p>分配金</p></section>' +
      '</body></html>';

    const after =
      '<!doctype html><html><head></head><body>' +
      '<section class="cover_header"><p>表紙</p></section>' +
      '<section class="cover_report"><p>報告書</p></section>' +
      '<section class="cover_body"><p>本文</p></section>' +
      '<div data-part-id="part-cost-table"><p>費用明細</p></div>' +
      '<table class="data"><tbody><tr><td>100</td></tr></tbody></table>' +
      '<table data-part-id="part-scheme-product"><tbody><tr><td>商品分類</td></tr></tbody></table>' +
      '<div class="pagebreak"></div>' +
      '<section class="report_item_1"><p>運用経過</p></section>' +
      '<section class="report_item_2"><p>分配金</p></section>' +
      '</body></html>';

    const viaJsdom = buildHtmlDiff(before, after, css, css);
    const viaLinkedom = htmlWorkerImpl.buildHtmlDiff(before, after, css, css);

    const counts = (diff: HtmlDiff) => {
      const blocks = diff.pages.flatMap((page) => page.blocks);

      return {
        changed: blocks.filter((block) => block.status === 'changed').length,
        added: blocks.filter((block) => block.status === 'added').length,
        removed: blocks.filter((block) => block.status === 'removed').length,
        same: blocks.filter((block) => block.status === 'same').length,
        addedKeys: blocks.filter((block) => block.status === 'added').map((block) => block.partKey),
      };
    };

    expect(counts(viaJsdom)).toEqual({
      changed: 0,
      added: 3,
      removed: 0,
      same: 5,
      addedKeys: ['part-cost-table#1', '.data#1', 'part-scheme-product#1'],
    });

    expect(counts(viaLinkedom)).toEqual(counts(viaJsdom));
  });

  it('toTemplate: jsdom と linkedom で復元結果が一致', () => {
    // 範囲の印(o / x / c)・テンプレートの行・2 回目以降の繰り返し・チップを含む編集用 HTML。
    const chip = (src: string, label: string) =>
      `<span data-gjs-type="jinja-var" data-jinja="${btoa(src)}">${label}</span>`;
    const editable =
      '<table><tbody>' +
      rtComment({ kind: 'o', id: 1, payload: '{% for r in rows %}' }) +
      `<tr data-jinja-loop-row=""><td>${chip('{{ r.name }}', '名前')}</td></tr>` +
      rtComment({ kind: 'x', id: 1 }) +
      `<tr><td>${chip('{{ r.name }}', '名前2')}</td></tr>` +
      rtComment({ kind: 'c', id: 1, payload: '{% endfor %}' }) +
      '</tbody></table>';
    const viaJsdom = toTemplate(editable, { asFragment: true });
    const viaLinkedom = htmlWorkerImpl.toTemplate(editable, { asFragment: true });
    expect(viaJsdom).toBe(
      '<table><tbody>{% for r in rows %}<tr><td>{{ r.name }}</td></tr>{% endfor %}</tbody></table>',
    );
    expect(viaLinkedom).toEqual(viaJsdom);
  });

  it('toTemplate: `<body>` ラッパ断片(draft の実形状)でも本文を失わない', () => {
    // GrapesJS の `getHtml()` は `<html>` ラッパ無しの `<body …>…</body>` を返し、autosave が
    // その形のまま draft に保存する。linkedom はこの入力を素通しすると中身を `doc.body` の
    // 外へ置くため、`asFragment`(= `doc.body.innerHTML`)が空文字になる。
    const editable =
      '<body id="wrapper" class="page-root">' +
      '<div class="page"><h2>基準価額</h2><p><span data-gjs-type="jinja-var" data-jinja="' +
      btoa('{{ fund.nav }}') +
      '">12,345</span> 円</p></div>' +
      '</body>';
    const viaJsdom = toTemplate(editable, { asFragment: true });
    const viaLinkedom = htmlWorkerImpl.toTemplate(editable, { asFragment: true });
    expect(viaLinkedom).toContain('{{ fund.nav }}');
    expect(viaLinkedom).toEqual(viaJsdom);
  });

  it('buildHtmlDiff: `<body>` ラッパ断片どうしでも本文を失わない', () => {
    const wrap = (inner: string) => `<body class="page-root">${inner}</body>`;
    const before = wrap(page(0, '<p>変更前の本文</p>'));
    const after = wrap(page(0, '<p>変更後の本文</p>'));
    const viaJsdom = buildHtmlDiff(before, after, css, css);
    const viaLinkedom = htmlWorkerImpl.buildHtmlDiff(before, after, css, css);
    expect(viaLinkedom.changedPageCount).toBe(1);
    expect(stripTbody(viaLinkedom)).toEqual(stripTbody(viaJsdom));
  });
});
