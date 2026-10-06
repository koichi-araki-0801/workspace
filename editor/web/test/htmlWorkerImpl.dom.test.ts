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

const css = '.page { page-break-after: always; }';
const page = (n: number, body: string) => `<section class="page" id="p${n}">${body}</section>`;
const build = (pages: string[]) => `<!doctype html><html><body>${pages.join('')}</body></html>`;

// linkedom は table の暗黙 `<tbody>` を補わない(browser/jsdom は補う)。この差は比較画面の
// 表示専用 HTML にのみ現れ、保存/PDF には出ず描画も同一なので、パリティ比較では `tbody`
// タグを正規化(除去)して吸収する。
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
    // changedPageCount や status 分類は完全一致、表示 HTML は tbody 正規化後に一致。
    expect(viaLinkedom.changedPageCount).toBe(viaJsdom.changedPageCount);
    expect(stripTbody(viaLinkedom)).toEqual(stripTbody(viaJsdom));
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
