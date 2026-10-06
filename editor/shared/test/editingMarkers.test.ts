import { describe, expect, it } from 'vitest';
import { findEditingMarkers } from '../src/security/editingMarkers';

const kinds = (html: string) => findEditingMarkers(html).map((h) => h.marker);

describe('findEditingMarkers', () => {
  it('正当なテンプレートでは 0 件', () => {
    const tpl =
      '<!doctype html><html><head><title>{{ fund.name }}</title></head><body>' +
      '<!-- 通常のコメント --><p class="chip-like">data-jinja という語は地の文</p>' +
      '<table><tbody>{% for r in rows %}<tr data-x="{{ r.a }}"><td>{{ r.b }}</td></tr>{% endfor %}</tbody></table>' +
      '<script>var a = "data-opaque";</script></body></html>';
    expect(findEditingMarkers(tpl)).toEqual([]);
  });

  it('範囲の印のコメント', () => {
    expect(kinds('<p><!--jinja-rt:o:1:e3sgaWYgYSAlfQ==-->x</p>')).toEqual(['comment:jinja-rt']);
    expect(kinds('<p><!-- jinja-rt:x:1 --></p>')).toEqual(['comment:jinja-rt']);
  });

  it('チップ・伏せの属性(値の有無・大文字・引用符の種類を問わない)', () => {
    expect(kinds('<span data-jinja="e3t9fQ==">x</span>')).toEqual(['attr:data-jinja']);
    expect(kinds('<tr DATA-JINJA-LOOP-CLONE><td>x</td></tr>')).toEqual([
      'attr:data-jinja-loop-clone',
    ]);
    expect(kinds('<div data-opaque=\'YQ==\' data-opaque-kind="frozen"></div>')).toEqual([
      'attr:data-opaque',
      'attr:data-opaque-kind',
    ]);
    expect(kinds('<tr data-jinja-loop-row></tr>')).toEqual(['attr:data-jinja-loop-row']);
  });

  it('チップの型と class', () => {
    expect(kinds('<span data-gjs-type="jinja-var">1</span>')).toEqual(['gjs-type:jinja']);
    expect(kinds('<span class="a jinja-chip b">1</span>')).toEqual(['class:jinja-chip']);
    expect(kinds('<div class="jinja-frozen-body"></div>')).toEqual(['class:jinja-frozen-body']);
  });

  it('復元の placeholder 文字', () => {
    expect(kinds('<p>\u{e000}YQ==\u{e001}</p>')).toEqual(['placeholder', 'placeholder']);
  });

  it('属性値の中の Jinja や地の文の語には当たらない', () => {
    expect(findEditingMarkers('<a title="data-jinja=1">data-opaque</a>')).toEqual([]);
  });
});
