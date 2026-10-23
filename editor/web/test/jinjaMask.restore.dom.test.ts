import { parseHTML } from 'linkedom';
import { describe, expect, it } from 'vitest';
import { toFilled } from '../src/lib/fillJinja';
import type { HtmlParser } from '../src/lib/htmlParser';
import { defaultHtmlParser } from '../src/lib/htmlParser';
import { b64encodeUtf8 as b64encode, rtComment } from '../src/lib/jinjaAttrs';
import { normalizeForRoundTrip, toTemplate } from '../src/lib/jinjaMask';
import { htmlWorkerImpl } from '../src/workers/htmlWorkerImpl';

const o = (id: number, payload: string) => rtComment({ kind: 'o', id, payload });
const c = (id: number, payload: string) => rtComment({ kind: 'c', id, payload });
const x = (id: number) => rtComment({ kind: 'x', id });
const t = (payload: string) => rtComment({ kind: 't', payload });
const chip = (src: string, label: string) =>
  `<span data-gjs-type="jinja-var" class="jinja-chip jinja-var" data-jinja="${b64encode(src)}">${label}</span>`;
const back = (html: string) => toTemplate(html, { asFragment: true });
const linkedomParser: HtmlParser = (html) => parseHTML(html).document as unknown as Document;

describe('toTemplate — 範囲の印', () => {
  it('if: 前半 + 採用した枝(編集後) + 後半 をつなぐ', () => {
    const html = `<div>${o(1, '{% if a %}<p>A</p>{% elif b %}')}<p class="new">B改</p>${c(1, '{% else %}<p>C</p>{% endif %}')}</div>`;
    expect(back(html)).toBe(
      '<div>{% if a %}<p>A</p>{% elif b %}<p class="new">B改</p>{% else %}<p>C</p>{% endif %}</div>',
    );
  });

  it('for: x の印から閉じまでの繰り返しを捨てる。複数要素でも範囲が縮まない', () => {
    const html =
      `<table><tbody>${o(2, '{% for r in rows %}')}<tr data-jinja-loop-row=""><td>${chip('{{ r }}', '1')}</td></tr>` +
      `<tr data-jinja-loop-row=""><td>sub</td></tr>${x(2)}<tr><td>2</td></tr><tr><td>sub</td></tr>${c(2, '{% endfor %}')}</tbody></table>`;
    expect(back(html)).toBe(
      '<table><tbody>{% for r in rows %}<tr><td>{{ r }}</td></tr><tr><td>sub</td></tr>{% endfor %}</tbody></table>',
    );
  });

  it('入れ子(採用した枝の中の for)', () => {
    const html = `<div>${o(1, '{% if a %}')}<ul>${o(2, '{% for i in xs %}')}<li>${chip('{{ i }}', '1')}</li>${x(2)}<li>2</li>${c(2, '{% endfor %}')}</ul>${c(1, '{% endif %}')}</div>`;
    expect(back(html)).toBe(
      '<div>{% if a %}<ul>{% for i in xs %}<li>{{ i }}</li>{% endfor %}</ul>{% endif %}</div>',
    );
  });

  it('空白制御を保つ', () => {
    const html = `<div>${o(1, '{% if a -%}')}<p>A</p>${c(1, '{%- endif %}')}</div>`;
    expect(back(html)).toBe('<div>{% if a -%}<p>A</p>{%- endif %}</div>');
  });

  it('採用した枝が無い if(前半が全体・後半が空)', () => {
    expect(back(`<p>${o(1, '{% if a %}x{% endif %}')}${c(1, '')}</p>`)).toBe(
      '<p>{% if a %}x{% endif %}</p>',
    );
  });

  it('t の印', () => {
    expect(back(`<table><tbody>${t('{% set n = 1 %}')}<tr><td>1</td></tr></tbody></table>`)).toBe(
      '<table><tbody>{% set n = 1 %}<tr><td>1</td></tr></tbody></table>',
    );
  });

  it('固めた要素は原文に戻す', () => {
    const raw = '<table><tbody>{% for r in rows %}{{ r }}{% endfor %}</tbody></table>';
    const html = `<table data-gjs-type="jinja-frozen" data-opaque="${b64encode(raw)}" data-opaque-kind="frozen"><tbody></tbody></table>1`;
    expect(back(html)).toBe(`${raw}1`);
  });

  it('style のチップ(rawtext)と本文全体', () => {
    const st = '<style>.a{color:{{ c }}}</style>';
    expect(
      back(
        `<div><span data-gjs-type="jinja-rawtext" data-opaque="${b64encode(st)}" data-opaque-kind="rawtext">CSS</span></div>`,
      ),
    ).toBe(`<div>${st}</div>`);
    const body = '{% if a %}<p>x{% endif %}</p>';
    expect(
      back(
        `<div data-gjs-type="jinja-frozen" class="jinja-frozen-body" data-opaque="${b64encode(body)}" data-opaque-kind="body"><p>x</p></div>`,
      ),
    ).toBe(body);
  });

  it('同じ親の中で入れ子になった繰り返しごと捨てる(内側の組も x の後ろにある)', () => {
    const html =
      `<div>${o(1, '{% for a in as %}')}${o(2, '{% if a %}')}<p>A</p>${c(2, '{% endif %}')}` +
      `${x(1)}${o(3, '{% if a %}')}<p>A2</p>${c(3, '{% endif %}')}${c(1, '{% endfor %}')}</div>`;
    expect(back(html)).toBe(
      '<div>{% for a in as %}{% if a %}<p>A</p>{% endif %}{% endfor %}</div>',
    );
  });

  it.each([
    ['DOMParser', defaultHtmlParser],
    ['linkedom', linkedomParser],
  ])('表の行の印を往復の正規形で比べても元と一致する(%s)', (_n, parse) => {
    const src =
      '<table><tbody>\n{% for r in rows %}\n<tr><td>{{ r.a }}</td></tr>\n{% endfor %}\n</tbody></table>';
    const html =
      `<table><tbody>\n${o(1, '{% for r in rows %}')}\n<tr data-jinja-loop-row=""><td>${chip('{{ r.a }}', '1')}</td></tr>` +
      `${x(1)}<tr><td>2</td></tr>\n${c(1, '{% endfor %}')}\n</tbody></table>`;
    // linkedom は断片から body を作らないので、文書の形で渡す。
    const out = toTemplate(
      `<html><head></head><body>${html}</body></html>`,
      { asFragment: true },
      parse,
    );
    expect(normalizeForRoundTrip(out, parse)).toBe(normalizeForRoundTrip(src, parse));
  });
});

describe('toTemplate — 本文の先頭のコメント', () => {
  // 断片の先頭のコメントは、`<body>` で包まずに読むと文書の直下へ置かれ、本文から落ちる。
  const parsers: Array<[string, (html: string) => string]> = [
    ['jsdom', (h) => toTemplate(h, { asFragment: true })],
    ['linkedom(素)', (h) => toTemplate(h, { asFragment: true }, linkedomParser)],
    ['linkedom(Worker)', (h) => htmlWorkerImpl.toTemplate(h, { asFragment: true })],
  ];
  const raws: Array<[string, string, Record<string, unknown>]> = [
    ['先頭が if', '{% if a %}<p>A</p>{% endif %}', { a: true }],
    ['先頭が採用枝の無い if', '{% if a %}<p>A</p>{% endif %}<p>z</p>', { a: false }],
    ['先頭が for', '{% for i in xs %}<p>{{ i }}</p>{% endfor %}<p>z</p>', { xs: [1, 2] }],
    ['空白の後の block', '\n  {% if a %}<p>A</p>{% endif %}', { a: true }],
    ['先頭が本物のコメント', '<!-- ===== Page 1 ===== --><div>x</div>', {}],
  ];
  for (const [pn, run] of parsers) {
    it.each(raws)(`${pn}: %s`, (_n, raw, sample) => {
      const out = run(toFilled(raw, sample));
      expect(normalizeForRoundTrip(out, defaultHtmlParser)).toBe(
        normalizeForRoundTrip(raw, defaultHtmlParser),
      );
    });
  }

  it('本物のコメントは文字どおり残る', () => {
    expect(back('<!-- a --><div>x</div>')).toBe('<!-- a --><div>x</div>');
  });
});

describe('toTemplate — 崩れた印は例外', () => {
  it.each([
    ['閉じが無い', `<p>${o(1, '{% if a %}')}x</p>`],
    ['開きが無い', `<p>x${c(1, '{% endif %}')}</p>`],
    ['親が違う', `<div>${o(1, '{% if a %}')}<p>x${c(1, '{% endif %}')}</p></div>`],
    [
      '交差',
      `<p>${o(1, '{% if a %}')}${o(2, '{% if b %}')}${c(1, '{% endif %}')}${c(2, '{% endif %}')}</p>`,
    ],
    ['書式違反', '<p><!--jinja-rt:o:1--></p>'],
    [
      '前半+後半が 1 ブロックにならない',
      `<p>${o(1, '{% if a %}<script>x</script>')}y${c(1, '{% endif %}<b>外</b>')}</p>`,
    ],
    ['合わせ目が枝の境目でない', `<p>${o(1, '{% if a %}x')}y${c(1, 'z{% endif %}')}</p>`],
    ['採用なしの間に中身', `<p>${o(1, '{% if a %}x{% endif %}')}入れた${c(1, '')}</p>`],
    ['t がブロックの文', `<p>${t('{% if a %}')}</p>`],
    [
      'frozen が 1 要素でない',
      `<div data-opaque="${b64encode('<p>a</p><p>b</p>')}" data-opaque-kind="frozen"></div>`,
    ],
    ['戻した結果のブロックが閉じない', `<p>${chip('{% if a %}', '')}</p>`],
    [
      'x が 2 個',
      `<ul>${o(1, '{% for i in xs %}')}<li>1</li>${x(1)}<li>2</li>${x(1)}<li>3</li>${c(1, '{% endfor %}')}</ul>`,
    ],
    [
      'x の id が違う',
      `<ul>${o(1, '{% for i in xs %}')}<li>1</li>${x(2)}<li>2</li>${c(1, '{% endfor %}')}</ul>`,
    ],
    [
      'x が if の組にある',
      `<div>${o(1, '{% if a %}')}<p>A</p>${x(1)}<p>B</p>${c(1, '{% endif %}')}</div>`,
    ],
    [
      'rawtext が許されない要素',
      `<span data-opaque="${b64encode('<div>{{ a }}</div>')}" data-opaque-kind="rawtext">x</span>`,
    ],
    [
      '本文全体の Jinja が閉じない',
      `<div data-opaque="${b64encode('{% if a %}')}" data-opaque-kind="body"></div>`,
    ],
    ['戻した結果に印が残る', '<p><span data-gjs-type="jinja-var">x</span></p>'],
  ])('%s', (_n, html) => {
    expect(() => back(html)).toThrow(/toTemplate/);
  });
});

describe('toTemplate — 旧形式は読まない', () => {
  it.each([
    [
      'data-jinja-open',
      `<table><tbody><tr data-jinja-open="${b64encode('{% for r in rows %}')}" data-jinja-close="${b64encode('{% endfor %}')}"><td>1</td></tr></tbody></table>`,
    ],
    [
      'data-jinja-loop-clone',
      '<table><tbody><tr data-jinja-loop-clone=""><td>2</td></tr></tbody></table>',
    ],
    [
      'data-jinja-block',
      `<p data-jinja-block="${b64encode('{% if a %}<p>A</p>{% endif %}')}">A</p>`,
    ],
  ])('%s は legacy-draft で例外', (_n, html) => {
    expect(() => back(html)).toThrow(/legacy-draft/);
  });
});
