import { describe, expect, it } from 'vitest';
import { type JinjaNode, lexJinja, parseJinja } from '../src/lib/jinjaLex';

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

/** 木を短い文字列にして比べる。 */
function shape(src: string, nodes: JinjaNode[]): string {
  return nodes
    .map((n) => {
      switch (n.type) {
        case 'text':
          return `T(${src.slice(n.start, n.end)})`;
        case 'token':
          return `K(${n.token.source})`;
        case 'raw':
          return `RAW(${src.slice(n.open.end, n.close.start)})`;
        case 'opaqueBlock':
          return `OB(${n.open.keyword})`;
        case 'if':
          return `IF[${n.branches.map((b) => `${b.tag.keyword}:${shape(src, b.children)}`).join('|')}]`;
        default:
          return `FOR[${shape(src, n.body.children)}${n.elseBranch ? `|else:${shape(src, n.elseBranch.children)}` : ''}]`;
      }
    })
    .join(' ');
}
const tree = (s: string) => {
  const r = parseJinja(s);
  if (!r.ok) throw new Error(r.error.message);
  return shape(s, r.nodes);
};

describe('parseJinja', () => {
  it('if / elif / elseif / else を枝に分ける', () => {
    expect(tree('{% if a %}A{% elif b %}B{% elseif c %}C{% else %}D{% endif %}')).toBe(
      'IF[if:T(A)|elif:T(B)|elseif:T(C)|else:T(D)]',
    );
  });

  it('入れ子と for-else', () => {
    expect(
      tree('{% for x in xs %}{% if x %}<p>{{ x }}</p>{% endif %}{% else %}none{% endfor %}'),
    ).toBe('FOR[IF[if:T(<p>) K({{ x }}) T(</p>)]|else:T(none)]');
  });

  it('枝の本文の位置は原文の位置', () => {
    const s = '<div>{%- if a -%}\n<p>A</p>\n{%- endif %}</div>';
    const r = parseJinja(s);
    if (!r.ok) throw new Error();
    const n = r.nodes[1];
    if (n.type !== 'if') throw new Error();
    expect(s.slice(n.start, n.end)).toBe('{%- if a -%}\n<p>A</p>\n{%- endif %}');
    expect(s.slice(n.branches[0].bodyStart, n.branches[0].bodyEnd)).toBe('\n<p>A</p>\n');
  });

  it('raw と、中身を扱わないブロック', () => {
    expect(
      tree(
        '{% raw %}{{ a }}{% endraw %}{% macro m() %}x{% endmacro %}{% set y %}z{% endset %}{% set a = 1 %}',
      ),
    ).toBe('RAW({{ a }}) OB(macro) OB(set) K({% set a = 1 %})');
  });

  it('中身を扱わないブロックは同種の入れ子を数える', () => {
    expect(tree('{% macro a() %}{% macro b() %}{% endmacro %}{% endmacro %}x')).toBe(
      'OB(macro) T(x)',
    );
  });

  it.each([
    ['{% if a %}x', '閉じない if'],
    ['{% endif %}', '対応しない endif'],
    ['{% else %}', 'if の外の else'],
    ['{% if a %}{% else %}{% elif b %}{% endif %}', 'else の後の elif'],
    ['{% if a %}{% else %}{% else %}{% endif %}', '2 個目の else'],
    ['{% for x in y %}{% endif %}', '種類の違う end'],
    ['{% for x in y %}{% elif a %}{% endfor %}', 'for の elif'],
    ['{% macro m() %}x', '閉じない macro'],
    ['{{ a', '字句エラー'],
  ])('%s はエラー(%s)', (s) => {
    expect(parseJinja(s).ok).toBe(false);
  });
});
