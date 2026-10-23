// 固める形・チップにする形の出力が、値入りで見え、`toTemplate` で原文へ戻ることを固定する。
// 復元は jsdom(既定)と Worker 側の linkedom の両方で確かめる。
import { describe, expect, it } from 'vitest';
import { toFilledWithDiagnostics } from '../src/lib/fillJinja';
import { defaultHtmlParser } from '../src/lib/htmlParser';
import { normalizeForRoundTrip, toTemplate } from '../src/lib/jinjaMask';
import { htmlWorkerImpl } from '../src/workers/htmlWorkerImpl';

const fill = (raw: string, s: Record<string, unknown> = {}) => toFilledWithDiagnostics(raw, s);
const norm = (h: string) => normalizeForRoundTrip(h, defaultHtmlParser);

const restorers: [string, (h: string) => string][] = [
  ['jsdom', (h) => toTemplate(h, { asFragment: true })],
  ['linkedom', (h) => htmlWorkerImpl.toTemplate(h, { asFragment: true })],
];

describe.each(restorers)('固める形(%s で復元)', (_name, restore) => {
  it('表の行の間の出力: table を値入りで描き、原文で戻す', () => {
    const raw =
      '<div><table><tbody>{% for r in rows %}<tr><td>{{ r }}</td></tr>{{ r }}{% endfor %}</tbody></table></div>';
    const { html, diagnostics } = fill(raw, { rows: ['甲', '乙'] });
    expect(diagnostics.frozen).toEqual([{ tag: 'table', reason: 'table-gap' }]);
    expect(html).toContain('jinja-frozen-body');
    expect(html).toContain('data-opaque-kind="frozen"');
    expect(html).toContain('甲');
    expect(html).toContain('乙');
    expect(norm(restore(html))).toBe(norm(raw));
  });

  it('svg: jinja-frozen-svg で描き、値が見える', () => {
    const raw = '<p><svg viewBox="0 0 10 10"><text x="1">{{ v }}</text></svg></p>';
    const { html, diagnostics } = fill(raw, { v: 42 });
    expect(diagnostics.frozen.map((r) => r.tag)).toEqual(['svg']);
    expect(html).toMatch(/<svg data-gjs-type="jinja-frozen-svg"[^>]*>.*42/);
    expect(norm(restore(html))).toBe(norm(raw));
  });

  it.each([
    ['style', '<div><style>.a{color:{{ c }}}</style></div>', 'CSS'],
    ['textarea', '<div><textarea>{{ v }}</textarea></div>', '入力欄'],
    ['title', '<div><title>{{ v }}</title></div>', '題名'],
  ])('%s は本文でもラベル付きのチップ', (_n, raw, label) => {
    const { html } = fill(raw, { c: 'red', v: 'x' });
    expect(html).toContain('data-gjs-type="jinja-rawtext"');
    expect(html).toContain(`>${label}</span>`);
    expect(norm(restore(html))).toBe(norm(raw));
  });

  it('枝をまたぐ要素は外側の要素、最上位なら本文全体', () => {
    const inner =
      '<section>{% if a %}<div class="x">{% else %}<div class="y">{% endif %}本文</div></section>';
    const r0 = fill(inner, { a: true });
    expect(r0.diagnostics.frozen).toEqual([{ tag: 'section', reason: 'unbalanced-branch' }]);
    expect(norm(restore(r0.html))).toBe(norm(inner));
    const top = '{% if a %}<p>x{% endif %}</p>';
    const r = fill(top, { a: true });
    expect(r.diagnostics.frozen).toEqual([{ tag: 'body', reason: 'unbalanced-branch' }]);
    expect(r.html).toContain('class="jinja-frozen-body"');
    expect(norm(restore(r.html))).toBe(norm(top));
  });

  it('字句エラーは本文全体を固め、structureError を返す(復元は不可)', () => {
    const r = fill('<p>{{ a </p>');
    expect(r.diagnostics.structureError).not.toBeNull();
    expect(() => restore(r.html)).toThrow();
  });

  it('文書全体を渡したとき head は原文のまま、本文だけを包む', () => {
    const raw =
      '<!doctype html><html><head><title>{{ t }}</title></head><body>{% if a %}<p>x{% endif %}</p></body></html>';
    const { html } = fill(raw, { a: true });
    expect(html).toContain('<head><title>');
    expect(html).toMatch(/<body><div data-gjs-type="jinja-frozen" class="jinja-frozen-body"/);
  });

  it('表の中の set は t の印で、表は固めない', () => {
    const raw = '<table><tbody>{% set n = 1 %}<tr><td>{{ n }}</td></tr></tbody></table>';
    const { html, diagnostics } = fill(raw);
    expect(diagnostics.frozen).toEqual([]);
    expect(html).toContain('<!--jinja-rt:t:');
    expect(norm(restore(html))).toBe(norm(raw));
  });
});
