// =============================================================================
// revealExpr.ts — 承認画面の描画(reveal)で値を描く式を、本番の Python Jinja2 と同じ意味の形に絞る
// =============================================================================
// server は作成経路の申請を受けるとき、Jinja 原文を全部の枝を描く形(`fillRender.ts` の reveal)で描き、
// 承認画面に見せる。本番は社内の Python ツールが Python Jinja2 で描く。評価器(`jinjaExpr.ts`)は JS の
// 意味で式を評価するので、`{{ [] or "x" }}`・負の添字・`"a" * 3`・`True` / `None` の綴りなどで、承認画面と
// 本番の文字が変わる。reveal はここで読める形(名前・メンバ・添字の参照と、Python と同じ出力になると
// 表で確かめたフィルタ)だけを値で描き、ほかは原文の文字で見せる(呼び出し側が unrendered に数える)。
//
// 参照の意味は Python Jinja2 3.1 の `Environment.getattr` / `getitem` に合わせる:
//   - `a.b` は Python の getattr が先。dict のメソッド名(`items` など)は値でなくメソッドを返すので
//     原文で出す。それ以外は dict(JSON の object)が自分で持つキーだけを引き、無ければ未定義。
//   - 配列・文字列・数・真偽への名前の参照は、その型の Python の属性名なら原文、ほかは未定義。
//   - 添字は、配列なら 0 以上の整数だけを引く(負の添字は Python が後ろから数えるので原文)。文字列への
//     整数の添字(Python は 1 文字を返す)も原文。`a["b"]` は getitem が先なので、dict が自分で持つ
//     キーならメソッド名でも値を引き、無ければ名前の参照と同じ。
//   - 未定義の値からさらに引くと本番は描画に失敗するので、原文で出す。
// 出力の綴りは Python の `str()` に合わせる(真偽 `True` / `False`、`None`、list・dict は repr)。JSON
// 由来の小数(`1.0` が JS では `1`)はデータの表記の違いとして許容する。
// 確かめた期待値は `shared/test/revealExpr.test.ts` の表(Python Jinja2 3.1.6 で描いた値)に固定する。
// 許容する違い(同じテストの「許容する Python との綴りの違い」の表で固める): `upper` / `lower` / `trim` は
// JS の文字列メソッドで、Unicode の端の値で Python と違う(`trim` は U+0085 を残し U+FEFF を外す。Python は
// 逆)。`ß` と `İ` の大文字・小文字は同じ。数は JS の綴りで、2^53 を超える整数は丸まり、`1e-06` は
// `0.000001`、`-0.0` は `0` になる。どれも値のデータ(信頼の範囲の外)の表記の違いで、テンプレートの文字が
// 承認者に隠れることはない。

import { type JinjaBudget, type JinjaCtx, lookupJinjaName } from './jinjaExpr.js';

/** reveal の 1 回だけ描く for のループ変数・`loop`、値で描けない `set` の名前に置く印。 */
export const REVEAL_UNBOUND: unique symbol = Symbol('reveal-unbound');

/** 値で描けない(原文で出す)ことを表す結果。 */
export const REVEAL_SOURCE: unique symbol = Symbol('reveal-source');

/** reveal の for の `loop` の目印(自分が持つキーのほかは原文で出す)。 */
const LOOP_OBJECTS = new WeakSet<object>();

/** `fillRender.ts` の `loopCtx` が作る `loop` を、reveal の参照で `loop` として扱うよう印を付ける。 */
export function markRevealLoop(loop: object): void {
  LOOP_OBJECTS.add(loop);
}

// ── 1. 式の形 ──

type Step =
  | { kind: 'name'; name: string }
  | { kind: 'key'; name: string }
  | { kind: 'index'; index: number };

/** 値で描ける式: 名前と、メンバ・添字の並びと、フィルタの並び。 */
export interface RevealPath {
  readonly root: string;
  readonly steps: readonly Step[];
  readonly filters: readonly string[];
}

/**
 * Python と同じ出力になると表で確かめたフィルタ(引数なし)。`default` は引数なしだけ(文字の引数を
 * 持つ `default` は、sample に値があって本番に無いとき、引数の文字が承認者に一度も見えずに本番
 * だけに出るため、原文で出す)。
 */
const REVEAL_FILTERS: ReadonlySet<string> = new Set(['safe', 'trim', 'upper', 'lower', 'default']);

/** 名前として読めない語(Jinja の定数・演算子のキーワード)。 */
const KEYWORDS: ReadonlySet<string> = new Set([
  'true',
  'false',
  'none',
  'True',
  'False',
  'None',
  'and',
  'or',
  'not',
  'in',
  'is',
  'if',
  'else',
]);

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*/;
const INT_RE = /^[0-9]+/;
/** 添字の文字列キー。エスケープ(`\`)を持たない引用符の文字列だけを読む。 */
const STR_RE = /^(?:"([^"\\]*)"|'([^'\\]*)')/;

/** 添字の上限(これを超える整数は読まない。安全な整数の範囲に収める)。 */
const MAX_INDEX = 1_000_000_000;

/**
 * 式の原文を、値で描ける形として読む。読めなければ null(呼び出し側が原文で出す)。空白は Jinja と同じく
 * 区切りの間で読み飛ばす。
 */
export function parseRevealPath(src: string): RevealPath | null {
  let s = src.trim();
  const ws = () => {
    s = s.replace(/^\s+/, '');
  };
  const root = IDENT_RE.exec(s)?.[0];
  if (root === undefined || KEYWORDS.has(root)) return null;
  s = s.slice(root.length);
  const steps: Step[] = [];
  const filters: string[] = [];
  for (;;) {
    ws();
    if (s === '') break;
    if (s.startsWith('.')) {
      s = s.slice(1);
      ws();
      const id = IDENT_RE.exec(s)?.[0];
      if (id !== undefined) {
        steps.push({ kind: 'name', name: id });
        s = s.slice(id.length);
        continue;
      }
      const n = INT_RE.exec(s)?.[0];
      if (n === undefined || Number(n) > MAX_INDEX) return null;
      steps.push({ kind: 'index', index: Number(n) });
      s = s.slice(n.length);
      continue;
    }
    if (s.startsWith('[')) {
      s = s.slice(1);
      ws();
      const n = INT_RE.exec(s)?.[0];
      const str = STR_RE.exec(s);
      if (n !== undefined) {
        if (Number(n) > MAX_INDEX) return null;
        steps.push({ kind: 'index', index: Number(n) });
        s = s.slice(n.length);
      } else if (str) {
        steps.push({ kind: 'key', name: str[1] ?? str[2] ?? '' });
        s = s.slice(str[0].length);
      } else return null;
      ws();
      if (!s.startsWith(']')) return null;
      s = s.slice(1);
      continue;
    }
    if (s.startsWith('|')) {
      s = s.slice(1);
      ws();
      const f = IDENT_RE.exec(s)?.[0];
      if (f === undefined || !REVEAL_FILTERS.has(f)) return null;
      s = s.slice(f.length);
      ws();
      // 引数は空の括弧だけを受ける(`default("…")` などの引数つきは原文で出す)。
      if (s.startsWith('(')) {
        s = s.slice(1);
        ws();
        if (!s.startsWith(')')) return null;
        s = s.slice(1);
      }
      filters.push(f);
      continue;
    }
    return null;
  }
  return { root, steps, filters };
}

// ── 2. 参照 ──

/** Python の dict のメソッド名(getattr がキーより先に返す)。 */
const DICT_ATTRS: ReadonlySet<string> = new Set([
  'clear',
  'copy',
  'fromkeys',
  'get',
  'items',
  'keys',
  'pop',
  'popitem',
  'setdefault',
  'update',
  'values',
]);
/** Python の list のメソッド名。 */
const LIST_ATTRS: ReadonlySet<string> = new Set([
  'append',
  'clear',
  'copy',
  'count',
  'extend',
  'index',
  'insert',
  'pop',
  'remove',
  'reverse',
  'sort',
]);
/** Python の str のメソッド名。 */
const STR_ATTRS: ReadonlySet<string> = new Set(
  (
    'capitalize casefold center count encode endswith expandtabs find format format_map index ' +
    'isalnum isalpha isascii isdecimal isdigit isidentifier islower isnumeric isprintable ' +
    'isspace istitle isupper join ljust lower lstrip maketrans partition removeprefix ' +
    'removesuffix replace rfind rindex rjust rpartition rsplit rstrip split splitlines ' +
    'startswith strip swapcase title translate upper zfill'
  ).split(' '),
);
/** Python の int / float / bool の属性名。 */
const NUM_ATTRS: ReadonlySet<string> = new Set(
  (
    'as_integer_ratio bit_count bit_length conjugate denominator from_bytes fromhex hex imag ' +
    'is_integer numerator real to_bytes'
  ).split(' '),
);

const isDict = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** 1 段の参照。値・未定義(`undefined`)・原文で出す印のどれか。 */
function step(value: unknown, s: Step): unknown {
  if (value === REVEAL_UNBOUND || value === undefined) return REVEAL_SOURCE;
  if (value === null) return undefined;
  if (typeof value === 'object' && LOOP_OBJECTS.has(value)) {
    if (s.kind === 'index' || !Object.hasOwn(value, s.name)) return REVEAL_SOURCE;
    return (value as Record<string, unknown>)[s.name];
  }
  if (s.kind === 'index') {
    if (Array.isArray(value)) return s.index < value.length ? value[s.index] : undefined;
    if (typeof value === 'string') return REVEAL_SOURCE;
    return undefined;
  }
  const { name } = s;
  if (isDict(value)) {
    // `a.b` は Python の getattr が先(dict のメソッドがキーに勝つ)。`a["b"]` は getitem が先。
    const own = Object.hasOwn(value, name);
    if (s.kind === 'name' ? DICT_ATTRS.has(name) : !own && DICT_ATTRS.has(name))
      return REVEAL_SOURCE;
    if (!own) return undefined;
    const v = value[name];
    return typeof v === 'function' ? REVEAL_SOURCE : v;
  }
  if (Array.isArray(value)) return LIST_ATTRS.has(name) ? REVEAL_SOURCE : undefined;
  if (typeof value === 'string') return STR_ATTRS.has(name) ? REVEAL_SOURCE : undefined;
  if (typeof value === 'number' || typeof value === 'boolean')
    return NUM_ATTRS.has(name) ? REVEAL_SOURCE : undefined;
  return REVEAL_SOURCE;
}

/**
 * 値で描ける式の値。原文で出すときは `REVEAL_SOURCE`、未定義は `undefined`。フィルタは掛けない
 * (`revealOutput` が文字列に直してから掛ける)。
 */
export function revealValue(path: RevealPath, ctx: JinjaCtx, budget: JinjaBudget): unknown {
  const root = lookupJinjaName(ctx, path.root, budget);
  let value: unknown = root.found ? root.value : undefined;
  if (value === REVEAL_UNBOUND) return REVEAL_SOURCE;
  for (const s of path.steps) {
    budget.charge(1);
    value = step(value, s);
    if (value === REVEAL_SOURCE) return REVEAL_SOURCE;
  }
  return value;
}

// ── 3. Python の綴り ──

/** Python の `str.isprintable()` が偽になる文字(制御・書式・区切り。半角空白は除く)。 */
const NOT_PRINTABLE_RE = /[\p{C}\p{Z}]/u;

/** Python の `repr(str)`。印字できない文字を含むときは null(綴りを合わせきれないので原文で出す)。 */
function pyStrRepr(s: string): string | null {
  for (const ch of s) if (ch !== ' ' && NOT_PRINTABLE_RE.test(ch)) return null;
  const q = s.includes("'") && !s.includes('"') ? '"' : "'";
  const body = s.replace(/\\/g, '\\\\').replace(q === "'" ? /'/g : /"/g, `\\${q}`);
  return `${q}${body}${q}`;
}

/** 数の綴り。整数でない値も JS の綴りのまま(JSON 由来の `1.0` は許容)。 */
const pyNum = (n: number): string | null =>
  Number.isFinite(n) ? String(n) : Number.isNaN(n) ? 'nan' : n > 0 ? 'inf' : '-inf';

/** Python の `repr`(list・dict の要素)。合わせきれない値は null。 */
function pyRepr(v: unknown, budget: JinjaBudget): string | null {
  budget.charge(1);
  if (v === null) return 'None';
  if (v === true) return 'True';
  if (v === false) return 'False';
  if (typeof v === 'number') return pyNum(v);
  if (typeof v === 'string') {
    budget.charge(v.length);
    return pyStrRepr(v);
  }
  if (Array.isArray(v)) {
    const items: string[] = [];
    for (const x of v) {
      const r = pyRepr(x, budget);
      if (r === null) return null;
      items.push(r);
    }
    return `[${items.join(', ')}]`;
  }
  if (isDict(v)) {
    const items: string[] = [];
    for (const k of Object.keys(v)) {
      // 整数に見えるキーは JS の object が並びを変える(Python は入れた順のまま)。
      if (/^[0-9]+$/.test(k)) return null;
      const kr = pyStrRepr(k);
      const vr = pyRepr(v[k], budget);
      if (kr === null || vr === null) return null;
      items.push(`${kr}: ${vr}`);
    }
    return `{${items.join(', ')}}`;
  }
  return null;
}

/** Python の `str()`(出力の綴り)。未定義は空。合わせきれない値は null。 */
export function pyStr(v: unknown, budget: JinjaBudget): string | null {
  if (v === undefined) return '';
  if (typeof v === 'string') {
    budget.charge(v.length);
    return v;
  }
  return pyRepr(v, budget);
}

// ── 4. 出力 ──

/** `revealOutput` の結果。`source` は原文で出す。`missing` は未定義の値を出した。 */
export type RevealOutput =
  | { readonly kind: 'source' }
  | {
      readonly kind: 'value';
      readonly text: string;
      readonly safe: boolean;
      readonly missing: boolean;
    };

/**
 * `{{ src }}` を reveal で描く。値で描ける形なら Python の綴りの文字列と `safe` の有無を返し、ほかは
 * `source`(原文で出す)。フィルタは Python と同じく文字列に直してから掛ける。
 */
export function revealOutput(src: string, ctx: JinjaCtx, budget: JinjaBudget): RevealOutput {
  const path = parseRevealPath(src);
  if (path === null) return { kind: 'source' };
  const value = revealValue(path, ctx, budget);
  if (value === REVEAL_SOURCE) return { kind: 'source' };
  let text = pyStr(value, budget);
  if (text === null) return { kind: 'source' };
  let safe = false;
  for (const f of path.filters) {
    if (f === 'safe') safe = true;
    else if (f === 'trim') text = text.trim();
    else if (f === 'upper') text = text.toUpperCase();
    else if (f === 'lower') text = text.toLowerCase();
    // `default`(引数なし)は未定義を空にするだけで、`pyStr` が既に空にしている。
  }
  return { kind: 'value', text, safe, missing: value === undefined };
}
