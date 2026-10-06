import { describe, expect, it } from 'vitest';
import { type JinjaNode, parseJinja } from '../src/lib/jinjaLex';

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
