// =============================================================================
// jinjaExpr.ts — Jinja2 式の許可リスト評価器(eval / new Function を使わない)
// =============================================================================
// 役割:
//   値入りの描画(`fillRender.ts` と web の `fillJinja.ts`)が値を差し込むために必要な
//   **Jinja2 式の部分集合だけ**を解釈する。`nunjucks.compile` は `new Function` へ
//   到達するため、アプリオリジンの CSP から `'unsafe-eval'` を落とすには、値差込を
//   コンパイラ非依存にする必要がある(隔離オリジンでの完全描画は
//   `render/renderHost.ts` 側の責務で、本ファイルはそれに触らない)。
//
// 設計方針:
//   - **許可リスト**。フィルタ・テスト・関数・メソッドは下の一覧(`FILTERS` / `TESTS` /
//     `FUNCTIONS` / `STRING_METHODS`)に名前があるものだけを呼ぶ。一覧は本番のパーツが
//     使う構文の調査結果で決めたもので、それ以外の呼び出し・インライン `if`〜`else`・`~` 連結・
//     `in` 演算子などは解釈せず `JinjaExprError` を投げる。呼び出し側が件数を数えられるので、
//     失敗が無言にならない。
//   - 呼び出しは「一覧の名前を、決まった構文の位置で」呼ぶ形だけを持つ。値として得た関数を
//     呼ぶ構文は無い(名前解決・メンバ参照は関数値を返さない)。
//   - 優先順位は Jinja2 の parser に揃える: フィルタ `|` とテスト `is` は単項の後置で、
//     算術・比較より強く結合する(`a + b|length` は `a + (b|length)`)。
//   - `and` / `or` は短絡する。評価しない側も構文と名前の一覧は検査するが、実行時の失敗
//     (文字列でない値のメソッド等)は起こさない(`x is defined and x.startswith(…)` のため)。
//   - 演算子の意味は nunjucks の生成コードへ意図的に揃える(出力バイト一致のため)。
//     `and`/`or` は JS の `&&`/`||`、`//` は `Math.floor(a / b)`、`**` は `Math.pow`、
//     `==` は緩い比較。詳細は `binaryOp` の各分岐。
//
// nunjucks と**意図的に異なる**点:
//   - 名前解決・メンバ参照は **own property のみ**。nunjucks の `contextOrFrameLookup` /
//     `memberLookup` は prototype 経由を許すため `{{ constructor }}` や
//     `{{ "".constructor }}` が関数へ届く(SSTI の入口そのもの)。ここでは届かない。
//     属性名で引くフィルタ(`selectattr` / `groupby`)も同じ規則で引く。
//   - 解決結果が function なら `undefined` として扱う。
//   - 量に上限を持つ(`range` の長さ・batch / slice の引数・`+` の結果の長さ・描画の単位で共有する
//     評価の量 `JinjaBudget`)。他人が書いた断片を server でも描くので、ループと `set` / `namespace`
//     の掛け算で止まらなくしない。

/** 許可リストの外にある式に当たったことを表す。呼び出し側が数えて報告する。 */
export class JinjaExprError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JinjaExprError';
  }
}

// ── 1. 字句解析 ──

type TokenType = 'name' | 'number' | 'string' | 'op';

interface Token {
  readonly type: TokenType;
  readonly value: string;
  /** 文字列リテラルの復号済み値(`type === 'string'` のときのみ)。 */
  readonly text?: string;
}

// 長いものから順に試す(`>=` を `>` より、`==` を `=` より先に取る)。`~` は意図的に非対応。
const OPERATORS = [
  '==',
  '!=',
  '>=',
  '<=',
  '//',
  '**',
  '=',
  '(',
  ')',
  '[',
  ']',
  '.',
  ',',
  '|',
  '+',
  '-',
  '*',
  '/',
  '%',
  '<',
  '>',
] as const;

// 識別子は Unicode 文字を許す(帳票テンプレは日本語の変数名を持ちうる)。`$` は
// Jinja に無いので入れない。
const NAME_RE = /^[\p{L}_][\p{L}\p{N}_]*/u;
const NUMBER_RE = /^\d+(?:\.\d+)?/;

/** 文字列リテラルを読み、閉じ引用符の次の位置と復号済み本文を返す。 */
function readString(src: string, start: number): { end: number; text: string } {
  const quote = src[start];
  let text = '';
  let i = start + 1;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\\') {
      const next = src[i + 1];
      if (next === undefined) break;
      // Jinja のエスケープは Python 準拠だが、テンプレに現れるのは引用符と
      // バックスラッシュだけ。それ以外は「そのまま」にして解釈を増やさない。
      text += next === 'n' ? '\n' : next === 't' ? '\t' : next;
      i += 2;
      continue;
    }
    if (ch === quote) return { end: i + 1, text };
    text += ch;
    i += 1;
  }
  throw new JinjaExprError('文字列リテラルが閉じていません');
}

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const { end, text } = readString(src, i);
      tokens.push({ type: 'string', value: src.slice(i, end), text });
      i = end;
      continue;
    }
    const rest = src.slice(i);
    const num = NUMBER_RE.exec(rest);
    if (num) {
      tokens.push({ type: 'number', value: num[0] });
      i += num[0].length;
      continue;
    }
    const name = NAME_RE.exec(rest);
    if (name) {
      tokens.push({ type: 'name', value: name[0] });
      i += name[0].length;
      continue;
    }
    const op = OPERATORS.find((o) => rest.startsWith(o));
    if (op) {
      tokens.push({ type: 'op', value: op });
      i += op.length;
      continue;
    }
    throw new JinjaExprError(`解釈できない文字: ${JSON.stringify(ch)}`);
  }
  return tokens;
}

// ── 2. 値の部品 ──

/**
 * 差込コンテキスト。描画器が渡す値データとループ変数・`set` の代入の合成。ループの中では
 * `innerJinjaCtx` の層が外側を参照し、名前は内側の層から順に引く。
 */
export type JinjaCtx = Record<string, unknown>;

/**
 * `safe` フィルタの結果。描画器はこの値だけエスケープせずに出す。本文は private field に持ち、
 * own property を作らない(`(x|safe).html` のようなメンバ参照で中身や prototype へ届かせない)。
 */
class SafeHtml {
  readonly #html: string;
  constructor(html: string) {
    this.#html = html;
  }
  toString(): string {
    return this.#html;
  }
}

/** `safe` の付いた値か(描画器がエスケープを省く判定に使う)。 */
export function isJinjaSafe(value: unknown): boolean {
  return value instanceof SafeHtml;
}

/** `namespace()` で作った object。`set ns.x = …` で代入できるのはこれだけ。 */
const NAMESPACES = new WeakSet<object>();

/**
 * own property として定義する。代入(`obj[key] = v`)だと `__proto__` が prototype の差し替えになる
 * ため、ループ変数・`set`・`namespace` のキーはすべてこれで置く。
 */
function defineOwn(obj: object, key: string, value: unknown): void {
  Object.defineProperty(obj, key, { value, writable: true, enumerable: true, configurable: true });
}

/** 内側の文脈の層から外側の文脈への参照。層そのものはキーを持たないので、値として引けない。 */
const OUTER = new WeakMap<object, JinjaCtx>();

/**
 * `outer` の内側に置く文脈の層。ループ変数・`loop`・ループの中の `set` の値だけを持ち、それ以外の名前は
 * 外側をたどって引く。繰り返しのたびに外側を丸ごと複製しないため(文脈のキーの数に比例する仕事を
 * 回ごとにさせない)。prototype を null にするのは、`__proto__` という名前もただのキーとして置くため。
 */
export function innerJinjaCtx(outer: JinjaCtx): JinjaCtx {
  const layer: JinjaCtx = Object.create(null);
  OUTER.set(layer, outer);
  return layer;
}

/**
 * 名前を内側の層から外側へたどって探し、最初に own property として持つ層を返す(無ければ null)。
 * 外側へ 1 段たどるごとに評価の量を 1 数える(層の数は for の入れ子の深さ)。
 */
function findNameLayer(ctx: JinjaCtx, name: string, budget: JinjaBudget): JinjaCtx | null {
  let c: JinjaCtx | undefined = ctx;
  while (c !== undefined) {
    if (Object.hasOwn(c, name)) return c;
    c = OUTER.get(c);
    if (c !== undefined) budget.charge(1);
  }
  return null;
}

/**
 * 名前を内側の層から外側へたどって引く(`findNameLayer` の公開の形)。承認画面の描画
 * (`revealExpr.ts`)が、評価器の式の意味を使わずに名前だけを引くのに使う。
 */
export function lookupJinjaName(
  ctx: JinjaCtx,
  name: string,
  budget: JinjaBudget,
): { found: boolean; value: unknown } {
  const layer = findNameLayer(ctx, name, budget);
  return layer === null ? { found: false, value: undefined } : { found: true, value: layer[name] };
}

/** `obj` から own property だけを引く。prototype と function 値には決して届かない。 */
function lookupMember(obj: unknown, key: string | number): unknown {
  if (obj === null || obj === undefined) return undefined;
  if (typeof obj === 'string') return key === 'length' ? obj.length : undefined;
  if (typeof obj !== 'object') return undefined;
  const k = String(key);
  if (!Object.hasOwn(obj as object, k)) return undefined;
  const v = (obj as Record<string, unknown>)[k];
  return typeof v === 'function' ? undefined : v;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof SafeHtml);

/** 値を文字列として扱う(`safe` の印は外す)。長さと評価の量は `jsString` が数える。 */
function asText(v: unknown): string {
  return stringifyJinjaValue(v);
}

/** フィルタが並びとして読む値。Jinja の `list(value)` と同じく文字列は文字、dict はキーの並び。 */
function toSeq(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (v === undefined || v === null) return [];
  if (typeof v === 'string' || v instanceof SafeHtml) return [...v.toString()];
  if (isPlainObject(v)) return Object.keys(v);
  throw new JinjaExprError('並びとして読めない値です');
}

/**
 * batch の個数・slice の列数。上限を `MAX_RANGE` に揃えるのは、`fill_with` で埋める数・作る列の数が
 * そのまま引数で決まり、並びが短くても大きな配列を作れてしまうため。
 */
function positiveInt(v: unknown, what: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > MAX_RANGE) {
    throw new JinjaExprError(`${what} は 1 以上 ${MAX_RANGE} 以下の整数が必要です`);
  }
  return v;
}

/** Jinja の sandbox の `MAX_RANGE` と同じ値。 */
const MAX_RANGE = 100_000;

/**
 * 1 回の描画で評価器にさせる仕事の量の上限(並び・文字列の要素数で数える)。range やフィルタを
 * ループの中で何度も呼ぶ書き方は、1 つずつは上限の内でも掛け算で止まらなくなるので、描画の単位で
 * 合計を数える。実在のパーツ(数百行の表を数回選り分ける程度)に対して十分に大きい値にする。
 */
const MAX_WORK = 2_000_000;

/**
 * 評価の仕事の量を数える。描画器は 1 回の描画につき 1 つを作り、すべての式で共有する。
 * 上限は既定で `MAX_WORK`。server の申請の受付は、同期の計算で要求を止める時間を短くするため、
 * より小さい上限を渡す(`reviewRepo.ts` の `SUBMIT_RENDER_WORK`)。
 */
export class JinjaBudget {
  private used = 0;
  private readonly max: number;

  constructor(max: number = MAX_WORK) {
    this.max = max;
  }

  charge(units: number): void {
    this.used += units;
    if (this.used > this.max) throw new JinjaExprError('評価の量が上限を超えました');
  }

  /** 残りの量。入れ子をたどる処理は、これを超えてたどらない。 */
  get remaining(): number {
    return Math.max(0, this.max - this.used);
  }

  /** 使い切ったか。描画器はこれを見て以後の繰り返しを展開しない(式ごとに失敗させ続けない)。 */
  get exhausted(): boolean {
    return this.used > this.max;
  }
}

/**
 * 2 つの値の比較の費用を数える。文字列同士は短いほうの長さぶんの仕事になる(長い文字列を 1 度作れば、
 * 比べるたびにその長さを読ませられる)。片方だけが文字列なら、数への変換でその長さを読む。
 */
function chargeCompare(a: unknown, b: unknown): void {
  if (typeof a === 'string' && typeof b === 'string') {
    chargeActive(1 + Math.min(a.length, b.length));
  } else chargeActive(1 + textLength(a) + textLength(b));
}

/** 文字列なら長さ、そうでなければ 0(数への暗黙の変換で読む長さ)。 */
const textLength = (v: unknown): number => (typeof v === 'string' ? v.length : 0);

/** 算術の前に値を数として読める形へ直す。文字列の数への変換は長さぶんの仕事として数える。 */
function toArithmetic(v: unknown): number {
  const p = toPrimitive(v);
  chargeActive(1 + textLength(p));
  return p as number;
}

/**
 * 評価中の式の評価の量。フィルタ・テストの表(`FILTERS` / `TESTS`)の引数を値だけに保つため、評価器が
 * 同期で動く(途中で別の評価が割り込まない)ことを使い、`withBudget` の間だけここに置く。
 */
let activeBudget: JinjaBudget | null = null;

function withBudget<T>(budget: JinjaBudget, run: () => T): T {
  const prev = activeBudget;
  activeBudget = budget;
  try {
    return run();
  } finally {
    activeBudget = prev;
  }
}

function chargeActive(units: number): void {
  activeBudget?.charge(units);
}

/** 入れ子の深さの上限。値データの木はこれより浅く、namespace の自己参照で止まらなくしない。 */
const MAX_DEPTH = 64;

/** 並びの入れ子の要素の数の覚え書き。並びは評価器の中で書き換わらないので覚えてよい。 */
const DEEP_SIZE = new WeakMap<object, number>();

/**
 * 入れ子を含めた要素の数。`[a, a]` を重ねると参照の数は倍々に増え、文字列化・ループの展開で
 * そのぶんの仕事になるので、並びを作るたびにこれを評価の量に数える。上限を超えたら throw。
 */
function deepSize(v: unknown, cap: number, walk: { visited: number }, depth = 0): number {
  walk.visited += 1;
  if (typeof v !== 'object' || v === null || v instanceof SafeHtml) return 1;
  if (depth > MAX_DEPTH) throw new JinjaExprError('値の入れ子が深すぎます');
  if (Array.isArray(v)) {
    const hit = DEEP_SIZE.get(v);
    if (hit !== undefined) return hit;
  }
  let n = 1;
  for (const e of Array.isArray(v) ? v : Object.values(v)) {
    n += deepSize(e, cap - n, walk, depth + 1);
    if (n > cap || walk.visited > cap) throw new TooLargeError();
  }
  if (Array.isArray(v)) DEEP_SIZE.set(v, n);
  return n;
}

/** 入れ子の大きさが残りの評価の量を超えた(`deepSize` が投げる)。 */
class TooLargeError extends JinjaExprError {
  constructor() {
    super('値が大きすぎます');
  }
}

/**
 * `v` の入れ子の大きさを評価の量に数える。たどるのは残りの量までで、深さで投げるときは、たどった
 * 量を数えてから投げる(dict は覚え書きできないので、投げる経路で費用を払わないと毎回たどり直せる)。
 * 大きさが残りの量を超えたときは評価の量を使い切ったことにする。覚え書きした並びは数要素で上限を
 * 超えるので、たどった量だけを払うと、作るのに掛かった仕事を払わずに何度でも作り直せるため。
 */
function chargeDeepSize(budget: JinjaBudget, v: unknown): void {
  const walk = { visited: 0 };
  let n: number;
  try {
    n = deepSize(v, budget.remaining, walk);
  } catch (e) {
    budget.charge(e instanceof TooLargeError ? budget.remaining + 1 : walk.visited);
    throw e;
  }
  budget.charge(Math.max(n, walk.visited));
}

/**
 * フィルタ・テスト・メソッドの文字列の引数(trim の chars・属性名・startswith の引数・テスト名)と
 * 添字のキーの長さの上限。本番パーツの書き方(短い名前と記号)より十分に大きく、引数 1 つで
 * 長さぶんの仕事をさせる書き方を、課金より先に形で止める。
 */
const MAX_ARG_LENGTH = 256;

/** 属性名の段の数の上限(`a.b.c` の段)。 */
const MAX_ATTR_PARTS = 16;

/** 文字列の引数が上限の内か確かめる。超えたら throw。 */
function shortArg(v: unknown, what: string): void {
  if (typeof v === 'string' && v.length > MAX_ARG_LENGTH) {
    throw new JinjaExprError(`${what} が長すぎます(上限 ${MAX_ARG_LENGTH} 文字)`);
  }
}

const isObjectValue = (v: unknown): v is object => typeof v === 'object' && v !== null;

/**
 * JS の文字列化(`String(v)`)と同じ結果を、長さの上限と評価の量を数えながら作る。並びは要素を `,`
 * でつなぎ(null / undefined は空)、dict は `[object Object]`。値の object に置かれた `toString` は
 * 呼ばない。`+`・比較・フィルタの文字列化はすべてここを通す(`[a, a]` の倍化で止まらなくしない)。
 */
function jsString(v: unknown): string {
  if (!isObjectValue(v)) return String(v);
  if (v instanceof SafeHtml) return v.toString();
  if (!Array.isArray(v)) return '[object Object]';
  const parts: string[] = [];
  let len = 0;
  const add = (s: string) => {
    len += s.length;
    if (len > MAX_STRING_LENGTH) throw new JinjaExprError('文字列が長すぎます');
    chargeActive(s.length);
    parts.push(s);
  };
  const visit = (a: readonly unknown[], depth: number) => {
    if (depth > MAX_DEPTH) throw new JinjaExprError('値の入れ子が深すぎます');
    for (let i = 0; i < a.length; i++) {
      if (i > 0) add(',');
      const e = a[i];
      if (e === null || e === undefined) continue;
      if (Array.isArray(e)) visit(e, depth + 1);
      else add(jsString(e));
    }
  };
  visit(v, 0);
  return parts.join('');
}

/** 算術・比較の前に object を JS と同じ文字列へ直す(長さと評価の量を数える)。 */
const toPrimitive = (v: unknown): unknown => (isObjectValue(v) ? jsString(v) : v);

/** 仕事の量として数える値の大きさ(並び・文字列は要素数、dict はキーの数)。 */
function sizeOf(v: unknown): number {
  if (Array.isArray(v) || typeof v === 'string') return v.length;
  if (v instanceof SafeHtml) return v.toString().length;
  if (isPlainObject(v)) return Object.keys(v).length;
  return 0;
}

/** `selectattr` / `groupby` の属性名。`a.b` は段ごとに、数字の段は添字として引く。 */
function attrGetter(attribute: unknown): (item: unknown) => unknown {
  if (typeof attribute === 'number') return (item) => lookupMember(item, attribute);
  if (typeof attribute !== 'string') throw new JinjaExprError('属性名は文字列が必要です');
  shortArg(attribute, '属性名');
  const parts = attribute.split('.').map((p) => (/^\d+$/.test(p) ? Number(p) : p));
  if (parts.length > MAX_ATTR_PARTS) {
    throw new JinjaExprError(`属性名の段が多すぎます(上限 ${MAX_ATTR_PARTS})`);
  }
  return (item) => parts.reduce<unknown>((v, p) => lookupMember(v, p), item);
}

/** groupby の並べ替えの比較。Python の `sorted` と同じく、型の混ざった並びは比べない。 */
function compareKeys(a: unknown, b: unknown): number {
  chargeCompare(a, b);
  const num = (v: unknown) => typeof v === 'number' || typeof v === 'boolean';
  if (num(a) && num(b)) return Number(a) - Number(b);
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
  throw new JinjaExprError('型の混ざった値は並べ替えられません');
}

// ── 3. 許可リスト ──
// 一覧は本番パーツの構文調査で使われていたものだけ。足すときは `jinjaExpr.test.ts` と
// web の `ssti.guard.test.ts` に、その名前を使った攻撃の例を足す。

/**
 * 名前の一覧を prototype の無い凍結した object にする。名前は `Object.hasOwn` で引くが、一覧自身にも
 * `constructor` 等を持たせないことで、引き方を誤っても prototype の関数へ届かない。
 */
function allowlist<T>(entries: Record<string, T>): Readonly<Record<string, T>> {
  return Object.freeze(Object.assign(Object.create(null) as Record<string, T>, entries));
}

interface FilterSpec {
  /** キーワード引数で渡せる引数名(位置引数もこの順に割り当てる)。 */
  readonly params: readonly string[];
  /** 位置引数を `params` より多く受けるか(テスト名と引数を受ける `select` 等)。 */
  readonly variadic?: true;
  readonly apply: (value: unknown, ...args: unknown[]) => unknown;
}

const INT_RE = /^[+-]?\d+$/;
const FLOAT_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/** テスト名と引数で並びを選り分ける(`select` / `reject` / `selectattr` の共通部分)。 */
function selectBy(
  value: unknown,
  pick: (item: unknown) => unknown,
  args: unknown[],
  keep: boolean,
): unknown[] {
  const [testName, ...testArgs] = args;
  let test: (v: unknown) => boolean;
  if (testName === undefined) test = (v) => Boolean(v);
  else {
    const fn = lookupTest(testName);
    test = (v) => fn(v, ...testArgs);
  }
  return toSeq(value).filter((item) => test(pick(item)) === keep);
}

const FILTERS: Readonly<Record<string, FilterSpec>> = allowlist({
  default: {
    params: ['default_value', 'boolean'],
    // nunjucks / Jinja と同じく既定は「未定義のときだけ」。`none` は定義済みとして残す。
    apply: (v, d = '', boolean = false) => (boolean ? (v ? v : d) : v === undefined ? d : v),
  },
  int: {
    params: ['default'],
    apply: (v, d = 0) => {
      if (typeof v === 'number') return Number.isFinite(v) ? Math.trunc(v) : d;
      if (typeof v === 'boolean') return Number(v);
      if (typeof v !== 'string' && !(v instanceof SafeHtml)) return d;
      const s = v.toString().trim();
      if (INT_RE.test(s)) return Number.parseInt(s, 10);
      // Jinja は整数で読めなければ実数として読み、切り捨てる。
      if (FLOAT_RE.test(s)) {
        const f = Number(s);
        return Number.isFinite(f) ? Math.trunc(f) : d;
      }
      return d;
    },
  },
  length: {
    params: [],
    apply: (v) => {
      if (v === undefined || v === null) return 0;
      if (typeof v === 'string' || Array.isArray(v)) return v.length;
      if (v instanceof SafeHtml) return v.toString().length;
      if (isPlainObject(v)) return Object.keys(v).length;
      throw new JinjaExprError('長さの無い値です');
    },
  },
  list: { params: [], apply: (v) => [...toSeq(v)] },
  trim: {
    params: ['chars'],
    apply: (v, chars) => {
      const s = asText(v);
      let out: string;
      if (chars === undefined || chars === null) out = s.trim();
      else {
        shortArg(chars, 'trim の chars');
        const set = new Set(asText(chars));
        let a = 0;
        let b = s.length;
        while (a < b && set.has(s[a])) a++;
        while (b > a && set.has(s[b - 1])) b--;
        out = s.slice(a, b);
      }
      return v instanceof SafeHtml ? new SafeHtml(out) : out;
    },
  },
  safe: {
    params: [],
    apply: (v) => (v instanceof SafeHtml ? v : new SafeHtml(stringifyJinjaValue(v))),
  },
  batch: {
    params: ['linecount', 'fill_with'],
    apply: (v, linecount, fill) => {
      const n = positiveInt(linecount, 'batch の個数');
      const seq = toSeq(v);
      const filling = fill !== undefined && fill !== null && seq.length % n !== 0;
      // 作る前に、作る行の数と埋める数を数える(入力の大きさは呼び出し側が数えた)。
      chargeActive(Math.ceil(seq.length / n) + (filling ? n - (seq.length % n) : 0));
      const out: unknown[][] = [];
      for (let i = 0; i < seq.length; i += n) out.push(seq.slice(i, i + n));
      const last = out[out.length - 1];
      if (last && filling) while (last.length < n) last.push(fill);
      return out;
    },
  },
  slice: {
    params: ['slices', 'fill_with'],
    // Jinja の `do_slice` と同じ割り方(余りは前の列から 1 つずつ多くする)。
    apply: (v, slices, fill) => {
      const n = positiveInt(slices, 'slice の列数');
      const seq = toSeq(v);
      const per = Math.floor(seq.length / n);
      const extra = seq.length % n;
      const filling = fill !== undefined && fill !== null;
      // 作る前に、作る列の数と埋める数を数える(入力の大きさは呼び出し側が数えた)。
      chargeActive(n + (filling ? n - extra : 0));
      const out: unknown[][] = [];
      let offset = 0;
      for (let i = 0; i < n; i++) {
        const start = offset + i * per;
        if (i < extra) offset += 1;
        const tmp = seq.slice(start, offset + (i + 1) * per);
        if (filling && i >= extra) tmp.push(fill);
        out.push(tmp);
      }
      return out;
    },
  },
  groupby: {
    params: ['attribute', 'default', 'case_sensitive'],
    // Jinja 3 と同じく属性で並べ替えて束ね、既定では大小文字を区別しない(束ねた値は最初の要素の
    // 綴り)。各要素は `[grouper, list]` で、`for k, items in …` と `.grouper` / `.list` の両方で引ける。
    apply: (v, attribute, d, caseSensitive = false) => {
      const get = attrGetter(attribute);
      const keyOf = (item: unknown) => {
        const k = get(item);
        return k === undefined ? d : k;
      };
      const norm = (k: unknown) => {
        if (caseSensitive || typeof k !== 'string') return k;
        chargeActive(1 + k.length);
        return k.toLowerCase();
      };
      const sorted = toSeq(v)
        .map((item) => ({ item, key: norm(keyOf(item)) }))
        .sort((a, b) => compareKeys(a.key, b.key));
      const out: unknown[] = [];
      let i = 0;
      while (i < sorted.length) {
        const list: unknown[] = [];
        const key = sorted[i].key;
        while (i < sorted.length && compareKeys(sorted[i].key, key) === 0)
          list.push(sorted[i++].item);
        const grouper = keyOf(list[0]);
        out.push(Object.assign([grouper, list], { grouper, list }));
      }
      return out;
    },
  },
  select: { params: [], variadic: true, apply: (v, ...a) => selectBy(v, (x) => x, a, true) },
  reject: { params: [], variadic: true, apply: (v, ...a) => selectBy(v, (x) => x, a, false) },
  selectattr: {
    params: [],
    variadic: true,
    apply: (v, attribute, ...a) => selectBy(v, attrGetter(attribute), a, true),
  },
});

const TESTS: Readonly<Record<string, (value: unknown, ...args: unknown[]) => boolean>> = allowlist({
  defined: (v) => v !== undefined,
  equalto: (v, other) => {
    chargeCompare(v, other);
    return v === other;
  },
  // 1 回ごとに右辺の大きさを数える(`select("in", 長い並び)` は要素数の掛け算の仕事になる)。並びは
  // 要素ごとの比較の費用(文字列同士は短いほうの長さ)を数える。
  in: (v, seq) => {
    if (Array.isArray(seq)) {
      for (const e of seq) chargeCompare(v, e);
      return seq.includes(v);
    }
    chargeActive(1 + sizeOf(seq) + (typeof v === 'string' ? v.length : 0));
    if (typeof seq === 'string' || seq instanceof SafeHtml) {
      if (typeof v !== 'string') throw new JinjaExprError('文字列の in は文字列だけを探せます');
      return seq.toString().includes(v);
    }
    if (isPlainObject(seq)) return typeof v === 'string' && Object.hasOwn(seq, v);
    throw new JinjaExprError('in の右辺が入れ物ではありません');
  },
});

function lookupTest(name: unknown): (value: unknown, ...args: unknown[]) => boolean {
  shortArg(name, 'テスト名');
  if (typeof name !== 'string' || !Object.hasOwn(TESTS, name)) {
    throw new JinjaExprError(
      `許可していないテスト: ${typeof name === 'string' ? name : typeof name}`,
    );
  }
  return TESTS[name];
}

interface CallArgs {
  readonly args: unknown[];
  /** キーワード引数。キーが `__proto__` でも prototype にならないよう Map で持つ。 */
  readonly kwargs: Map<string, unknown>;
}

const FUNCTIONS: Readonly<Record<string, (call: CallArgs, budget: JinjaBudget) => unknown>> =
  allowlist({
    range: ({ args, kwargs }, budget) => {
      if (kwargs.size > 0 || args.length < 1 || args.length > 3) {
        throw new JinjaExprError('range の引数が合いません');
      }
      if (!args.every((a) => typeof a === 'number' && Number.isInteger(a))) {
        throw new JinjaExprError('range の引数は整数が必要です');
      }
      const [start, stop, step] = (args.length === 1 ? [0, args[0], 1] : [...args, 1]) as number[];
      if (step === 0) throw new JinjaExprError('range の step は 0 にできません');
      const len = Math.max(0, Math.ceil((stop - start) / step));
      if (len > MAX_RANGE) throw new JinjaExprError(`range が長すぎます(上限 ${MAX_RANGE})`);
      budget.charge(len);
      return Array.from({ length: len }, (_, i) => start + i * step);
    },
    namespace: ({ args, kwargs }) => {
      if (args.length > 0) throw new JinjaExprError('namespace はキーワード引数だけを受けます');
      const ns = {};
      for (const [k, v] of kwargs) defineOwn(ns, k, v);
      NAMESPACES.add(ns);
      return ns;
    },
  });

/**
 * Python の `str.splitlines()`(行末の改行で空の要素を作らない)。区切りは帳票の本文に現れうる
 * 改行類だけにし、制御文字の区切り(`\x1c` 等)は持たない。
 */
function splitLines(s: string): string[] {
  const lines = s.split(/\r\n|[\n\r\v\f\u0085\u2028\u2029]/);
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

const STRING_METHODS: Readonly<Record<string, (s: string, call: CallArgs) => unknown>> = allowlist({
  splitlines: (s, { args, kwargs }) => {
    if (args.length > 0 || kwargs.size > 0)
      throw new JinjaExprError('splitlines は引数を取りません');
    return splitLines(s);
  },
  startswith: (s, { args, kwargs }) => {
    if (args.length !== 1 || kwargs.size > 0 || typeof args[0] !== 'string') {
      throw new JinjaExprError('startswith は文字列を 1 つだけ受けます');
    }
    shortArg(args[0], 'startswith の引数');
    chargeActive(args[0].length);
    return s.startsWith(args[0]);
  },
});

/** フィルタの引数を `params` の順へ割り当てる。数の合わない呼び出しは throw。 */
function bindFilterArgs(name: string, spec: FilterSpec, call: CallArgs): unknown[] {
  const { args, kwargs } = call;
  if (spec.variadic) {
    if (kwargs.size > 0) throw new JinjaExprError(`${name} はキーワード引数を受けません`);
    return args;
  }
  if (args.length > spec.params.length) throw new JinjaExprError(`${name} の引数が多すぎます`);
  const bound = [...args];
  for (const [k, v] of kwargs) {
    const i = spec.params.indexOf(k);
    if (i < 0 || i < args.length) throw new JinjaExprError(`${name} に無い引数: ${k}`);
    bound[i] = v;
  }
  return bound;
}

// ── 4. 構文解析 + 評価(再帰下降。AST を作らず直接評価する) ──

/** 加算で作れる文字列の上限。`set` と namespace で倍々に伸ばす書き方を止める。 */
const MAX_STRING_LENGTH = 1_000_000;

const NO_ARGS: CallArgs = { args: [], kwargs: new Map() };

/**
 * `inspectJinjaExpr` が構文解析の途中で集める部品。評価のときは渡さない。`listDepth` はリストの
 * リテラルの入れ子の深さで、参照・フィルタがリストの中かを記録するのに使う。
 */
interface InspectRecorder {
  readonly refs: JinjaExprRef[];
  readonly calls: JinjaExprRef[];
  readonly filters: JinjaExprFilter[];
  readonly tests: string[];
  listDepth: number;
  /** 呼び出し(関数・フィルタ・メソッド)の引数の入れ子の深さ。 */
  callDepth: number;
}

/**
 * 括弧・リスト・呼び出しの引数・`not`・単項の入れ子の深さの上限。再帰下降なので、深い入れ子は JS の
 * スタックを使い切って RangeError になる(`JinjaExprError` でないので呼び出し側の想定の外になる)。
 * 本番のパーツの式は数段で、64 段は十分に大きい。
 */
const MAX_NEST = 64;

class Parser {
  private pos = 0;
  /**
   * 短絡で評価しない側を読んでいる深さ。0 より大きい間は呼び出し・演算・名前の解決をせず、評価の量も
   * 数えない(構文と名前の一覧だけを検査する)。`inspectJinjaExpr` は 1 から始めて式全体をこの形で読む。
   */
  private dead: number;
  /** 今の入れ子の深さ(`MAX_NEST` で止める)。 */
  private nest = 0;

  constructor(
    private readonly tokens: readonly Token[],
    private readonly ctx: JinjaCtx,
    private readonly budget: JinjaBudget,
    private readonly recorder?: InspectRecorder,
  ) {
    this.dead = recorder === undefined ? 0 : 1;
  }

  /**
   * 直後のメンバの引き方。`.name` ならその名前、`[k]` なら名前は null(添字は値なので静的に分からない)。
   */
  private memberAfter(): { member: boolean; memberName: string | null } {
    if (this.isOp('.')) {
      const t = this.peek(1);
      return { member: true, memberName: t?.type === 'name' ? t.value : null };
    }
    return { member: this.isOp('['), memberName: null };
  }

  /** 参照・呼び出し・フィルタが、リストの中か呼び出しの引数の中か。 */
  private where(): { inList: boolean; inCall: boolean } {
    return {
      inList: (this.recorder?.listDepth ?? 0) > 0,
      inCall: (this.recorder?.callDepth ?? 0) > 0,
    };
  }

  /** 入れ子を 1 段下りて `read` を読む。`MAX_NEST` を超えたら throw。 */
  private nested<T>(read: () => T): T {
    if (this.nest >= MAX_NEST) {
      throw new JinjaExprError(`式の入れ子が深すぎます(上限 ${MAX_NEST})`);
    }
    this.nest += 1;
    try {
      return read();
    } finally {
      this.nest -= 1;
    }
  }

  /** 式を 1 つ読み切り、末尾に余りが無いことを確かめる。 */
  parseAll(): unknown {
    if (this.tokens.length === 0) throw new JinjaExprError('式が空です');
    const value = this.parseOr();
    if (this.pos !== this.tokens.length) {
      throw new JinjaExprError(`解釈できない残り: ${this.tokens[this.pos].value}`);
    }
    return value;
  }

  private peek(offset = 0): Token | undefined {
    return this.tokens[this.pos + offset];
  }

  private isOp(value: string, offset = 0): boolean {
    const t = this.peek(offset);
    return t?.type === 'op' && t.value === value;
  }

  /** 次のトークンが `value` なら 1 つ進めて true。 */
  private eat(type: TokenType, value: string): boolean {
    const t = this.peek();
    if (t && t.type === type && t.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  private expect(type: TokenType, value: string): void {
    if (!this.eat(type, value)) throw new JinjaExprError(`${value} が必要です`);
  }

  private expectName(what: string): string {
    const t = this.peek();
    if (t?.type !== 'name') throw new JinjaExprError(`${what}が必要です`);
    this.pos += 1;
    return t.value;
  }

  /** `skip` が真なら評価しない側として読む(構文と名前の一覧だけを検査する)。 */
  private maybeDead(skip: boolean, read: () => unknown): unknown {
    if (!skip) return read();
    this.dead += 1;
    try {
      return read();
    } finally {
      this.dead -= 1;
    }
  }

  private parseOr(): unknown {
    let left = this.parseAnd();
    while (this.eat('name', 'or')) {
      const right = this.maybeDead(Boolean(left), () => this.parseAnd());
      left = left || right; // nunjucks は `||` を素で吐く(真偽値化しない)。
    }
    return left;
  }

  private parseAnd(): unknown {
    let left = this.parseNot();
    while (this.eat('name', 'and')) {
      const right = this.maybeDead(!left, () => this.parseNot());
      left = left && right;
    }
    return left;
  }

  private parseNot(): unknown {
    if (this.eat('name', 'not')) return !this.nested(() => this.parseNot());
    return this.parseCompare();
  }

  private parseCompare(): unknown {
    let left = this.parseAdditive();
    // nunjucks は比較を連鎖できる(`a < b < c` = `(a < b) < c`)ので同じ形にする。
    for (;;) {
      const t = this.peek();
      if (t?.type !== 'op') break;
      if (!['==', '!=', '<', '<=', '>', '>='].includes(t.value)) break;
      this.pos += 1;
      const right = this.parseAdditive();
      left = this.dead > 0 ? undefined : compareOp(t.value, left, right);
    }
    return left;
  }

  private parseAdditive(): unknown {
    let left = this.parseMultiplicative();
    for (;;) {
      let op: '+' | '-';
      if (this.eat('op', '+')) op = '+';
      else if (this.eat('op', '-')) op = '-';
      else break;
      const right = this.parseMultiplicative();
      if (this.dead > 0) left = undefined;
      else if (op === '+') {
        left = addOp(left, right);
        if (typeof left === 'string') this.budget.charge(left.length);
      } else left = toArithmetic(left) - toArithmetic(right);
    }
    return left;
  }

  private parseMultiplicative(): unknown {
    let left = this.parseUnary();
    for (;;) {
      const t = this.peek();
      if (t?.type !== 'op') break;
      if (!['*', '/', '//', '%', '**'].includes(t.value)) break;
      this.pos += 1;
      const right = this.parseUnary();
      left = this.dead > 0 ? undefined : arithmeticOp(t.value, left, right);
    }
    return left;
  }

  /** Jinja の `parse_unary` と同じく、単項の後にフィルタ・テストを重ねる(`-x|f` は `(-x)|f`)。 */
  private parseUnary(withFilter = true): unknown {
    let value: unknown;
    const sign = this.eat('op', '-') ? -1 : this.eat('op', '+') ? 1 : 0;
    if (sign === 0) value = this.parsePostfix();
    else {
      const operand = this.nested(() => this.parseUnary(false));
      value = this.dead > 0 ? undefined : sign * toArithmetic(operand);
    }
    return withFilter ? this.parseFilterExpr(value) : value;
  }

  private parseFilterExpr(value: unknown): unknown {
    let v = value;
    // 同じ連鎖で直前に掛けたフィルタの記録。次のフィルタの名前を `next` に書く(`|select|list`)。
    let prev: { next: string | null } | undefined;
    for (;;) {
      if (this.eat('op', '|')) {
        const at = this.recorder?.filters.length ?? 0;
        const name = this.peek()?.value ?? '';
        if (prev) prev.next = name;
        v = this.parseFilter(v);
        prev = this.recorder?.filters[at];
      } else if (this.eat('name', 'is')) {
        prev = undefined;
        v = this.parseTest(v);
      } else return v;
    }
  }

  private parseFilter(value: unknown): unknown {
    const name = this.expectName('フィルタ名');
    if (!Object.hasOwn(FILTERS, name)) throw new JinjaExprError(`許可していないフィルタ: ${name}`);
    const spec = FILTERS[name];
    this.recorder?.filters.push({ name, ...this.where(), next: null });
    const call = this.isOp('(') ? this.parseCallArgs() : NO_ARGS;
    const args = bindFilterArgs(name, spec, call);
    if (this.dead > 0) return undefined;
    this.budget.charge(1 + sizeOf(value));
    const result = spec.apply(value, ...args);
    // batch / slice の fill_with などで同じ値への参照を並べられるので、作った並びは入れ子ごと数える。
    if (Array.isArray(result)) chargeDeepSize(this.budget, result);
    return result;
  }

  /** `x is [not] name` / `x is name(args)`。括弧なしの引数(`is divisibleby 3`)は受けない。 */
  private parseTest(value: unknown): boolean | undefined {
    const negated = this.eat('name', 'not');
    const testName = this.expectName('テスト名');
    const test = lookupTest(testName);
    this.recorder?.tests.push(testName);
    const call = this.isOp('(') ? this.parseCallArgs() : NO_ARGS;
    if (call.kwargs.size > 0) throw new JinjaExprError('テストはキーワード引数を受けません');
    if (this.dead > 0) return undefined;
    return test(value, ...call.args) !== negated;
  }

  /** `(` から `)` までの引数。位置引数の後にだけ `name=expr` のキーワード引数を置ける。 */
  private parseCallArgs(): CallArgs {
    if (this.recorder) this.recorder.callDepth += 1;
    try {
      return this.nested(() => this.readCallArgs());
    } finally {
      if (this.recorder) this.recorder.callDepth -= 1;
    }
  }

  private readCallArgs(): CallArgs {
    this.expect('op', '(');
    const args: unknown[] = [];
    const kwargs = new Map<string, unknown>();
    if (this.eat('op', ')')) return { args, kwargs };
    for (;;) {
      if (this.peek()?.type === 'name' && this.isOp('=', 1)) {
        const key = this.expectName('引数名');
        this.pos += 1;
        if (kwargs.has(key)) throw new JinjaExprError(`引数が重複しています: ${key}`);
        kwargs.set(key, this.parseOr());
      } else {
        if (kwargs.size > 0) throw new JinjaExprError('キーワード引数の後に位置引数は置けません');
        args.push(this.parseOr());
      }
      if (this.eat('op', ')')) return { args, kwargs };
      this.expect('op', ',');
    }
  }

  /**
   * 一次式に `.name` / `[expr]` / 文字列メソッドの呼び出しを後置で重ねる。それ以外の `(` は
   * 受理しない(`{{ range.constructor("…")() }}` は必ずここで落ちる)。
   */
  private parsePostfix(): unknown {
    let value = this.parsePrimary();
    for (;;) {
      if (this.eat('op', '.')) {
        const t = this.peek();
        if (t?.type !== 'name') throw new JinjaExprError('. の後に名前が必要です');
        this.pos += 1;
        value = this.isOp('(') ? this.callMethod(value, t.value) : lookupMember(value, t.value);
        continue;
      }
      if (this.eat('op', '[')) {
        const key = this.nested(() => this.parseOr());
        this.expect('op', ']');
        if (this.dead > 0) {
          value = undefined;
          continue;
        }
        if (typeof key !== 'string' && typeof key !== 'number') {
          throw new JinjaExprError('添字は文字列か数値のみ受け付けます');
        }
        // 添字の文字列はキーとして読むときに長さぶんの仕事になる。
        shortArg(key, '添字');
        this.budget.charge(1 + textLength(key));
        value = lookupMember(value, key);
        continue;
      }
      if (this.isOp('(')) throw new JinjaExprError('関数呼び出しは解釈しません');
      return value;
    }
  }

  /** 文字列のメソッドだけを呼ぶ。値が文字列でなければ(配列・dict 等のメソッドも)呼ばない。 */
  private callMethod(value: unknown, name: string): unknown {
    if (!Object.hasOwn(STRING_METHODS, name)) {
      throw new JinjaExprError(`許可していないメソッド: ${name}`);
    }
    const call = this.parseCallArgs();
    if (this.dead > 0) return undefined;
    if (typeof value !== 'string') throw new JinjaExprError(`${name} は文字列にだけ呼べます`);
    this.budget.charge(1 + value.length);
    return STRING_METHODS[name](value, call);
  }

  private parsePrimary(): unknown {
    const t = this.peek();
    if (!t) throw new JinjaExprError('式が途中で終わっています');
    if (t.type === 'op' && t.value === '(') {
      this.pos += 1;
      const inner = this.nested(() => this.parseOr());
      this.expect('op', ')');
      return inner;
    }
    if (t.type === 'op' && t.value === '[') {
      this.pos += 1;
      const items: unknown[] = [];
      if (this.eat('op', ']')) return items;
      if (this.recorder) this.recorder.listDepth += 1;
      this.nested(() => {
        for (;;) {
          items.push(this.parseOr());
          if (this.eat('op', ']')) return;
          this.expect('op', ',');
        }
      });
      if (this.recorder) this.recorder.listDepth -= 1;
      if (this.dead === 0) chargeDeepSize(this.budget, items);
      return items;
    }
    if (t.type === 'number') {
      this.pos += 1;
      return Number(t.value);
    }
    if (t.type === 'string') {
      this.pos += 1;
      return t.text ?? '';
    }
    if (t.type === 'name') {
      this.pos += 1;
      // 関数は一覧の名前を呼び出しの形で書いたときだけ呼ぶ(値としては引けない)。
      if (this.isOp('(') && Object.hasOwn(FUNCTIONS, t.value)) {
        const where = this.where();
        const call = this.parseCallArgs();
        this.recorder?.calls.push({ name: t.value, ...this.memberAfter(), ...where });
        return this.dead > 0 ? undefined : FUNCTIONS[t.value](call, this.budget);
      }
      switch (t.value) {
        // Jinja の綴りと nunjucks が足す JS 綴りの両方を受ける。
        case 'true':
        case 'True':
          return true;
        case 'false':
        case 'False':
          return false;
        case 'none':
        case 'None':
        case 'null':
          return null;
        default:
          this.recorder?.refs.push({ name: t.value, ...this.memberAfter(), ...this.where() });
          return this.dead > 0 ? undefined : this.lookupName(t.value);
      }
    }
    throw new JinjaExprError(`解釈できないトークン: ${t.value}`);
  }

  /** 名前解決も own property のみ(prototype 経由の `constructor` 等へ届かせない)。 */
  private lookupName(name: string): unknown {
    const layer = findNameLayer(this.ctx, name, this.budget);
    if (layer === null) return undefined;
    const v = layer[name];
    return typeof v === 'function' ? undefined : v;
  }
}

/**
 * `+`。JS と同じく、片方が文字列か object なら文字列の連結、そうでなければ数の加算。文字列化は
 * `jsString` が長さを数える。
 */
function addOp(a: unknown, b: unknown): unknown {
  if (isObjectValue(a) || isObjectValue(b) || typeof a === 'string' || typeof b === 'string') {
    const s = jsString(a) + jsString(b);
    if (s.length > MAX_STRING_LENGTH) throw new JinjaExprError('文字列が長すぎます');
    return s;
  }
  return (a as number) + (b as number);
}

/**
 * nunjucks の `compareOps` と同じ演算子へ委譲する(`==` は緩い比較のまま)。object 同士の
 * `==` / `!=` は JS と同じく同一性で比べ、それ以外は object を `jsString` で文字列に直してから比べる
 * (JS が暗黙に行う文字列化を、長さを数える側で先に済ませる)。
 */
function compareOp(op: string, x: unknown, y: unknown): boolean {
  const identity = (op === '==' || op === '!=') && isObjectValue(x) && isObjectValue(y);
  const a = identity ? x : toPrimitive(x);
  const b = identity ? y : toPrimitive(y);
  chargeCompare(a, b);
  switch (op) {
    case '==':
      // biome-ignore lint/suspicious/noDoubleEquals: Jinja の `==` は緩い比較で、nunjucks も `==` を吐く。厳密比較にすると `'0' == 0` の判定が変わる。
      return (a as never) == (b as never);
    case '!=':
      // biome-ignore lint/suspicious/noDoubleEquals: 上と同じ理由(`!=` も緩い比較のまま揃える)。
      return (a as never) != (b as never);
    case '<':
      return (a as never) < (b as never);
    case '<=':
      return (a as never) <= (b as never);
    case '>':
      return (a as never) > (b as never);
    default:
      return (a as never) >= (b as never);
  }
}

/** nunjucks の `compileMul` 系が吐く JS と同じ結果にする。 */
function arithmeticOp(op: string, a: unknown, b: unknown): number {
  const x = toArithmetic(a);
  const y = toArithmetic(b);
  switch (op) {
    case '*':
      return x * y;
    case '/':
      return x / y;
    case '//':
      return Math.floor(x / y);
    case '**':
      return x ** y;
    default:
      return x % y;
  }
}

// ── 5. 公開 API ──

/**
 * Jinja 式 `src` を `ctx` に対して評価する。許可リストの外なら `JinjaExprError`。`budget` は描画の
 * 単位で共有する仕事の量(省くとこの式 1 つぶん)で、使い切ったときも `JinjaExprError`。
 * 例外を握り潰さないのが本関数の契約で、握るかどうかは呼び出し側が決める。
 */
export function evaluateJinjaExpr(
  src: string,
  ctx: JinjaCtx,
  budget: JinjaBudget = new JinjaBudget(),
): unknown {
  // 式 1 回ごとの基本の費用(字句解析と構文解析は式の長さに比例する)。何も出力しない式を
  // ループで何度も評価させる書き方も、評価の量で止める。
  budget.charge(1 + src.length);
  return withBudget(budget, () => new Parser(tokenize(src), ctx, budget).parseAll());
}

/** 式の中の名前の参照、または関数の呼び出し(`inspectJinjaExpr` の結果)。 */
export interface JinjaExprRef {
  readonly name: string;
  /** 参照・呼び出しの結果から、すぐ `.x` / `[k]` でメンバを引いているか。 */
  readonly member: boolean;
  /** `.x` で引いたときのメンバ名 `x`。`[k]` で引いたとき・引かないときは null。 */
  readonly memberName: string | null;
  /** リストのリテラルの中にあるか。 */
  readonly inList: boolean;
  /** 呼び出し(関数・フィルタ・メソッド)の引数の中にあるか。 */
  readonly inCall: boolean;
}

/** 式の中で使ったフィルタ(`inspectJinjaExpr` の結果)。 */
export interface JinjaExprFilter {
  readonly name: string;
  readonly inList: boolean;
  readonly inCall: boolean;
  /** 同じ連鎖ですぐ次に掛けたフィルタの名前(`xs|select|list` の select なら `list`)。無ければ null。 */
  next: string | null;
}

/** 一覧(`FUNCTIONS`)の関数の名前。不変ゲートは、呼ばずに値として出す形を不活性にしない。 */
export const JINJA_FUNCTION_NAMES: readonly string[] = Object.keys(FUNCTIONS);

/** `inspectJinjaExpr` の結果。部品の並びは式の中の出現順。 */
export interface JinjaExprInspection {
  /** 評価器の文法で読めるか。読めなければ `error` に理由があり、ほかの部品は空か途中まで。 */
  readonly ok: boolean;
  readonly error?: string;
  /** 文字列リテラルの原文(引用符の内側)と、評価器が復号した値。 */
  readonly strings: { readonly raw: string; readonly text: string }[];
  /** 字句の名前すべて(変数・メンバ・フィルタ・テスト・関数・キーワード引数・`and` などの語)。 */
  readonly names: string[];
  /** `.` の直後の名前。 */
  readonly members: string[];
  /** 変数の参照(`true` / `none` などの定数は含まない)。 */
  readonly refs: JinjaExprRef[];
  /** 一覧(`FUNCTIONS`)の関数の呼び出し。 */
  readonly calls: JinjaExprRef[];
  readonly filters: JinjaExprFilter[];
  readonly tests: string[];
}

/**
 * 評価の量を数えようとしたら落ちる予算。`inspectJinjaExpr` は量を数えない契約なので、数える経路が
 * 残っていれば `JinjaExprError` でない例外で表に出す(`ok:false` に紛れさせない)。
 */
class NoChargeBudget extends JinjaBudget {
  override charge(): void {
    throw new Error('inspectJinjaExpr が評価の量を数えました(dead の分岐の漏れ)');
  }
}

/**
 * 式 `src` を評価せずに読み、評価器の文法で読めるかと、判定に要る部品を返す。テンプレの不変ゲート
 * (`inertJinja.ts`)が、承認の前の原文を値なしで判定するのに使う。構文解析は評価しない側(`dead`)と
 * して式全体を読むので、関数は呼ばず、演算もせず、評価の量も数えない(`range(10**9)` も長さを
 * 数えない)。許可リストの外(`~`・インラインの `if`・`in`・一覧に無いフィルタ・テスト・関数・
 * メソッド・値の呼び出し)は `evaluateJinjaExpr` と同じ箇所で落ち、`ok:false` になる。
 */
export function inspectJinjaExpr(src: string): JinjaExprInspection {
  const strings: { raw: string; text: string }[] = [];
  const names: string[] = [];
  const members: string[] = [];
  const recorder: InspectRecorder = {
    refs: [],
    calls: [],
    filters: [],
    tests: [],
    listDepth: 0,
    callDepth: 0,
  };
  const result = (ok: boolean, error?: string): JinjaExprInspection => ({
    ok,
    ...(error === undefined ? {} : { error }),
    strings,
    names,
    members,
    refs: recorder.refs,
    calls: recorder.calls,
    filters: recorder.filters,
    tests: recorder.tests,
  });
  try {
    const tokens = tokenize(src);
    tokens.forEach((t, i) => {
      if (t.type === 'string') strings.push({ raw: t.value.slice(1, -1), text: t.text ?? '' });
      if (t.type !== 'name') return;
      names.push(t.value);
      const prev = tokens[i - 1];
      if (prev?.type === 'op' && prev.value === '.') members.push(t.value);
    });
    const budget = new NoChargeBudget();
    withBudget(budget, () =>
      new Parser(tokens, Object.create(null) as JinjaCtx, budget, recorder).parseAll(),
    );
    return result(true);
  } catch (e) {
    if (e instanceof JinjaExprError) return result(false, e.message);
    throw e;
  }
}

const LITERAL_NAMES = new Set(['true', 'True', 'false', 'False', 'none', 'None', 'null']);

/**
 * `{% set … %}` の `set` より後ろ(`x = expr` か `ns.x = expr`)を実行し、`ctx` へ代入する。属性への
 * 代入は `namespace()` で作った object にだけ許す(値データの object を書き換えさせない)。
 * 複数の代入(`a, b = …`)は受けない。名前への代入は `ctx` の層そのものに置くので、呼び出し側は
 * 複製か内側の層(`innerJinjaCtx`)を渡す(外へ漏らさないため)。
 */
export function assignJinjaSet(
  src: string,
  ctx: JinjaCtx,
  budget: JinjaBudget = new JinjaBudget(),
): void {
  budget.charge(1 + src.length);
  const tokens = tokenize(src);
  const target = tokens[0];
  if (target?.type !== 'name' || LITERAL_NAMES.has(target.value)) {
    throw new JinjaExprError('代入先の名前が必要です');
  }
  let attr: string | null = null;
  let at = 1;
  if (tokens[1]?.type === 'op' && tokens[1].value === '.') {
    if (tokens[2]?.type !== 'name') throw new JinjaExprError('. の後に名前が必要です');
    attr = tokens[2].value;
    at = 3;
  }
  if (tokens[at]?.type !== 'op' || tokens[at].value !== '=') {
    throw new JinjaExprError('代入の = が必要です');
  }
  const value = withBudget(budget, () => {
    const v = new Parser(tokens.slice(at + 1), ctx, budget).parseAll();
    // 代入した値はループと文字列化で何度も使われるので、入れ子ごとの大きさを数える。
    chargeDeepSize(budget, v);
    return v;
  });
  if (attr === null) {
    defineOwn(ctx, target.value, value);
    return;
  }
  const layer = findNameLayer(ctx, target.value, budget);
  const ns = layer === null ? undefined : layer[target.value];
  if (typeof ns !== 'object' || ns === null || !NAMESPACES.has(ns)) {
    throw new JinjaExprError('属性へ代入できるのは namespace だけです');
  }
  defineOwn(ns, attr, value);
}

/**
 * 評価結果を `{{ }}` の出力テキストへ変換する。nunjucks の `suppressValue`
 * (autoescape 無効)+ 文字列連結と同じ規則: null / undefined は空文字、それ以外は
 * JS の文字列化(配列は `a,b`、オブジェクトは `[object Object]`)。`safe` の値は元の HTML。
 */
export function stringifyJinjaValue(value: unknown, budget?: JinjaBudget): string {
  if (value === null || value === undefined) return '';
  return budget ? withBudget(budget, () => jsString(value)) : jsString(value);
}
