import { describe, expect, it } from 'vitest';
import { analyzeFill } from '../src/lib/fillAnalysis';

const frozen = (raw: string) =>
  analyzeFill(raw).frozen.map((f) => `${f.form}:${f.tag}:${f.reason}:${raw.slice(f.start, f.end)}`);

describe('analyzeFill — 固めない形', () => {
  it.each([
    [
      '表の行を囲む for',
      '<table><tbody>{% for r in rows %}<tr><td>{{ r }}</td></tr><tr><td>x</td></tr>{% endfor %}</tbody></table>',
    ],
    ['段落の中の if', '<p>{% if a %}はい{% elif b %}<b>中</b>{% else %}いいえ{% endif %}</p>'],
    ['属性値の中の出力と if', '<td class="{% if a %}x{% else %}y{% endif %} {{ c }}">1</td>'],
    ['属性だけの Jinja を持つ svg', '<svg><rect width="{{ w }}"/></svg>'],
    ['Jinja を含まない style', '<style>.a{color:red}</style>'],
    ['HTML コメントの中に収まる if', '<p><!-- {% if a %}x{% endif %} --></p>'],
    ['script の中に収まる if', '<script>{% if a %}f(){% endif %}</script>'],
    ['math の中のタグ位置の Jinja', '<p><math><mi a={{ x }}>y</mi><mi></{{ z }}></mi></math></p>'],
  ])('%s', (_n, raw) => {
    expect(frozen(raw)).toEqual([]);
  });

  it('表の中の set と Jinja コメントは t の印にする', () => {
    const raw = '<table><tbody>{% set n = 1 %}{# memo #}<tr><td>a</td></tr></tbody></table>';
    const a = analyzeFill(raw);
    expect(a.frozen).toEqual([]);
    expect([...a.commentOnlyTokens].map((s) => raw.slice(s, s + 2))).toEqual(['{%', '{#']);
  });

  it('属性値の中のトークンとブロックは attrTokens に入る', () => {
    const raw = '<td class="{% if a %}x{% endif %}" title="{{ t }}">{{ v }}</td>';
    const a = analyzeFill(raw);
    expect([...a.attrTokens].map((s) => raw.slice(s, s + 7)).sort()).toEqual([
      '{% endi',
      '{% if a',
      '{{ t }}',
    ]);
  });

  it('走査結果を返す', () => {
    const a = analyzeFill('<table><tr><td>1</td></tr></table>');
    expect(a.scan.elements.map((e) => e.tag)).toEqual(['table', 'tr', 'td']);
  });
});

describe('analyzeFill — 固める形', () => {
  it('本文中の style / textarea / title の中の Jinja は要素ごとチップ', () => {
    expect(frozen('<div><style>.a{color:{{ c }}}</style></div>')).toEqual([
      'chip:style:rawtext:<style>.a{color:{{ c }}}</style>',
    ]);
    expect(frozen('<textarea>{{ v }}</textarea>')).toEqual([
      'chip:textarea:rawtext:<textarea>{{ v }}</textarea>',
    ]);
  });

  it('style のタグの中の Jinja もチップ', () => {
    expect(frozen('<p><style {{ m }}>a</style></p>')).toEqual([
      'chip:style:tag-position:<style {{ m }}>a</style>',
    ]);
  });

  it('svg の中のテキストの出力は外側の svg', () => {
    expect(frozen('<p><svg><g><svg><text>{{ v }}</text></svg></g></svg></p>')).toEqual([
      'element-svg:svg:svg:<svg><g><svg><text>{{ v }}</text></svg></g></svg>',
    ]);
  });

  it('表の行の間の出力・テキストは table', () => {
    const raw = '<div><table><tbody>{% for r in rows %}{{ r }}{% endfor %}</tbody></table></div>';
    expect(frozen(raw)).toEqual([`element:table:table-gap:${raw.slice(5, -6)}`]);
    expect(frozen('<table><tr>x<td>1</td></tr></table>')[0]).toMatch(/^element:table:table-gap:/);
  });

  it('select の中の出力は select', () => {
    expect(frozen('<p><select>{{ o }}<option>1</option></select></p>')).toEqual([
      'element:select:select-gap:<select>{{ o }}<option>1</option></select>',
    ]);
  });

  it('タグの中の属性値以外の位置', () => {
    expect(frozen('<p><td {% if a %}colspan=2{% endif %}>x</td></p>')[0]).toMatch(
      /^element:td:tag-position:/,
    );
  });

  it('`</` の直後の Jinja は親の要素', () => {
    expect(frozen('<div><p>a</{{ t }}></p></div>')).toEqual([
      'element:p:tag-position:<p>a</{{ t }}></p>',
    ]);
  });

  it('属性値の中に一部だけ入るブロックはそのタグの要素', () => {
    const raw = '<div><td class="{% if a %}x">1</td>{% endif %}</div>';
    expect(frozen(raw)).toEqual([`element:div:attr-crossing:${raw}`]);
  });

  it('枝の本文が HTML として閉じていない if はブロックを含む要素', () => {
    const raw =
      '<section>{% if a %}<div class="x">{% else %}<div class="y">{% endif %}本文</div></section>';
    expect(frozen(raw)).toEqual([`element:section:unbalanced-branch:${raw}`]);
  });

  it('枝の外で開いた要素を枝の中で閉じる for', () => {
    const raw = '<div><p>{% for x in xs %}a</p><p>{% endfor %}</p></div>';
    expect(frozen(raw)).toEqual([`element:div:unbalanced-branch:${raw}`]);
  });

  it.each([
    ['div', '<div><p>a{% if x %}<div>b</div>{% endif %}</p></div>'],
    ['ul', '<ul><li>a{% if x %}<li>b</li>{% endif %}</ul>'],
    ['div', '<div><p>a{% for x in xs %}<div>b</div>{% endfor %}</p></div>'],
  ])('枝の先頭のタグが枝の外の要素を暗黙に閉じる (%s)', (tag, raw) => {
    expect(frozen(raw)).toEqual([`element:${tag}:unbalanced-branch:${raw}`]);
  });

  it('対応しない終了タグの中の Jinja は親の要素', () => {
    const raw = '<div></span {{ x }}></div>';
    expect(frozen(raw)).toEqual([`element:div:tag-position:${raw}`]);
  });

  it('opaqueBlock はそれを含む要素', () => {
    expect(frozen('<div>{% macro m() %}<p>x</p>{% endmacro %}</div>')[0]).toMatch(
      /^element:div:opaque-block:/,
    );
  });

  it('表の文脈の raw はそれを含む要素', () => {
    const raw = '<table><tbody>{% raw %}<tr><td>1</td></tr>{% endraw %}</tbody></table>';
    expect(frozen(raw)).toEqual([`element:tbody:opaque-block:${raw.slice(7, -8)}`]);
  });

  it('HTML コメント・script の境界をまたぐブロックはそれを含む要素', () => {
    const c = '<div>{% if a %}<!-- {% endif %} --></div>';
    expect(frozen(c)).toEqual([`element:div:crossing:${c}`]);
    const s = '<div>{% if a %}<script>{% endif %}</script></div>';
    expect(frozen(s)).toEqual([`element:div:crossing:${s}`]);
  });

  it('最上位で崩れていれば本文全体、字句エラーも本文全体', () => {
    expect(frozen('{% if a %}<p>x{% endif %}</p>')).toEqual([
      'body:body:unbalanced-branch:{% if a %}<p>x{% endif %}</p>',
    ]);
    expect(analyzeFill('<p>{{ a </p>').frozen.map((f) => `${f.form}:${f.reason}`)).toEqual([
      'body:parse-error',
    ]);
  });

  it('body 要素を固める先にすると本文全体', () => {
    const raw = '<html><body {{ attrs }}><p>x</p></body></html>';
    expect(frozen(raw)).toEqual([`body:body:tag-position:${raw}`]);
  });

  it('入れ子になったら外側だけ', () => {
    const raw =
      '<table><tbody>{{ a }}<tr><td><svg><text>{{ b }}</text></svg></td></tr></tbody></table>';
    expect(frozen(raw).map((s) => s.split(':').slice(0, 3).join(':'))).toEqual([
      'element:table:table-gap',
    ]);
  });

  it('固めた範囲の中の属性トークンと t の印は外す', () => {
    const raw = '<table><tbody>{{ a }}{# m #}<tr><td class="{{ c }}">1</td></tr></tbody></table>';
    const a = analyzeFill(raw);
    expect(a.frozen).toHaveLength(1);
    expect(a.attrTokens.size).toBe(0);
    expect(a.commentOnlyTokens.size).toBe(0);
  });
});

describe('analyzeFill — script と数式', () => {
  it('script / math 要素と、条件を満たす TeX を数える', () => {
    const raw =
      '<div>{% if a %}<script>f({{ x }})</script>{% endif %}<math><mi>x</mi></math> $$x^2$$ \\(a<b\\)</div>';
    const a = analyzeFill(raw);
    expect(a.opaque.map((o) => `${o.kind}:${raw.slice(o.start, o.end)}`)).toEqual([
      'script:<script>f({{ x }})</script>',
      'math:<math><mi>x</mi></math>',
      'math:$$x^2$$',
    ]);
  });

  it('ブロックの枝の境界を内側に持つ TeX、属性値の中の TeX は数えない', () => {
    const raw = '<p>$$a{% if b %}c$${% endif %}</p><p title="\\(x\\)">y</p>';
    expect(analyzeFill(raw).opaque).toEqual([]);
  });

  it('固めた範囲の中の script は数えない', () => {
    const raw = '<table><tbody>{{ a }}<tr><td><script>s()</script></td></tr></tbody></table>';
    expect(analyzeFill(raw).opaque).toEqual([]);
  });
});
