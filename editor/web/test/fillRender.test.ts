import { describe, expect, it } from 'vitest';
import {
  escapeHtmlFull,
  Filler,
  loopCtx,
  parseForHeader,
  renderDisplay,
  takenBranchIndex,
} from '../src/lib/fillRender';
import { parseJinja } from '../src/lib/jinjaLex';

const show = (src: string, ctx: Record<string, unknown>, f = new Filler()) => {
  const r = parseJinja(src);
  if (!r.ok) throw new Error(r.error.message);
  return renderDisplay(src, r.nodes, ctx, f);
};

describe('takenBranchIndex — elif を正しく選ぶ', () => {
  const src = '{% if a %}A{% elif b %}B{% else %}C{% endif %}';
  const node = (() => {
    const r = parseJinja(src);
    if (!r.ok || r.nodes[0].type !== 'if') throw new Error();
    return r.nodes[0];
  })();
  it.each([
    [{ a: true, b: true }, 0],
    [{ a: false, b: true }, 1],
    [{ a: false, b: false }, 2],
  ])('%o → 枝 %i', (ctx, i) => {
    expect(takenBranchIndex(node, ctx, new Filler())).toBe(i);
  });
  it('else が無く全部偽なら -1', () => {
    const r = parseJinja('{% if a %}A{% endif %}');
    if (!r.ok || r.nodes[0].type !== 'if') throw new Error();
    expect(takenBranchIndex(r.nodes[0], {}, new Filler())).toBe(-1);
  });
  it('elseif と空白制御つきの枝も条件を読む', () => {
    expect(show('{%- if a -%}A{%- elseif b -%}B{%- endif -%}', { a: 0, b: 1 })).toBe('B');
  });
});

describe('renderDisplay', () => {
  it('値はエスケープし、for・for-else・loop を扱う', () => {
    expect(show('<p title="{{ q }}">{{ v }}</p>', { q: '"x"', v: '<b>' })).toBe(
      '<p title="&quot;x&quot;">&lt;b&gt;</p>',
    );
    expect(
      show('{% for r in rs %}<i>{{ loop.index }}{{ r }}</i>{% else %}無{% endfor %}', {
        rs: ['a', 'b'],
      }),
    ).toBe('<i>1a</i><i>2b</i>');
    expect(show('{% for r in rs %}x{% else %}無{% endfor %}', { rs: [] })).toBe('無');
  });
  it('コメント・set・opaqueBlock は出さず、raw は中身を出す', () => {
    expect(
      show(
        'a{# c #}{% set z = 1 %}{% macro m() %}M{% endmacro %}{% raw %}{{ k }}{% endraw %}b',
        {},
      ),
    ).toBe('a{{ k }}b');
  });
  it('for a, b in のタプル', () => {
    expect(
      show('{% for k, v in xs %}{{ k }}={{ v }};{% endfor %}', {
        xs: [
          ['a', 1],
          ['b', 2],
        ],
      }),
    ).toBe('a=1;b=2;');
  });
  it('入れ子の for と if を再帰で描き、外側の loop は内側で隠れる', () => {
    const src =
      '{% for g in gs %}[{% for x in g.xs %}{% if loop.first %}{{ g.n }}:{% endif %}{{ x }}{{ loop.length }}{% endfor %}]{% endfor %}';
    expect(
      show(src, {
        gs: [
          { n: 'P', xs: [1, 2] },
          { n: 'Q', xs: [3] },
        ],
      }),
    ).toBe('[P:1222][Q:31]');
  });
  it('採用する枝が無い if は何も出さない', () => {
    expect(show('a{% if x %}X{% elif y %}Y{% endif %}b', {})).toBe('ab');
  });
  it('解釈できない for の頭は unsupported に数え、本文を 1 回だけ描く', () => {
    const f = new Filler();
    expect(show('{% for 1 in xs %}<i>{{ v }}</i>{% endfor %}', { v: 'z' }, f)).toBe('<i>z</i>');
    expect([...f.unsupported]).toEqual(['for 1 in xs']);
  });
  it('値の無い出力は missing に数える', () => {
    const f = new Filler();
    expect(show('<p>{{ nope }}</p>', {}, f)).toBe('<p></p>');
    expect([...f.missing]).toEqual(['nope']);
  });
});

describe('部品', () => {
  it('parseForHeader', () => {
    expect(parseForHeader('for a in xs')).toEqual({ vars: ['a'], iter: 'xs' });
    expect(parseForHeader('for a , b in d.items()')).toEqual({
      vars: ['a', 'b'],
      iter: 'd.items()',
    });
    expect(parseForHeader('for in xs')).toBeNull();
  });
  it('loopCtx は元の ctx を変えず、loop の 5 項目を持つ', () => {
    const base = { a: 1 };
    const c = loopCtx(base, ['k', 'v'], [['x', 9]], 0);
    expect(c).toMatchObject({ a: 1, k: 'x', v: 9 });
    expect(c.loop).toEqual({ index: 1, index0: 0, first: true, last: true, length: 1 });
    expect(base).toEqual({ a: 1 });
  });
  it('escapeHtmlFull', () => {
    expect(escapeHtmlFull(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
  });
});
