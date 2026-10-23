// =============================================================================
// jinjaExpr.test.ts — 許可リスト評価器の意味を固定する
// =============================================================================
// `fillJinja` から `nunjucks.compile`(= `new Function`)を外し、全域 CSP から
// `'unsafe-eval'` を落とすための置き換え。nunjucks 版との出力一致は開発時に使い捨ての
// 差分スクリプトで確認済み(実テンプレ 13 x サンプル 22 = 286 組が byte 一致)だが、
// **恒久の保証はここ**で、式の形ごとに期待値を固定する。
//
// 併せて、nunjucks と**意図的に異なる**点(own property のみを引く = prototype 経由の
// `constructor` へ届かない)もここで固定する。緩めた瞬間に落ちる。
import { describe, expect, it } from 'vitest';
import {
  assignJinjaSet,
  evaluateJinjaExpr,
  isJinjaSafe,
  JinjaExprError,
  stringifyJinjaValue,
} from '../src/jinja/jinjaExpr';

const ctx = {
  fund: { name: '日本株式オープン', nav: '12,345', navChange: 58 },
  obj: { a: { b: { c: 'deep' } } },
  holdings: [{ name: 'A' }, { name: 'B' }],
  arr: [1, 2, 3],
  n: 7,
  zero: 0,
  s: 'abc',
  t: true,
  fal: false,
  nul: null,
  名前: '和名',
  crlf: 'a\r\nb\r\rc\n',
};

describe('evaluateJinjaExpr — 実テンプレに現れる形', () => {
  const cases: ReadonlyArray<readonly [string, unknown]> = [
    ['fund.name', '日本株式オープン'],
    ['fund.navChange', 58],
    ['obj.a.b.c', 'deep'],
    ['名前', '和名'],
    // 未定義は throw ではなく undefined(nunjucks の `throwOnUndefined: false` 相当)。
    ['missing', undefined],
    ['fund.missing', undefined],
    ['missing.deep.deeper', undefined],
  ];
  for (const [expr, want] of cases) {
    it(expr, () => expect(evaluateJinjaExpr(expr, ctx)).toEqual(want));
  }
});

describe('evaluateJinjaExpr — リテラル・演算子(nunjucks が吐く JS と同じ意味)', () => {
  const cases: ReadonlyArray<readonly [string, unknown]> = [
    ['1', 1],
    ['1.5', 1.5],
    ['"x"', 'x'],
    ["'y'", 'y'],
    ['true', true],
    ['True', true],
    ['false', false],
    ['none', null],
    ['n + 1', 8],
    ['n - 1', 6],
    ['n * 2', 14],
    ['n / 2', 3.5],
    ['n // 2', 3], // nunjucks の `compileFloorDiv` = `Math.floor(a / b)`
    ['n % 2', 1],
    ['n ** 2', 49],
    ['-n', -7],
    ['(n + 1) * 2', 16],
    ['n > 3', true],
    ['n >= 7', true],
    ['n < 3', false],
    ['n <= 7', true],
    ['zero < n < 100', true], // 比較の連鎖も nunjucks と同じ左結合
    ['+n', 7],
    ['"a\\nb"', 'a\nb'],
    ['"a\\tb"', 'a\tb'],
    ["'it\\'s'", "it's"],
    ['"a\\\\b"', 'a\\b'],
    ['n == 7', true],
    ['n != 7', false],
    ['fund.navChange >= 0', true],
    ['s == "abc"', true],
    ['not t', false],
    // `and` / `or` は nunjucks も `&&` / `||` を素で吐く(真偽値化しない)。
    ['t and n', 7],
    ['fal or "d"', 'd'],
    ['arr[0]', 1],
    ['arr[n - 7]', 1],
    ['obj["a"]["b"]["c"]', 'deep'],
    ['s.length', 3],
  ];
  for (const [expr, want] of cases) {
    it(expr, () => expect(evaluateJinjaExpr(expr, ctx)).toEqual(want));
  }
});

const rows = [
  { k: 'b', v: 1 },
  { k: 'a', v: 2 },
  { k: 'B', v: 3 },
];

describe('evaluateJinjaExpr — 許可リストのフィルタ', () => {
  const cases: ReadonlyArray<readonly [string, unknown]> = [
    ['missing|default("-")', '-'],
    ['s|default("-")', 'abc'],
    ['nul|default("-")', null], // `none` は「定義済み」なので既定値にしない(Jinja と同じ)
    ['missing|default', ''],
    ['zero|default(1, true)', 1], // boolean モードは偽の値も置き換える
    ['zero|default(1, boolean=true)', 1],
    ['"42"|int', 42],
    ['" 42 "|int', 42],
    ['"3.7"|int', 3],
    ['"1e3"|int', 1000],
    ['"x"|int', 0],
    ['"x"|int(5)', 5],
    ['""|int', 0],
    ['1.9|int', 1],
    ['-1.9|int', -1], // `-` は単項でフィルタより先に掛かる(Jinja の parse_unary と同じ)
    ['missing|int', 0],
    ['arr|length', 3],
    ['s|length', 3],
    ['missing|length', 0],
    ['obj|length', 1],
    ['arr|length + 1', 4], // フィルタは算術より強く結合する
    ['arr|length > 2', true],
    ['s|list', ['a', 'b', 'c']],
    ['arr|list', [1, 2, 3]],
    ['obj|list', ['a']],
    ['"  a b 　"|trim', 'a b'],
    ['"xxaxx"|trim("x")', 'a'],
    ['missing|trim', ''],
    ['[1, 2, 3, 4, 5]|batch(2)', [[1, 2], [3, 4], [5]]],
    [
      '[1, 2, 3, 4, 5]|batch(2, 0)',
      [
        [1, 2],
        [3, 4],
        [5, 0],
      ],
    ],
    [
      '[1, 2, 3, 4, 5]|slice(2)',
      [
        [1, 2, 3],
        [4, 5],
      ],
    ],
    [
      '[1, 2, 3, 4, 5]|slice(3, 0)',
      [
        [1, 2],
        [3, 4],
        [5, 0],
      ],
    ],
    ['arr|select("in", [1, 3])|list', [1, 3]],
    ['arr|reject("equalto", 2)|list', [1, 3]],
    ['[0, 1, ""]|select|list', [1]],
    ['holdings|selectattr("name", "equalto", "B")|list', [{ name: 'B' }]],
    ['holdings|selectattr("name")|list', [{ name: 'A' }, { name: 'B' }]],
    ['holdings|selectattr("name", "in", ["A"])|list', [{ name: 'A' }]],
  ];
  for (const [expr, want] of cases) {
    it(expr, () => expect(evaluateJinjaExpr(expr, ctx)).toEqual(want));
  }

  it('groupby は属性で並べ替えて束ね(大小文字を区別しない)、grouper / list と 2 要素で引ける', () => {
    const g = evaluateJinjaExpr('rows|groupby("k")', { rows }) as unknown[][];
    expect(g.map((x) => [x[0], x[1]])).toEqual([
      ['a', [{ k: 'a', v: 2 }]],
      [
        'b',
        [
          { k: 'b', v: 1 },
          { k: 'B', v: 3 },
        ],
      ],
    ]);
    expect(evaluateJinjaExpr('(rows|groupby("k"))[1].grouper', { rows })).toBe('b');
    expect(evaluateJinjaExpr('(rows|groupby("k"))[0].list|length', { rows })).toBe(1);
    expect(evaluateJinjaExpr('rows|groupby("v")|length', { rows })).toBe(3);
  });

  it('safe は値を「エスケープしない」印付きにし、文字列化すると元の HTML', () => {
    const v = evaluateJinjaExpr('h|safe', { h: 'a<br>b' });
    expect(isJinjaSafe(v)).toBe(true);
    expect(stringifyJinjaValue(v)).toBe('a<br>b');
    expect(isJinjaSafe(evaluateJinjaExpr('h', { h: 'a<br>b' }))).toBe(false);
    expect(isJinjaSafe(evaluateJinjaExpr('h|safe|trim', { h: ' <b> ' }))).toBe(true);
    expect(evaluateJinjaExpr('h|safe|length', { h: '<b>' })).toBe(3);
  });
});

describe('evaluateJinjaExpr — テスト・関数・文字列メソッド・リスト', () => {
  const cases: ReadonlyArray<readonly [string, unknown]> = [
    ['missing is defined', false],
    ['n is defined', true],
    ['nul is defined', true],
    ['missing is not defined', true],
    ['not missing is defined', true],
    ['fund.missing is defined', false],
    ['range(3)', [0, 1, 2]],
    ['range(1, 4)', [1, 2, 3]],
    ['range(0, 10, 3)', [0, 3, 6, 9]],
    ['range(3, 0, -1)', [3, 2, 1]],
    ['range(0)', []],
    ['namespace(a=1, b="x").b', 'x'],
    ['"a\\nb\\n".splitlines()', ['a', 'b']],
    ['crlf.splitlines()', ['a', 'b', '', 'c']],
    ['"".splitlines()', []],
    ['s.startswith("ab")', true],
    ['s.startswith("b")', false],
    ['[]', []],
    ['[n, s]', [7, 'abc']],
    // 短絡評価: 評価しない側はメソッド・フィルタを実行しない(Jinja と同じく例外にならない)。
    ['missing is defined and missing.startswith("a")', false],
    ['t or missing.splitlines()', true],
    ['fal and arr[missing]', false],
  ];
  for (const [expr, want] of cases) {
    it(expr, () => expect(evaluateJinjaExpr(expr, ctx)).toEqual(want));
  }

  it('namespace は prototype を差し替えられない(`__proto__` もただのキー)', () => {
    const ns = evaluateJinjaExpr('namespace(__proto__=holdings)', ctx) as object;
    expect(Object.getPrototypeOf(ns)).toBe(Object.prototype);
    expect(evaluateJinjaExpr('namespace(__proto__=1).length', ctx)).toBeUndefined();
  });
});

describe('assignJinjaSet — set の代入と namespace の属性への代入', () => {
  it('名前へ代入し、以後の式から引ける', () => {
    const c: Record<string, unknown> = { n: 7 };
    assignJinjaSet('x = n + 1', c);
    expect(c.x).toBe(8);
    assignJinjaSet('x = x * 2', c);
    expect(evaluateJinjaExpr('x', c)).toBe(16);
  });
  it('namespace の属性へ代入できる(namespace 以外の object へは代入しない)', () => {
    const c: Record<string, unknown> = {};
    assignJinjaSet('ns = namespace(total=0)', c);
    assignJinjaSet('ns.total = ns.total + 5', c);
    expect(evaluateJinjaExpr('ns.total', c)).toBe(5);
    const data: Record<string, unknown> = { fund: { name: 'x' } };
    expect(() => assignJinjaSet('fund.name = "y"', data)).toThrow(JinjaExprError);
    expect(data.fund).toEqual({ name: 'x' });
  });
  it('`__proto__` へ代入しても prototype は変わらない', () => {
    const c: Record<string, unknown> = {};
    assignJinjaSet('__proto__ = namespace(a=1)', c);
    expect(Object.getPrototypeOf(c)).toBe(Object.prototype);
    assignJinjaSet('ns = namespace()', c);
    assignJinjaSet('ns.__proto__ = namespace(a=1)', c);
    expect(Object.getPrototypeOf(c.ns)).toBe(Object.prototype);
    expect(evaluateJinjaExpr('ns.a', c)).toBeUndefined();
  });
  it.each([
    'a, b = 1, 2', // 複数の代入
    'x', // ブロックの代入(本文側で opaque として扱う形)
    'x == 1',
    'true = 1', // リテラルの綴り
    '1 = 1',
    'x.y.z = 1',
    'missing.x = 1', // 代入先が無い
    'x = ', // 右辺が無い
    'x = range.constructor("return 1")()', // 右辺も許可リストの評価器を通る
    'x = s|attr("constructor")',
  ])('%s', (src) => {
    expect(() => assignJinjaSet(src, { s: 'a' })).toThrow(JinjaExprError);
  });
  it('右辺で prototype の値を引いても関数は入らない', () => {
    const c: Record<string, unknown> = {};
    assignJinjaSet('x = range.constructor', c);
    expect(c.x).toBeUndefined();
  });
});

describe('evaluateJinjaExpr — 許可リストの外は必ず throw(無言で空にしない)', () => {
  const rejected = [
    'fund.name | upper', // フィルタ
    'arr | join(",")',
    's|attr("__proto__")', // 一覧に無いフィルタ(Jinja で属性へ届く入口)
    's|attr("constructor")',
    'arr|map("constructor")',
    's|format(1)',
    'arr|constructor', // prototype の名前もフィルタ名としては引かない
    'arr|toString',
    'arr|__proto__',
    'arr|length.constructor', // フィルタ名に `.` は続けられない
    'arr|length(1)', // 引数の数が合わない
    'arr|default(1, true, 3)',
    'arr|default(foo=1)', // 知らないキーワード引数
    'arr|batch(0)', // 0 個ずつは無限に分けられない
    'arr|batch(1.5)',
    'arr|slice(0)',
    'n|length', // 長さの無い型
    'n|list',
    'arr|select("callable")|list', // 一覧に無いテスト
    'arr|select("constructor")|list',
    'arr|select("__proto__")|list',
    'holdings|selectattr("name", "sameas", "A")|list',
    'arr is callable',
    'arr is constructor',
    'arr is equalto 3', // 括弧なしの引数は解釈しない
    'arr|select("in", n)|list', // `in` の右辺が入れ物でない
    'rows|groupby("k")', // 型の混ざった並べ替え(下の ctx の rows は k を持たない)
    'range(3)()',
    'range(100001)', // 長すぎる range
    'range(1, 2, 0)',
    'range("3")',
    'range(1.5)',
    'range.constructor("return 1")()',
    'namespace(1)', // 位置引数
    'namespace.constructor("return 1")()',
    'cycler(1)', // 一覧に無い関数
    'lipsum()',
    'dict(a=1)',
    'fund.name.toUpperCase()', // 一覧に無いメソッド
    's.constructor("return 1")()',
    's.splitlines.constructor("return 1")()',
    's.startswith()', // 引数の数が合わない
    's.startswith(1)',
    's.startswith("a", 1)',
    's.startswith(x="a")',
    'arr.startswith("a")', // 文字列以外のメソッドは呼ばない
    'missing.splitlines()',
    'holdings[0].startswith("a")',
    '"a" ~ "b"', // 文字列連結
    'n if t else 0', // インライン if
    'x = 1', // 式の中の代入
    'n in arr', // `in` 演算子は足していない
    '', // 空
    'n +', // 途中で終わる
    'n n', // 余り
    'fund.', // `.` の後が無い
    '"unterminated', // 閉じない文字列
    'n @ 1', // 未知の文字
    'arr[t]', // 添字が文字列でも数値でもない
    '(n + 1', // 閉じ括弧が無い
    'not', // 単項の右辺が無い
    '[1, 2', // 閉じないリスト
    'arr|', // フィルタ名が無い
    'arr is', // テスト名が無い
  ];
  for (const expr of rejected) {
    it(JSON.stringify(expr), () => {
      const c = expr.startsWith('rows|') ? { rows: [{ k: 'a' }, { k: 1 }] } : ctx;
      expect(() => evaluateJinjaExpr(expr, c)).toThrow(JinjaExprError);
    });
  }

  it('文字列を伸ばし続ける加算は上限で止まる', () => {
    const c: Record<string, unknown> = { s: 'x'.repeat(600_000) };
    expect(() => evaluateJinjaExpr('s + s', c)).toThrow(JinjaExprError);
  });
});

describe('evaluateJinjaExpr — prototype には届かない(nunjucks との意図的な差)', () => {
  // nunjucks の `contextOrFrameLookup` / `memberLookup` は素の `obj[key]` で、
  // `{{ range.constructor("…")() }}` が `new Function` へ到達する経路そのものになる。
  // ここでは own property だけを引くので、呼び出し構文を封じる前に値が取れない。
  const cases = [
    'constructor',
    's.constructor',
    'obj.__proto__',
    'obj.toString',
    'obj.hasOwnProperty',
    'range', // 関数の名前は呼び出しの形でだけ使え、値としては引けない
    'namespace',
    'namespace.constructor',
    'range.constructor',
    's.startswith', // メソッドも呼び出しの形でだけ使える
    's.splitlines.constructor',
    '(s|safe).constructor',
    '(s|safe).html',
    'namespace(a=1).constructor',
    'namespace(a=1).__proto__',
    '(arr|batch(2)).constructor',
    '(holdings|groupby("name"))[0].constructor',
  ];
  for (const expr of cases) {
    it(expr, () => expect(evaluateJinjaExpr(expr, ctx)).toBeUndefined());
  }

  it('属性名で引くフィルタも own property だけを見る', () => {
    expect(evaluateJinjaExpr('holdings|selectattr("__proto__")|list', ctx)).toEqual([]);
    expect(evaluateJinjaExpr('holdings|selectattr("constructor")|list', ctx)).toEqual([]);
    expect(evaluateJinjaExpr('holdings|selectattr("name.constructor")|list', ctx)).toEqual([]);
    const g = evaluateJinjaExpr('holdings|groupby("constructor", default="z")', ctx) as unknown[][];
    expect(g.map((x) => x[0])).toEqual(['z']);
  });
  for (const expr of cases) {
    it(expr, () => expect(evaluateJinjaExpr(expr, ctx)).toBeUndefined());
  }

  it('コンテキストが関数を持っていても値として返さない', () => {
    expect(evaluateJinjaExpr('f', { f: () => 'x' })).toBeUndefined();
  });
});

describe('stringifyJinjaValue — nunjucks の suppressValue(autoescape 無効)と同じ', () => {
  it.each([
    [undefined, ''],
    [null, ''],
    ['abc', 'abc'],
    [0, '0'],
    [1.5, '1.5'],
    [true, 'true'],
    [false, 'false'],
  ])('%s -> %s', (v, want) => expect(stringifyJinjaValue(v)).toBe(want));

  it('配列・オブジェクトは JS の文字列連結と同じ', () => {
    expect(stringifyJinjaValue([1, 2, 3])).toBe('1,2,3');
    expect(stringifyJinjaValue({ a: 1 })).toBe('[object Object]');
  });
});
