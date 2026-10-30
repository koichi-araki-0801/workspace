// =============================================================================
// revealExpr.test.ts — 承認画面の描画(reveal)の値の出力を、本番の Python Jinja2 の出力に合わせる
// =============================================================================
// 期待値は Python Jinja2 3.1.6(autoescape 無し)で一度だけ描いて固定した(CI では Python を動かさない)。
// 生成: scratchpad の `pytable.py`。`<method>` は Python がメソッドの repr(アドレス付き)を出した行。
// reveal は、値で描くなら Python と同じ文字を出し、合わせられない形は原文で出す(`source`)。
import { describe, expect, it } from 'vitest';
import { JinjaBudget } from '../src/jinja/jinjaExpr';
import { parseRevealPath, revealOutput } from '../src/jinja/revealExpr';

const DATA = {
  fund: {
    name: 'F ファンド',
    list: [1, 2],
    obj: { a: 1, b: 'x' },
    nul: null,
    flag: false,
    t: true,
    num: 0,
    flt: 1.5,
    empty: '',
    sp: '  a b  ',
    q: "it's",
    dq: 'say "hi"',
    both: 'a\'b"c',
    bs: 'a\\b',
    mixed: [true, null, 'x', 1.5, { k: [1] }],
    items: 'キーの items',
    nested: { deep: { v: '深い' } },
    html: '<b>太字</b>',
    ws: '　全角',
    ilist: ['　x'],
    lower: 'AbC',
  },
  rows: [{ n: '一' }, { n: '二' }],
};

/** [式, Python の出力]。 */
const PY: readonly (readonly [string, string])[] = [
  ['fund.name', 'F ファンド'],
  ['fund.list', '[1, 2]'],
  ['fund.obj', "{'a': 1, 'b': 'x'}"],
  ['fund.nul', 'None'],
  ['fund.flag', 'False'],
  ['fund.t', 'True'],
  ['fund.num', '0'],
  ['fund.flt', '1.5'],
  ['fund.empty', ''],
  ['fund.missing', ''],
  ['fund.mixed', "[True, None, 'x', 1.5, {'k': [1]}]"],
  ['fund.q', "it's"],
  ['fund.dq', 'say "hi"'],
  ['fund.both', 'a\'b"c'],
  ['fund.bs', 'a\\b'],
  ['fund.nested.deep.v', '深い'],
  ["fund['name']", 'F ファンド'],
  ['fund["obj"]["b"]', 'x'],
  ['fund.list[0]', '1'],
  ['fund.list.1', '2'],
  ['fund.list[5]', ''],
  ['fund.obj[0]', ''],
  ['fund.name.length', ''],
  ['fund.list.length', ''],
  ['fund.name["length"]', ''],
  ["fund.list['length']", ''],
  ['fund.nul.x', ''],
  ['rows[1].n', '二'],
  ['fund.items', '<method>'],
  ["fund['items']", 'キーの items'],
  ['fund.sp|trim', 'a b'],
  ['fund.lower|upper', 'ABC'],
  ['fund.lower|lower', 'abc'],
  ['fund.name|safe', 'F ファンド'],
  ['fund.missing|default', ''],
  ['fund.nul|default', 'None'],
  ['fund.flag|upper', 'FALSE'],
  ['fund.list|upper', '[1, 2]'],
  ['fund.html|safe', '<b>太字</b>'],
  ['fund.html', '<b>太字</b>'],
  ['fund.obj|trim', "{'a': 1, 'b': 'x'}"],
  ['fund.name.upper', '<method>'],
  ['fund.list.append', '<method>'],
  ['fund.obj.items', '<method>'],
  ['fund.name[0]', 'F'],
  ['fund.list[-1]', '2'],
  ['fund.missing.x', 'ERR UndefinedError'],
  ['fund.missing|default("本番だけ")', '本番だけ'],
  ['fund.nul|default("本番だけ")', 'None'],
  ['fund.ws', '　全角'],
  ['fund.ilist', "['\\u3000x']"],
  ['[] or "本番だけ"', '本番だけ'],
  ['{} or "本番だけ"', '本番だけ'],
  ['"" or "本番だけ"', '本番だけ'],
  ['0.0 or "本番だけ"', '本番だけ'],
  ['1.0', '1.0'],
  ['3 / 1', '3.0'],
  ['true', 'True'],
  ['none', 'None'],
  ['"𠮷"|length', '1'],
  ['["承認", "本番だけ"][-1]', '本番だけ'],
  ['[1, 2]|length > 1 and "本番だけ"', '本番だけ'],
  ['2.5|round', '2.0'],
  ['"ab"|title', 'Ab'],
  ['["b", "A"]|sort|first', 'A'],
  ['"a" * 3', 'aaa'],
  ['range(2)|list', '[0, 1]'],
  ['fund.list|length', '2'],
  ['fund.list|list', '[1, 2]'],
  ['fund.name ~ "x"', 'F ファンドx'],
  ['fund.num + 1', '1'],
  ['fund.name|replace("F", "G")', 'G ファンド'],
];

/** 値で描く(原文に倒さない)ことを固定する式。 */
const MUST_VALUE: ReadonlySet<string> = new Set([
  'fund.name',
  'fund.list',
  'fund.obj',
  'fund.nul',
  'fund.flag',
  'fund.t',
  'fund.num',
  'fund.flt',
  'fund.empty',
  'fund.missing',
  'fund.mixed',
  'fund.q',
  'fund.dq',
  'fund.both',
  'fund.bs',
  'fund.nested.deep.v',
  "fund['name']",
  'fund["obj"]["b"]',
  'fund.list[0]',
  'fund.list.1',
  'fund.list[5]',
  'fund.obj[0]',
  'fund.name.length',
  'fund.list.length',
  'fund.name["length"]',
  "fund.list['length']",
  'fund.nul.x',
  'rows[1].n',
  "fund['items']",
  'fund.sp|trim',
  'fund.lower|upper',
  'fund.lower|lower',
  'fund.name|safe',
  'fund.missing|default',
  'fund.nul|default',
  'fund.flag|upper',
  'fund.list|upper',
  'fund.html|safe',
  'fund.html',
  'fund.obj|trim',
]);

const out = (src: string) => revealOutput(src, DATA, new JinjaBudget());

describe('revealOutput — Python Jinja2 の出力に合わせる', () => {
  it.each(PY)('%s', (src, py) => {
    const r = out(src);
    if (MUST_VALUE.has(src)) expect(r.kind, src).toBe('value');
    if (r.kind === 'value') expect(r.text).toBe(py);
    // Python がメソッドの repr・エラーを出す形は、値で描かない。
    if (py === '<method>' || py.startsWith('ERR ')) expect(r.kind).toBe('source');
  });

  it('|safe の印を返し、未定義を missing に数える', () => {
    expect(out('fund.html|safe')).toMatchObject({ kind: 'value', safe: true });
    expect(out('fund.html')).toMatchObject({ kind: 'value', safe: false });
    expect(out('fund.missing')).toMatchObject({ kind: 'value', missing: true, text: '' });
    expect(out('fund.nul')).toMatchObject({ kind: 'value', missing: false, text: 'None' });
  });
});

describe('parseRevealPath', () => {
  it.each([
    ['fund.name', { root: 'fund', filters: [] }],
    [' fund . list [ 0 ] | trim ( ) ', { root: 'fund', filters: ['trim'] }],
  ])('%s を読む', (src, want) => {
    expect(parseRevealPath(src)).toMatchObject(want);
  });
  it.each([
    'true',
    'none',
    '1',
    '"x"',
    'a or b',
    'a + 1',
    'a|default("x")',
    'a|replace("a", "b")',
    'a|length',
    'a[-1]',
    'a["x\\"y"]',
    'a[b]',
    'a.',
    'a[0',
    'a|',
    'a(1)',
    'a.99999999999',
  ])('%s は値で描かない', (src) => {
    expect(parseRevealPath(src)).toBeNull();
  });
});

/**
 * Python と綴りが違うと分かっていて許容する端の値(`revealExpr.ts` の冒頭の注記)。[式, 値, reveal の出力,
 * Python の出力]。Python の出力は Jinja2 3.1.6 で描いた値。表の外へ広げるときは、ここに足して確かめる。
 */
const EDGE: readonly (readonly [string, Record<string, unknown>, string, string])[] = [
  // 大文字・小文字・空白の Unicode の扱いが同じもの
  ['s|upper', { s: 'ß' }, 'SS', 'SS'],
  ['s|lower', { s: 'İ' }, 'i̇', 'i̇'],
  // 違うもの(許容する)
  ['s|trim', { s: '\u0085a\u0085' }, '\u0085a\u0085', 'a'],
  ['s|trim', { s: '\uFEFFa\uFEFF' }, 'a', '\uFEFFa\uFEFF'],
  // 値のデータは JSON から来る(JS の数に読むと丸まる)。
  ['n', JSON.parse('{"n":9007199254740993}'), '9007199254740992', '9007199254740993'],
  ['n', { n: 0.000001 }, '0.000001', '1e-06'],
  ['n', { n: -0 }, '0', '-0.0'],
];

describe('revealOutput — 許容する Python との綴りの違い', () => {
  it.each(EDGE)('%s %o', (src, data, revealed, _python) => {
    expect(revealOutput(src, data, new JinjaBudget())).toMatchObject({
      kind: 'value',
      text: revealed,
    });
  });
});
