import { describe, expect, it } from 'vitest';
import {
  escapeHtmlFull,
  Filler,
  loopCtx,
  parseForHeader,
  renderDisplay,
  renderPlainFilled,
  takenBranchIndex,
} from '../src/jinja/fillRender';
import { evaluateJinjaExpr, JinjaBudget } from '../src/jinja/jinjaExpr';
import { parseJinja } from '../src/jinja/jinjaTree';
import { findEditingMarkers } from '../src/security/editingMarkers';

const show = (src: string, ctx: Record<string, unknown>, f = new Filler()) => {
  const r = parseJinja(src);
  if (!r.ok) throw new Error(r.error.message);
  return f.finalize(renderDisplay(src, r.nodes, ctx, f));
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

describe('renderDisplay — 本番パーツが使う構文', () => {
  it('safe の付いた値だけはエスケープしない', () => {
    expect(show('<p>{{ h|safe }}|{{ h }}</p>', { h: 'a<br>b' })).toBe('<p>a<br>b|a&lt;br&gt;b</p>');
  });
  it('フィルタ付きの出力・for の対象・if の条件', () => {
    expect(
      show(
        '{% for r in rows|selectattr("on")|list %}{{ r.n|default("-") }};{% endfor %}' +
          '{% if rows|length > 2 %}多{% endif %}',
        { rows: [{ on: 1, n: 'a' }, { on: 0 }, { on: 1 }] },
      ),
    ).toBe('a;-;多');
  });
  it('set は以後の式から引け、if の中の set は if の外へ届く(Jinja と同じ)', () => {
    expect(
      show('{% set y = n * 2 %}{{ y }}{% if t %}{% set y = 1 %}{% endif %}/{{ y }}', {
        n: 7,
        t: true,
      }),
    ).toBe('14/1');
  });
  it('for の中の set は外へ漏れず、namespace の属性への代入はループを越えて残る', () => {
    expect(
      show(
        '{% set ns = namespace(total=0) %}{% for i in xs %}{% set y = i %}' +
          '{% set ns.total = ns.total + i %}{% endfor %}[{{ y }}]{{ ns.total }}',
        { xs: [1, 2, 3] },
      ),
    ).toBe('[]6');
  });
  it('loop.first / index / last / previtem と for a, b in groupby', () => {
    expect(
      show(
        '{% for i in xs %}{% if not loop.first %}{{ loop.previtem }}>{% endif %}' +
          '{{ loop.index }}{% if loop.last %}!{% endif %};{% endfor %}',
        { xs: ['a', 'b'] },
      ),
    ).toBe('1;a>2!;');
    expect(
      show('{% for k, items in rows|groupby("k") %}{{ k }}={{ items|length }};{% endfor %}', {
        rows: [{ k: 'b' }, { k: 'a' }, { k: 'b' }],
      }),
    ).toBe('a=1;b=2;');
  });
  it('range と文字列メソッド', () => {
    expect(
      show(
        '{% for i in range(2) %}{{ i }}{% endfor %}|{% for l in s.splitlines() %}' +
          '{% if l.startswith("※") %}<i>{{ l }}</i>{% endif %}{% endfor %}',
        { s: '※1\n本文\n※2' },
      ),
    ).toBe('01|<i>※1</i><i>※2</i>');
  });
  it('safe の値も、テキストの位置でなければエスケープし、見た目が変われば unsupported に数える', () => {
    const v = '" x="1"> <b>y</b> -->';
    const f = new Filler();
    const out = show(
      `<p title="{{ v|safe }}">t</p><!-- {{ v|safe }} --><title>{{ v|safe }}</title>` +
        `<p title="{{ w|safe }}">u</p>`,
      { v, w: 'plain' },
      f,
    );
    const e = escapeHtmlFull(v);
    expect(out).toBe(`<p title="${e}">t</p><!-- ${e} --><title>${e}</title><p title="plain">u</p>`);
    // エスケープしても変わらない値(`w`)は数えない(エスケープ済みの普通の値と同じ扱い)。
    expect([...f.unsupported]).toEqual(['v|safe']);
  });
  it('置く位置は描き終えた出力で決める(if の枝で引用符が消えても属性値の中ならエスケープする)', () => {
    const src = '<p title="{% if c %}"{% endif %}>{{ v|safe }}</p>';
    const v = '<b>x</b>';
    expect(show(src, { c: false, v })).toBe(`<p title=">${escapeHtmlFull(v)}</p>`);
    expect(show(src, { c: true, v })).toBe(`<p title="">${v}</p>`);
  });
  it('仮置きの印は描画ごとに推測できず、値に書いても本物の値に化けない', () => {
    const forged = '\u{e000}00000000000000000\u{e001}';
    const out = show('<p>{{ a|safe }}{{ b }}</p>', { a: '<b>x</b>', b: forged });
    expect(out).toBe(`<p><b>x</b>${forged}</p>`);
  });
  it('finalize を掛けなければ safe の値は生では入らない', () => {
    const src = '<p>{{ a|safe }}</p>';
    const r = parseJinja(src);
    if (!r.ok) throw new Error();
    expect(renderDisplay(src, r.nodes, { a: '<b>x</b>' }, new Filler())).not.toContain('<b>');
  });
  it.each([
    ['許可していない要素', '<img src=x onerror=alert(1)>'],
    ['閉じタグの余り', 'x</section><p>外'],
    ['コメントで印を作る', '--><!--jinja-rt:c:1:--><!--'],
    ['往復用のチップ', '<span class="jinja-chip jinja-var" data-jinja="e3sgeCB9fQ==">x</span>'],
  ])('テキストの位置でも、それだけで閉じていない safe の値(%s)はエスケープする', (_, v) => {
    const f = new Filler();
    expect(show('<section>{{ v|safe }}</section>', { v }, f)).toBe(
      `<section>${escapeHtmlFull(v)}</section>`,
    );
    expect([...f.unsupported]).toEqual(['v|safe']);
  });
  it('解釈できない set は unsupported に数える', () => {
    const f = new Filler();
    expect(show('{% set a, b = 1, 2 %}{{ a }}', {}, f)).toBe('');
    expect([...f.unsupported]).toEqual(['set a, b = 1, 2']);
  });
  it('繰り返しの総数に上限があり、超えた分は展開せず unsupported に数える', () => {
    const f = new Filler();
    const out = show(
      '{% for a in range(100000) %}{% for b in range(100000) %}x{% endfor %}{% endfor %}',
      {},
      f,
    );
    expect(out.length).toBeLessThanOrEqual(200_000);
    expect(f.unsupported.size).toBe(1);
  });
  it('ループの中で大きな range やフィルタを何度も呼ぶと、評価の量の上限で止まり unsupported になる', () => {
    const f = new Filler();
    show('{% for i in range(1000) %}{{ range(100000)|length }}{% endfor %}', {}, f);
    expect([...f.unsupported]).toEqual([
      'range(100000)|length',
      '描画の量が上限を超えたため、以降を省きました',
    ]);
  });
  it('育てた文字列をループで出し続けると、出力の量の上限で以降を省く(例外にしない)', () => {
    const f = new Filler();
    const out = show(
      '{% set ns = namespace(s="x") %}{% for i in range(19) %}{% set ns.s = ns.s + ns.s %}' +
        '{% endfor %}{% for i in range(50000) %}<i>{{ ns.s }}</i>{% endfor %}',
      {},
      f,
    );
    expect(out.length).toBeLessThan(12_000_000);
    expect(out.endsWith('</i>')).toBe(true); // 繰り返しの単位で止めるので、タグの対応は崩れない
    expect([...f.unsupported]).toEqual(['描画の量が上限を超えたため、以降を省きました']);
  });
  it.each([16, 20])(
    '配列リテラルで同じ値を %i 回倍にしても、出力の上限以下で止まり unsupported になる(例外にしない)',
    (times) => {
      let src = '{% set b0 = range(1000) %}';
      for (let k = 1; k <= times; k++) src += `{% set b${k} = [b${k - 1}, b${k - 1}] %}`;
      src +=
        `<p>{{ b${times} }}</p><p>{{ b${times}|trim }}</p><p>{{ b${times}|safe }}</p>` +
        `{% if b${times} < "x" %}lt{% endif %}{% if "0" in b${times}|list %}{% endif %}` +
        `<p>{{ b${times} + "x" }}</p>`;
      let r: ReturnType<typeof renderPlainFilled> | undefined;
      expect(() => {
        r = renderPlainFilled(src, {});
      }).not.toThrow();
      expect(r?.html.length).toBeLessThan(10_000_000);
      expect(r?.diagnostics.unsupported.length).toBeGreaterThan(0);
    },
  );
  it('select("in", 長い並び)は要素ごとに右辺を数え、評価の量の上限で止まる', () => {
    const expr = 'range(100000)|select("in", range(100000))|list|length';
    const { html, diagnostics } = renderPlainFilled(`{{ ${expr} }}|`.repeat(6), {});
    expect(diagnostics.unsupported).toEqual([expr, '描画の量が上限を超えたため、以降を省きました']);
    expect(html).toBe('||||||');
  });
  describe('比較と式の評価の回数も評価の量に数える', () => {
    // 長さ 2^18 + 1 の別々の文字列 t と u(作る費用は 1 回だけ)。
    const grow =
      '{% set ns = namespace(s="a") %}' +
      '{% for k in range(18) %}{% set ns.s = ns.s + ns.s %}{% endfor %}' +
      '{% set t = "a" + ns.s %}{% set u = "a" + ns.s %}';
    it.each([
      [
        'ループの中の ==',
        '{% for j in range(99000) %}{% if t == u %}{% endif %}{% endfor %}',
        't == u',
      ],
      ['and で並べた ==', `{% if ${Array(10).fill('t == u').join(' and ')} %}{% endif %}`, null],
      ['<', '{% for j in range(99000) %}{% if t < u %}{% endif %}{% endfor %}', 't < u'],
      [
        'equalto',
        '{% for j in range(9000) %}{{ [t]|select("equalto", u)|list|length }}{% endfor %}',
        '[t]|select("equalto", u)|list|length',
      ],
      [
        'in の並びの要素',
        '{% for j in range(9000) %}{{ [t]|select("in", [u])|list|length }}{% endfor %}',
        '[t]|select("in", [u])|list|length',
      ],
    ])('長い文字列同士の比較(%s)は長さを数え、上限で unsupported になる', (_, body, expr) => {
      const f = new Filler();
      show(grow + body, {}, f);
      if (expr) expect([...f.unsupported]).toContain(expr);
      else expect(f.unsupported.size).toBeGreaterThan(0);
      expect(f.exhausted).toBe(true);
    });
    it.each([
      ['添字のキー', '{% for j in range(99000) %}{{ d[t] }}{% endfor %}', 'd[t]'],
      ['文字列の数への変換(算術)', '{% for j in range(99000) %}{{ t - 1 }}{% endfor %}', 't - 1'],
      ['文字列の数への変換(単項)', '{% for j in range(99000) %}{{ -t }}{% endfor %}', '-t'],
      [
        '文字列と数の比較',
        '{% for j in range(99000) %}{% if t < 1 %}{% endif %}{% endfor %}',
        't < 1',
      ],
      [
        'groupby のキーの小文字化と比較',
        '{% set xs = [namespace(k=t), namespace(k=u)] %}' +
          '{% for j in range(9000) %}{{ xs|groupby("k")|length }}{% endfor %}',
        'xs|groupby("k")|length',
      ],
    ])('長い文字列を読む経路(%s)も長さを数え、上限で unsupported になる', (_, body, expr) => {
      const f = new Filler();
      show(grow + body, { d: {} }, f);
      expect([...f.unsupported]).toContain(expr);
      expect(f.exhausted).toBe(true);
    });
    it('繰り返しの費用は文脈のキーの数に依らない(キー 500 個・300 行 × 20 列の入れ子の for を描ける)', () => {
      const ctx: Record<string, unknown> = {};
      for (let k = 0; k < 500; k++) ctx[`k${k}`] = k;
      ctx.rows = Array.from({ length: 300 }, (_, i) =>
        Array.from({ length: 20 }, (_, j) => `${i}-${j}`),
      );
      const f = new Filler();
      const out = show(
        '{% for row in rows %}<tr>{% for c in row %}<td>{{ c }}{{ k499 }}</td>{% endfor %}</tr>{% endfor %}',
        ctx,
        f,
      );
      expect([...f.unsupported]).toEqual([]);
      expect(f.exhausted).toBe(false);
      expect(out.match(/<td>/g)?.length).toBe(6000);
      expect(out.endsWith('<td>299-19499</td></tr>')).toBe(true);
    });
    it('ループの層をたどる名前の参照も prototype には届かない', () => {
      const f = new Filler();
      const names = ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf'];
      const body = names.map((n) => `[{{ ${n} }}][{{ ${n}.constructor }}]`).join('');
      const out = show(
        `{% for x in [1] %}{% for y in [2] %}${body}{% endfor %}{% endfor %}`,
        {},
        f,
      );
      expect(out).toBe('[][]'.repeat(names.length));
      expect([...f.unsupported]).toEqual([]);
      const g = new Filler();
      expect(
        show(
          '{% for x in [1] %}{% set __proto__ = 5 %}{{ __proto__ }}{% endfor %}[{{ __proto__ }}]',
          {},
          g,
        ),
      ).toBe('5[]');
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      expect(Object.getPrototypeOf({})).toBe(Object.prototype);
    });
    it('ループの中の set は外へも次の回へも漏れず、namespace は入れ子の層を通して持ち越す', () => {
      expect(
        show(
          '{% set a = 1 %}{% for x in [1, 2] %}{{ a }}{% set a = x + 10 %}{{ a }}' +
            '{% for y in [0] %}{{ a }}{% set a = 99 %}{% endfor %}{{ a }}{% endfor %}{{ a }}',
          {},
        ),
      ).toBe(['1', '11', '11', '11', '1', '12', '12', '12', '1'].join(''));
      expect(
        show(
          '{% set ns = namespace(t=0) %}{% for r in [1, 2] %}{% for c in [1, 2] %}' +
            '{% set ns.t = ns.t + r * c %}{% endfor %}{% endfor %}{{ ns.t }}',
          {},
        ),
      ).toBe('9');
    });
    it.each([
      ['trim の chars', '{{ "x"|trim(t) }}', '"x"|trim(t)'],
      ['selectattr の属性名', '{{ [1]|selectattr(t)|length }}', '[1]|selectattr(t)|length'],
      ['groupby の属性名', '{{ [1]|groupby(t)|length }}', '[1]|groupby(t)|length'],
      ['select のテスト名', '{{ [1]|select(t)|length }}', '[1]|select(t)|length'],
      ['startswith の引数', '{{ "a".startswith(t) }}', '"a".startswith(t)'],
      ['添字のキー', '{{ d[t] }}', 'd[t]'],
    ])(
      '文字列の引数が長すぎる形(%s)は、課金より先に形で止めて unsupported にする',
      (_, body, expr) => {
        const f = new Filler();
        show(`${grow}${body}`, { d: {} }, f);
        expect([...f.unsupported]).toEqual([expr]);
        expect(f.exhausted).toBe(false);
      },
    );
    it('属性名の段が多すぎる形は unsupported にする(段 16 までは読む)', () => {
      const f = new Filler();
      const deep16 = Array(16).fill('a').join('.');
      const deep17 = Array(17).fill('a').join('.');
      show(
        `{{ xs|selectattr("${deep16}")|length }}{{ xs|selectattr("${deep17}")|length }}`,
        { xs: [] },
        f,
      );
      expect([...f.unsupported]).toEqual([`xs|selectattr("${deep17}")|length`]);
    });
    it('for の変数が多すぎる見出しは unsupported にし、見出しは 1 回だけ解析する', () => {
      const vars = Array.from({ length: 20000 }, (_, i) => `v${i}`).join(',');
      const f = new Filler();
      show(`{% for j in range(1000) %}{% for ${vars} in [0] %}x{% endfor %}{% endfor %}`, {}, f);
      expect([...f.unsupported]).toEqual([`for ${vars} in [0]`]);
      const ok = Array.from({ length: 16 }, (_, i) => `v${i}`).join(', ');
      expect(show(`{% for ${ok} in [[1]] %}{{ v0 }}{% endfor %}`, {})).toBe('1');
    });
    it('namespace の倍化を何度も数えさせても、たどった量を払って上限で止まる', () => {
      let src = '{% set n0 = namespace(a=1) %}';
      for (let i = 1; i <= 17; i++) src += `{% set n${i} = namespace(a=n${i - 1}, b=n${i - 1}) %}`;
      src += '{% for j in range(600) %}{{ [n17,n17,n17,n17,n17,n17,n17,n17]|length }}{% endfor %}';
      const f = new Filler();
      show(src, {}, f);
      expect([...f.unsupported]).toContain('[n17,n17,n17,n17,n17,n17,n17,n17]|length');
      expect(f.exhausted).toBe(true);
    });
    it('ctx の深い dict を並びに入れ続けても、たどった量を払って上限で止まる', () => {
      let o: unknown = 1;
      for (let i = 0; i < 21; i++) o = { a: o, b: o };
      const f = new Filler();
      show('{% for j in range(100) %}{{ [o]|length }}{% endfor %}', { o }, f);
      expect([...f.unsupported]).toContain('[o]|length');
      expect(f.exhausted).toBe(true);
    });
    it('評価の量を使い切った後の出力とループは、省いた旨を unsupported に 1 回載せる', () => {
      const { html, diagnostics } = renderPlainFilled(
        '{% set x = range(100000)|select("in", range(100000))|list %}' +
          '<p>A{{ v }}</p>{% for r in rows %}<td>{{ r }}</td>{% endfor %}',
        { v: 'VAL', rows: [1, 2, 3] },
      );
      expect(html).toBe('<p>A</p>');
      expect(diagnostics.unsupported).toEqual([
        'set x = range(100000)|select("in", range(100000))|list',
        '描画の量が上限を超えたため、以降を省きました',
      ]);
    });
    it('何も出力しない式をループで何度も評価させても、評価の量の上限で止まる', () => {
      const f = new Filler();
      const body = '{% if 1 == 2 %}{% endif %}'.repeat(100);
      show(`{% for j in range(100000) %}${body}{% endfor %}`, {}, f);
      expect([...f.unsupported]).toContain('1 == 2');
      expect(f.exhausted).toBe(true);
    });
  });
  it('倍化の途中で上限に当たった set は unsupported に数え、以後の値は空になる', () => {
    const f = new Filler();
    let src = '{% set b0 = range(1000) %}';
    for (let k = 1; k <= 12; k++) src += `{% set b${k} = [b${k - 1}, b${k - 1}] %}`;
    show(`${src}[{{ b12|length }}]`, {}, f);
    expect([...f.unsupported].some((e) => e.startsWith('set b'))).toBe(true);
  });
  it.each(['xs|batch(100000000, 0)', 'xs|slice(100000000)', 'xs|batch(-1)', 'xs|slice(0)'])(
    '%s(作る配列が引数で決まる)は上限・下限で unsupported になる',
    (expr) => {
      const f = new Filler();
      expect(show(`{{ ${expr} }}`, { xs: [1] }, f)).toBe('');
      expect([...f.unsupported]).toEqual([expr]);
    },
  );
  it.each(['[1]|batch(100000, r)|length', '[1]|slice(100000, r)|length'])(
    '%s(覚え書き済みの大きな並びで埋める)は 1 回で評価の量を使い切り、以後を描かない',
    (expr) => {
      const f = new Filler();
      const out = show(
        `{% set r = range(100000) %}{% for j in range(99000) %}{{ ${expr} }}{{ v }}{% endfor %}`,
        { v: 'V' },
        f,
      );
      expect(out).toBe('');
      expect([...f.unsupported]).toEqual([expr, '描画の量が上限を超えたため、以降を省きました']);
      expect(f.exhausted).toBe(true);
    },
  );
  it.each([
    // [式, 作る前に数える量(行・列の数 + 埋める数)]
    ['xs|batch(1000, 0)', 1 + 999],
    ['xs|batch(1000)', 1],
    ['xs|slice(1000, 0)', 1000 + 999],
    ['xs|slice(1000)', 1000],
  ])('%s は作る量を評価の量に数える', (expr, made) => {
    const b = new JinjaBudget();
    const before = b.remaining;
    evaluateJinjaExpr(expr, { xs: [1] }, b);
    // 基本の費用 + 入力の大きさ + 作る前の量 + 結果の入れ子の大きさ。
    const result = evaluateJinjaExpr(expr, { xs: [1] }) as unknown[][];
    const deep = 1 + result.reduce((n, row) => n + 1 + row.length, 0);
    expect(before - b.remaining).toBe(1 + expr.length + 1 + 1 + made + deep);
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
  it('loopCtx は元の ctx を変えず、変数と loop だけを持つ層を作る(外側の名前は層をたどって引く)', () => {
    const base = { a: 1 };
    const c = loopCtx(base, ['k', 'v'], [['x', 9]], 0);
    expect(Object.keys(c)).toEqual(['k', 'v', 'loop']);
    expect(evaluateJinjaExpr('[a, k, v]', c)).toEqual([1, 'x', 9]);
    expect(c.loop).toStrictEqual({
      index: 1,
      index0: 0,
      first: true,
      last: true,
      length: 1,
      previtem: undefined,
    });
    expect(loopCtx(base, ['i'], ['p', 'q'], 1).loop).toMatchObject({ previtem: 'p' });
    expect(base).toEqual({ a: 1 });
  });
  it('loopCtx のループ変数が `__proto__` でも prototype を差し替えない', () => {
    const c = loopCtx({}, ['__proto__'], [{ polluted: 1 }], 0);
    expect(Object.hasOwn(c, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(c)).toBeNull();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
  it('escapeHtmlFull', () => {
    expect(escapeHtmlFull(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
  });
});

describe('renderPlainFilled', () => {
  it('文書全体を値にし、印も Jinja も残さない(属性・head を含む)', () => {
    const raw =
      '<!doctype html><html><head><title>{{ fund.name }}</title></head><body>' +
      '<table><tbody>{% for h in hs %}<tr data-rank="{{ loop.index }}"><td>{{ h }}</td></tr>{% endfor %}</tbody></table>' +
      '{% if a %}<p>A</p>{% elif b %}<p>B</p>{% endif %}</body></html>';
    const { html } = renderPlainFilled(raw, {
      fund: { name: '日本株' },
      hs: ['甲', '乙'],
      a: false,
      b: true,
    });
    expect(html).toContain('<title>日本株</title>');
    expect(html).toContain('<tr data-rank="1"><td>甲</td></tr><tr data-rank="2"><td>乙</td></tr>');
    expect(html).toContain('<p>B</p>');
    expect(html).not.toMatch(/\{\{|\{%|\{#/);
    expect(findEditingMarkers(html)).toEqual([]);
  });
  it('set は渡した値の object を書き換えない', () => {
    const sample = { n: 1 };
    expect(renderPlainFilled('{% set n = 2 %}{% set m = 3 %}{{ n }}', sample).html).toBe('2');
    expect(sample).toEqual({ n: 1 });
  });
  it('字句エラーは投げる', () => {
    expect(() => renderPlainFilled('<p>{{ a </p>', {})).toThrow();
  });
});

describe('renderPlainFilled の budget の共有', () => {
  const heavy = '{% for i in range(100000) %}{{ i }}{% endfor %}';

  it('budget を渡すと、複数の描画で評価の量を引き合い、使い切った描画は上限の印を残す', () => {
    const budget = new JinjaBudget();
    let last: ReturnType<typeof renderPlainFilled> | undefined;
    for (let k = 0; k < 20 && !budget.exhausted; k++)
      last = renderPlainFilled(heavy, {}, { budget });
    expect(budget.exhausted).toBe(true);
    expect(last?.diagnostics.unsupported.join()).toContain('上限');
  });

  it('渡さなければ描画ごとに別の budget で、同じ描画を繰り返しても上限に届かない', () => {
    for (let k = 0; k < 3; k++)
      expect(renderPlainFilled(heavy, {}).diagnostics.unsupported).toEqual([]);
  });
});
