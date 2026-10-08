import { describe, expect, it } from 'vitest';
import { JINJA_DELIMS, jinjaCloserOf, lexJinja } from '../src/jinja/jinjaLex';

const toks = (s: string) => {
  const r = lexJinja(s);
  if (!r.ok) throw new Error(r.error.message);
  return r.tokens.map((t) => [t.kind, t.source, t.keyword, t.trimLeft, t.trimRight]);
};

describe('lexJinja', () => {
  it('3 種のトークンを原文の位置ごと切り出す', () => {
    const s = '<p>{{ a }}{% if b %}{# c #}</p>';
    const r = lexJinja(s);
    expect(r.ok && r.tokens.map((t) => s.slice(t.start, t.end))).toEqual([
      '{{ a }}',
      '{% if b %}',
      '{# c #}',
    ]);
    expect(toks(s)).toEqual([
      ['output', '{{ a }}', null, false, false],
      ['stmt', '{% if b %}', 'if', false, false],
      ['comment', '{# c #}', null, false, false],
    ]);
  });

  it('空白制御の - と + を記録する', () => {
    expect(toks('{%- if a -%}{%+ endif %}{{- x -}}')).toEqual([
      ['stmt', '{%- if a -%}', 'if', true, true],
      ['stmt', '{%+ endif %}', 'endif', false, false],
      ['output', '{{- x -}}', null, true, true],
    ]);
  });

  it('引用符の中の閉じ記号を読み飛ばす', () => {
    expect(toks(`{{ "}}" }}{% set a = '%}' %}`)).toEqual([
      ['output', '{{ "}}" }}', null, false, false],
      ['stmt', `{% set a = '%}' %}`, 'set', false, false],
    ]);
  });

  it('コメントは引用符を考えず最初の #} で閉じる', () => {
    expect(toks(`{# it's #}x`)).toEqual([['comment', `{# it's #}`, null, false, false]]);
  });

  it('raw / verbatim の中はトークンにしない', () => {
    expect(toks('{% raw %}{{ a }}{% endraw %}{% verbatim %}{%x%}{% endverbatim %}')).toEqual([
      ['stmt', '{% raw %}', 'raw', false, false],
      ['stmt', '{% endraw %}', 'endraw', false, false],
      ['stmt', '{% verbatim %}', 'verbatim', false, false],
      ['stmt', '{% endverbatim %}', 'endverbatim', false, false],
    ]);
  });

  it('body は区切りと空白制御を除いて trim する', () => {
    const r = lexJinja('{%- for x in xs -%}');
    expect(r.ok && r.tokens[0].body).toBe('for x in xs');
  });

  it('閉じない区切りは位置つきのエラー', () => {
    expect(lexJinja('<p>{{ a </p>')).toEqual({
      ok: false,
      error: { message: expect.any(String), at: 3 },
    });
    expect(lexJinja('{% raw %}x')).toMatchObject({ ok: false });
    expect(lexJinja('{# x')).toMatchObject({ ok: false });
  });

  it('Jinja でない { は地の文', () => {
    expect(toks('a { b } {x} $$ {')).toEqual([]);
  });
});

describe('JINJA_DELIMS / jinjaCloserOf', () => {
  it('開き記号 3 種と対の閉じ記号', () => {
    expect(JINJA_DELIMS.map((d) => [d.open, d.close])).toEqual([
      ['{{', '}}'],
      ['{%', '%}'],
      ['{#', '#}'],
    ]);
    expect(jinjaCloserOf('{{')).toBe('}}');
    expect(jinjaCloserOf('{%')).toBe('%}');
    expect(jinjaCloserOf('{#')).toBe('#}');
  });

  it('Jinja の開き記号でなければ undefined', () => {
    for (const s of ['{', '{x', '}}', '', '{{{']) expect(jinjaCloserOf(s)).toBeUndefined();
  });
});
