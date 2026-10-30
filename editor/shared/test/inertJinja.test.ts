import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { InertJinjaJudge } from '../src/jinja/inertJinja';
import { type JinjaToken, lexJinja } from '../src/jinja/jinjaLex';

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../fixtures');

function lexOrThrow(source: string): JinjaToken[] {
  const r = lexJinja(source);
  if (!r.ok || r.tokens.length < 1) throw new Error(`読めない: ${source}`);
  return r.tokens;
}

/** 1 トークンだけの原文を字句解析して判定する(束ねはその 1 トークンの文書で集める)。 */
function inert(source: string): boolean {
  const tokens = lexOrThrow(source);
  return new InertJinjaJudge(tokens).isInert(tokens[0] as JinjaToken);
}

/** 文書の中で、不活性でないトークンの原文を並べる。 */
function nonInert(source: string): string[] {
  const tokens = lexOrThrow(source);
  const judge = new InertJinjaJudge(tokens);
  return tokens.filter((t) => !judge.isInert(t)).map((t) => t.source);
}

describe('InertJinjaJudge — テキストの位置で不活性とみなす形', () => {
  it.each([
    '{{ fund.name }}',
    '{{ note|safe }}',
    '{{ x|default("—") }}',
    '{{ d["k"] }}',
    '{{ loop.index }}',
    '{{ range(3) }}',
    '{{- fund.name -}}',
    '{% if a > b %}',
    '{% elif fund.code == "950037" %}',
    '{% else %}',
    '{% endif %}',
    '{% for h in holdings %}',
    '{% for a, b in pairs %}',
    '{% for h in holdings|selectattr("show") %}',
    '{% endfor %}',
    '{% set n = 1 %}',
    '{% set total = fund.total %}',
    '{# 説明のコメント #}',
    '{% raw %}x{% endraw %}',
  ])('%s', (src) => {
    expect(inert(src)).toBe(true);
  });

  it('{% endraw %} も不活性', () => {
    expect(nonInert('{% raw %}x{% endraw %}')).toEqual([]);
  });
});

describe('InertJinjaJudge — 不活性でない形', () => {
  it.each([
    ['< を出すリテラル', '{{ "<"|safe }}'],
    [': を含むリテラル', '{{ "a:b" }}'],
    ['エスケープで < を書くリテラル', '{{ "\\x3c" }}'],
    ['書式で文字を作る', '{{ "%c" % 60 }}'],
    ['_ で始まるメンバ', '{{ x.__class__ }}'],
    ['_ で始まる名前', '{{ _secret }}'],
    ['_ を含む添字の文字列', '{{ x["__class__"] }}'],
    ['namespace の出力', '{{ namespace(a=1) }}'],
    ['select の出力', '{{ xs|select("x") }}'],
    ['batch の出力', '{{ xs|batch(2) }}'],
    ['slice の出力', '{{ xs|slice(2) }}'],
    ['loop をそのまま出す', '{{ loop }}'],
    ['ブロックの set', '{% set lt %}'],
    ['< を束ねる set', '{% set lt = "<" %}'],
    ['include', '{% include "a" %}'],
    ['macro', '{% macro m() %}'],
    ['filter', '{% filter upper %}'],
    ['for … if', '{% for x in xs if x %}'],
    ['for … recursive', '{% for x in xs recursive %}'],
    ['反復の対象のリテラルに <', '{% for lt in ["<"] %}'],
    ['読めない for', '{% for in xs %}'],
    ['verbatim', '{% verbatim %}x{% endverbatim %}'],
    ['未知の文', '{% do xs.append(1) %}'],
    ['キーワードの後ろに余計な字のある else', '{% else x %}'],
    ['条件の無い if', '{% if %}'],
  ])('%s: %s', (_label, src) => {
    expect(inert(src)).toBe(false);
  });
});

describe('fixture のテキストの位置の Jinja はすべて不活性', () => {
  // 作成タブで fixture のパーツを挿入しただけで不変ゲートが拒否する形になっていないことを固定する。
  const templates = readdirSync(path.join(FIXTURES, 'templates')).filter((f) =>
    f.endsWith('.html'),
  );
  const parts = JSON.parse(readFileSync(path.join(FIXTURES, 'parts.json'), 'utf8')) as {
    id: string;
    content: string;
  }[];
  const sources: [string, string][] = [
    ...templates.map(
      (f) => [f, readFileSync(path.join(FIXTURES, 'templates', f), 'utf8')] as [string, string],
    ),
    ...parts.map((p) => [p.id, p.content] as [string, string]),
  ];

  it.each(sources)('%s', (_name, html) => {
    const r = lexJinja(html);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 文脈で絞らず全トークンを見る(属性値の中の `data-rank="{{ loop.index }}"` も不活性の形)。
    // 文脈ごとの単位の数は `server/test/templateScripts.test.ts` が fixture で固定している。
    const judge = new InertJinjaJudge(r.tokens);
    expect(r.tokens.filter((t) => !judge.isInert(t)).map((t) => t.source)).toEqual([]);
  });
});

// 出力の規則の根拠は本番の Python Jinja2 の `str()`。`<` を Python が自分から書く値だけを外す。
//   str(namespace(a=1))        -> "<Namespace {'a': 1}>"(中身にリテラル・データが入る)
//   str(xs|select("x")) など   -> "<generator object select_or_reject at 0x…>"
//   str(loop)                  -> "<LoopContext 1/3>"
//   str(range(3))              -> "range(0, 3)"、str(xs|list) -> "['a', 'b']"(`<` を書かない)
describe('InertJinjaJudge — Python の str() を根拠にした出力の規則', () => {
  it.each([
    ['range の出力', '{{ range(3) }}'],
    ['list の出力', '{{ xs|list }}'],
    ['namespace を束ねる set', '{% set ns = namespace(total=0) %}'],
    ['namespace の属性への加算', '{% set ns.total = ns.total + d.amount %}'],
    ['select を束ねる set', '{% set shown = xs|select("x") %}'],
    ['for の対象の batch', '{% for row in xs|batch(2) %}'],
    ['if の条件の select', '{% if xs|select("x")|list %}'],
    ['namespace の呼び出しのメンバ', '{{ namespace(a=1).a }}'],
  ])('%s は不活性: %s', (_label, src) => {
    expect(inert(src)).toBe(true);
  });

  it('namespace の合計の書き方は文書ごと不活性', () => {
    const doc =
      '{% set ns = namespace(total=0) %}{% for d in ds %}' +
      '{% set ns.total = ns.total + d.amount %}{% endfor %}<p>{{ ns.total }}</p>{{ ns["total"] }}';
    expect(nonInert(doc)).toEqual([]);
  });

  it.each([
    ['namespace の束ね名の裸の出力', '{% set ns = namespace(a=1) %}{{ ns }}', '{{ ns }}'],
    ['フィルタを通した束ね名', '{% set ns = namespace(a=1) %}{{ ns|safe }}', '{{ ns|safe }}'],
    ['括弧で包んだ束ね名', '{% set ns = namespace() %}{{ (ns) }}', '{{ (ns) }}'],
    ['or で返る束ね名', '{% set ns = namespace() %}{{ ns or 1 }}', '{{ ns or 1 }}'],
    ['束ね名の別名', '{% set ns = namespace() %}{% set m = ns %}{{ m }}', '{{ m }}'],
    ['後ろで束ねる名前の別名', '{% set m = ns %}{% set ns = namespace() %}{{ m }}', '{{ m }}'],
    ['select の束ね名', '{% set s = xs|select("x") %}{{ s }}', '{{ s }}'],
    ['batch の束ね名', '{% set b = xs|batch(2) %}{{ b|default(1) }}', '{{ b|default(1) }}'],
    ['loop の束ね名', '{% for x in xs %}{% set l = loop %}{{ l }}{% endfor %}', '{{ l }}'],
    [
      'リストに入れた束ね名で回す',
      '{% set ns = namespace() %}{% for g in [ns] %}{{ g }}{% endfor %}',
      '{{ g }}',
    ],
    [
      'リストに入れた select で回す',
      '{% for g in [xs|select("x")] %}{{ g }}{% endfor %}',
      '{{ g }}',
    ],
    [
      '別のテキスト以外の位置の束ね',
      '<p title="{% set ns = namespace() %}">{{ ns }}</p>',
      '{{ ns }}',
    ],
  ])('%s は不活性でない', (_label, doc, want) => {
    expect(nonInert(doc)).toEqual([want]);
  });

  it.each([
    ['select の出力', '{{ xs|select("x") }}'],
    ['reject の出力', '{{ xs|reject("x") }}'],
    ['selectattr の出力', '{{ xs|selectattr("a") }}'],
    ['rejectattr の出力', '{{ xs|rejectattr("a") }}'],
    ['batch の出力', '{{ xs|batch(2) }}'],
    ['slice の出力', '{{ xs|slice(2) }}'],
    ['namespace の出力', '{{ namespace(a=1) }}'],
    ['loop の出力', '{{ loop }}'],
    ['フィルタを通した loop', '{{ loop|safe }}'],
    ['リストに入れた loop', '{{ [loop] }}'],
    ['namespace の属性へ namespace を置く', '{% set ns.x = namespace() %}'],
    ['namespace の属性へ select を置く', '{% set ns.x = xs|select("x") %}'],
  ])('%s は不活性でない: %s', (_label, src) => {
    expect(inert(src)).toBe(false);
  });
});

describe('InertJinjaJudge — 評価器の文法の外は不活性でない', () => {
  it.each([
    ['~ 連結', '{{ a ~ b }}'],
    ['インラインの if', '{{ a if b else c }}'],
    ['in 演算子', '{{ a in b }}'],
    ['許可していないフィルタ', '{{ x|upper }}'],
    ['許可していないテスト', '{% if x is odd %}'],
    ['許可していない関数', '{{ lipsum(1) }}'],
    ['値の呼び出し', '{{ x() }}'],
    ['条件の ~', '{% if a ~ b %}'],
    ['反復の対象のインラインの if', '{% for x in a if b else c %}'],
    ['set の右辺の ~', '{% set y = a ~ b %}'],
    ['キーワード引数の名前が _ で始まる', '{{ namespace(_a=1).b }}'],
  ])('%s: %s', (_label, src) => {
    expect(inert(src)).toBe(false);
  });
});

// 読めない文は基準にあれば単位として通る。その文が束ねた名前を後から出す形を、メンバを引いても止める。
describe('InertJinjaJudge — 読めない文が束ねた名前は何を引いても出せない', () => {
  it.each([
    [
      '右辺が文法の外の set',
      '{% set m = ns if c else 1 %}{{ m }}{{ m.a }}',
      ['{% set m = ns if c else 1 %}', '{{ m }}', '{{ m.a }}'],
    ],
    [
      'ブロックの set',
      '{% set lt %}<{% endset %}{{ lt }}',
      ['{% set lt %}', '{% endset %}', '{{ lt }}'],
    ],
    ['複数の代入', '{% set a, b = x, y %}{{ b }}', ['{% set a, b = x, y %}', '{{ b }}']],
    [
      '読めない for',
      '{% for (a, b) in xs %}{{ a.k }}{% endfor %}',
      ['{% for (a, b) in xs %}', '{{ a.k }}'],
    ],
    [
      'for … if',
      '{% for g in xs if g %}{{ g }}{% endfor %}',
      ['{% for g in xs if g %}', '{{ g }}'],
    ],
    [
      'with',
      '{% with m = ns %}{{ m.a }}{% endwith %}',
      ['{% with m = ns %}', '{{ m.a }}', '{% endwith %}'],
    ],
    [
      'macro の引数',
      '{% macro row(x) %}{{ x }}{% endmacro %}',
      ['{% macro row(x) %}', '{{ x }}', '{% endmacro %}'],
    ],
    ['import の別名', '{% import "a" as m %}{{ m.b }}', ['{% import "a" as m %}', '{{ m.b }}']],
    [
      'do で書き換えた並び',
      '{% do xs.append(ns) %}{{ xs }}',
      ['{% do xs.append(ns) %}', '{{ xs }}'],
    ],
    [
      '読めない set の別名',
      '{% set m = a ~ b %}{% set k = m.x %}{{ k }}',
      ['{% set m = a ~ b %}', '{{ k }}'],
    ],
    [
      'namespace の属性に束ね名を置く',
      '{% set ns = namespace() %}{% set o = namespace() %}{% set o.x = ns %}{{ o.x }}',
      ['{% set o.x = ns %}', '{{ o.x }}'],
    ],
  ])('%s', (_label, doc, want) => {
    expect(nonInert(doc)).toEqual(want);
  });

  it('include・filter は名前を束ねない', () => {
    expect(
      nonInert('{% include "a" %}{% filter upper %}x{% endfilter %}{{ a }}{{ upper }}'),
    ).toEqual(['{% include "a" %}', '{% filter upper %}', '{% endfilter %}']);
  });
});

// 入れ物(リスト・namespace の属性・呼び出しの引数)に危ない値を入れて束ねると、メンバや添字で
// 取り出した値がそのものになる。根拠は Python jinja2 3.1.6 の出力(どれも `<Namespace …>` などを出す)。
describe('InertJinjaJudge — 入れ物を経由した束ね', () => {
  it.each([
    [
      'リストに namespace',
      '{% set ns = namespace(a=1) %}{% set l = [ns] %}{{ l[0] }}',
      '{{ l[0] }}',
    ],
    [
      'namespace の引数に namespace の束ね名',
      '{% set ns = namespace(a=1) %}{% set d = namespace(k=ns) %}{{ d.k }}',
      '{{ d.k }}',
    ],
    ['namespace の入れ子', '{% set ns = namespace(a=namespace(b=1)) %}{{ ns.a }}', '{{ ns.a }}'],
    [
      'namespace の属性のリストを回す',
      '{% set ns2 = namespace(a=1) %}{% set ns = namespace(l=[ns2]) %}' +
        '{% for g in ns.l %}{{ g }}{% endfor %}',
      '{{ g }}',
    ],
    [
      '二重のリストを回す',
      '{% set ns = namespace(a=1) %}{% for g in [[ns]] %}{{ g[0] }}{% endfor %}',
      '{{ g[0] }}',
    ],
    ['リストに select', `{% set l = [xs|select('defined')] %}{{ l[0] }}`, '{{ l[0] }}'],
    ['リストに loop', '{% for a in xs %}{% set l = [loop] %}{{ l[0] }}{% endfor %}', '{{ l[0] }}'],
    [
      'default の引数に束ね名',
      '{% set ns = namespace() %}{% set m = xs|default(ns) %}{{ m.a }}',
      '{{ m.a }}',
    ],
  ])('%s', (_label, doc, want) => {
    expect(nonInert(doc)).toEqual([want]);
  });
});

// loop の値そのものを返すメンバ(`previtem` `nextitem`)と、`<bound method …>` を出すメソッド
// (`cycle` `changed`)は出せない。数値・真偽値のメンバだけを許す。
describe('InertJinjaJudge — loop のメンバ', () => {
  it.each([
    '{{ loop.index }}',
    '{{ loop.index0 }}',
    '{{ loop.revindex }}',
    '{{ loop.revindex0 }}',
    '{{ loop.first }}',
    '{{ loop.last }}',
    '{{ loop.length }}',
    '{{ loop.depth }}',
    '{{ loop.depth0 }}',
  ])('%s は不活性', (src) => {
    expect(inert(src)).toBe(true);
  });

  it.each([
    '{{ loop.previtem }}',
    '{{ loop.nextitem }}',
    '{{ loop.cycle }}',
    '{{ loop.changed }}',
    '{{ loop["nextitem"] }}',
  ])('%s は不活性でない', (src) => {
    expect(inert(src)).toBe(false);
  });

  it('要素が namespace のときの nextitem', () => {
    const doc =
      '{% set ns = namespace(a=1) %}{% for g in [ns, ns] %}{{ loop.nextitem }}{% endfor %}';
    expect(nonInert(doc)).toEqual(['{{ loop.nextitem }}']);
  });

  it('previtem を束ねた名前は、メンバを引いても出せない', () => {
    expect(nonInert('{% set p = loop.previtem %}{{ p.a }}')).toEqual(['{{ p.a }}']);
  });
});

// Jinja の global(`range` などのクラス・関数、`self`)を値として出すと、Python の repr
// (`<class 'range'>`・`<TemplateReference None>` など)になる。
describe('InertJinjaJudge — global を値として出す形', () => {
  it.each([
    '{{ range }}',
    '{{ namespace }}',
    '{{ dict }}',
    '{{ lipsum }}',
    '{{ cycler }}',
    '{{ joiner }}',
    '{{ self }}',
    '{{ range.start }}',
    '{{ self.body }}',
    '{{ [range] }}',
  ])('%s は不活性でない', (src) => {
    expect(inert(src)).toBe(false);
  });

  it('呼び出しは今のとおり不活性', () => {
    expect(inert('{{ range(3) }}')).toBe(true);
    expect(inert('{{ namespace(a=1).a }}')).toBe(true);
  });

  it.each([
    ['global を束ねた名前', '{% set r = range %}{{ r.start }}', '{{ r.start }}'],
    ['self のメンバを束ねた名前', '{% set r = self.body %}{{ r }}', '{{ r }}'],
  ])('%s', (_label, doc, want) => {
    expect(nonInert(doc)).toEqual([want]);
  });
});

// 生成器の直後に同じ連鎖で `|list` か `|length` が続けば、出るのはリストか数なので通す。
describe('InertJinjaJudge — 生成器を list・length で受ける出力', () => {
  it.each([
    '{{ xs|select("defined")|list|length }}',
    '{{ xs|batch(2)|list }}',
    '{{ xs|select("defined")|length }}',
    '{{ xs|slice(2)|list }}',
  ])('%s は不活性', (src) => {
    expect(inert(src)).toBe(true);
  });

  it.each([
    '{{ xs|select("defined")|default(1) }}',
    '{{ xs|select("defined") is defined }}',
    '{{ xs|list|select("defined") }}',
  ])('%s は不活性でない', (src) => {
    expect(inert(src)).toBe(false);
  });

  it('list で受けた束ねは束ねない', () => {
    expect(nonInert('{% set s = xs|select("defined")|list %}{{ s }}')).toEqual([]);
  });

  it('束ねた名前を裸で含むときは外す', () => {
    const doc = '{% set s = namespace() %}{{ xs|select("equalto", s)|list }}';
    expect(nonInert(doc)).toEqual(['{{ xs|select("equalto", s)|list }}']);
  });
});

// `loop` は反復でき、`__iter__` は `(要素, LoopContext)` の組を返す(要素に自分自身を含む)。別名にすると
// メンバの許可リストも効かなくなるので、`loop` を束ねた名前は何を引いても出せない(xs=[1, 2] で
// Python jinja2 はどれも `<LoopContext …>` などを出す)。
describe('InertJinjaJudge — loop を回す・束ねる形', () => {
  it.each([
    [
      'loop を回す',
      '{% for a in xs %}{% for g in loop %}{{ g }}{% endfor %}{% endfor %}',
      ['{{ g }}'],
    ],
    [
      'loop を回して添字で取り出す',
      '{% for a in xs %}{% for g in loop %}{{ g[1] }}{% endfor %}{% endfor %}',
      ['{{ g[1] }}'],
    ],
    [
      'loop を組に分けて回す',
      '{% for a in xs %}{% for i, l in loop %}{{ l }}{% endfor %}{% endfor %}',
      ['{{ l }}'],
    ],
    [
      'loop の別名を回す',
      '{% for a in xs %}{% set m = loop %}{% for g in m %}{{ g }}{% endfor %}{% endfor %}',
      ['{{ g }}'],
    ],
    [
      'loop を list にして回す',
      '{% for a in xs %}{% for g in loop|list %}{{ g }}{% endfor %}{% endfor %}',
      ['{{ g }}'],
    ],
    [
      'loop を list にして束ねる',
      '{% for a in xs %}{% set l = loop|list %}{{ l[0] }}{% endfor %}',
      ['{{ l[0] }}'],
    ],
    [
      'loop の別名のメソッド',
      '{% for a in xs %}{% set outer = loop %}{{ outer.cycle }}{% endfor %}',
      ['{{ outer.cycle }}'],
    ],
    [
      'loop の別名の要素を namespace の属性へ',
      '{% set ns = namespace(a=1) %}{% set o = namespace() %}{% for a in [ns, ns] %}' +
        '{% set outer = loop %}{% set o.x = outer.nextitem %}{{ o.x }}{% endfor %}',
      ['{% set o.x = outer.nextitem %}', '{{ o.x }}'],
    ],
    [
      // 拾いすぎる側: 外側の loop を別名で引く書き方は、数のメンバでも単位になる。
      'loop の別名の数のメンバ',
      '{% for a in xs %}{% set outer = loop %}{{ outer.index }}{% endfor %}',
      ['{{ outer.index }}'],
    ],
  ])('%s', (_label, doc, want) => {
    expect(nonInert(doc)).toEqual(want);
  });
});

describe('InertJinjaJudge — テンプレートの中だけにある global', () => {
  it.each(['{{ super }}', '{{ caller }}', '{{ varargs }}', '{{ kwargs }}', '{{ caller.name }}'])(
    '%s は不活性でない',
    (src) => {
      expect(inert(src)).toBe(false);
    },
  );
});
