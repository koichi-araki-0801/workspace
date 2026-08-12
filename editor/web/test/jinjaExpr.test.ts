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
import { evaluateJinjaExpr, JinjaExprError, stringifyJinjaValue } from '../src/lib/jinjaExpr';

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

describe('evaluateJinjaExpr — 許可リストの外は必ず throw(無言で空にしない)', () => {
  const rejected = [
    'fund.name | upper', // フィルタ
    'arr | length',
    'range(3)', // 関数呼び出し
    'fund.name.toUpperCase()',
    '"a" ~ "b"', // 文字列連結
    'n if t else 0', // インライン if
    'arr is defined', // テスト
    '', // 空
    'n +', // 途中で終わる
    'n n', // 余り
    'fund.', // `.` の後が無い
    '"unterminated', // 閉じない文字列
    'n @ 1', // 未知の文字
    'arr[t]', // 添字が文字列でも数値でもない
    '(n + 1', // 閉じ括弧が無い
    'not', // 単項の右辺が無い
  ];
  for (const expr of rejected) {
    it(JSON.stringify(expr), () => {
      expect(() => evaluateJinjaExpr(expr, ctx)).toThrow(JinjaExprError);
    });
  }
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
  ];
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
