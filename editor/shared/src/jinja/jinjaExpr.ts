// =============================================================================
// jinjaExpr.ts — Jinja2 式の許可リスト評価器(eval / new Function を使わない)
// =============================================================================
// 役割:
//   `fillJinja.ts` の `toFilled` が編集キャンバス用の値を差し込むために必要な
//   **Jinja2 式の部分集合だけ**を解釈する。`nunjucks.compile` は `new Function` へ
//   到達するため、アプリオリジンの CSP から `'unsafe-eval'` を落とすには、値差込を
//   コンパイラ非依存にする必要がある(隔離オリジンでの完全描画は
//   `render/renderHost.ts` 側の責務で、本ファイルはそれに触らない)。
//
// 設計方針:
//   - **許可リスト**。文法に無い形(関数呼び出し・フィルタ `|`・テスト `is`・
//     インライン `if`〜`else`・`~` 連結など)は解釈せず `JinjaExprError` を投げる。
//     呼び出し側が件数を数えられるので、失敗が無言にならない。
//   - 実運用テンプレに現れる形(`fund.name` / `loop.index` / `costTotal.amount` /
//     `{% for h in holdings %}` / `{% if fund.navChange >= 0 %}`)を過不足なく覆い、
//     ついでに危険の無い算術・比較・論理演算まで通す。
//   - 演算子の意味は nunjucks の生成コードへ意図的に揃える(出力バイト一致のため)。
//     `and`/`or` は JS の `&&`/`||`、`//` は `Math.floor(a / b)`、`**` は `Math.pow`、
//     `==` は緩い比較。詳細は `binaryOp` の各分岐。
//
// nunjucks と**意図的に異なる**点(いずれも実テンプレでは出現せず、出力は変わらない):
//   - 名前解決・メンバ参照は **own property のみ**。nunjucks の `contextOrFrameLookup` /
//     `memberLookup` は prototype 経由を許すため `{{ constructor }}` や
//     `{{ "".constructor }}` が関数へ届く(SSTI の入口そのもの)。ここでは届かない。
//   - 解決結果が function なら `undefined` として扱う。呼び出し構文が無い以上、
//     関数値を露出させる理由が無い。

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

// 長いものから順に試す(`>=` を `>` より先に取る)。`|` `~` `is` などは意図的に非対応。
const OPERATORS = [
  '==',
  '!=',
  '>=',
  '<=',
  '//',
  '**',
  '(',
  ')',
  '[',
  ']',
  '.',
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

// ── 2. 構文解析 + 評価(再帰下降。AST を作らず直接評価する) ──

/** 差込コンテキスト。`toFilled` が渡す sample データとループ変数の合成。 */
export type JinjaCtx = Record<string, unknown>;

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

class Parser {
  private pos = 0;

  constructor(
    private readonly tokens: readonly Token[],
    private readonly ctx: JinjaCtx,
  ) {}

  /** 式を 1 つ読み切り、末尾に余りが無いことを確かめる。 */
  parseAll(): unknown {
    if (this.tokens.length === 0) throw new JinjaExprError('式が空です');
    const value = this.parseOr();
    if (this.pos !== this.tokens.length) {
      throw new JinjaExprError(`解釈できない残り: ${this.tokens[this.pos].value}`);
    }
    return value;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
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

  private parseOr(): unknown {
    let left = this.parseAnd();
    while (this.eat('name', 'or')) {
      const right = this.parseAnd();
      left = left || right; // nunjucks は `||` を素で吐く(真偽値化しない)。
    }
    return left;
  }

  private parseAnd(): unknown {
    let left = this.parseNot();
    while (this.eat('name', 'and')) {
      const right = this.parseNot();
      left = left && right;
    }
    return left;
  }

  private parseNot(): unknown {
    if (this.eat('name', 'not')) return !this.parseNot();
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
      left = compareOp(t.value, left, this.parseAdditive());
    }
    return left;
  }

  private parseAdditive(): unknown {
    let left = this.parseMultiplicative();
    for (;;) {
      if (this.eat('op', '+')) left = (left as number) + (this.parseMultiplicative() as number);
      else if (this.eat('op', '-'))
        left = (left as number) - (this.parseMultiplicative() as number);
      else break;
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
      left = arithmeticOp(t.value, left, this.parseUnary());
    }
    return left;
  }

  private parseUnary(): unknown {
    if (this.eat('op', '-')) return -(this.parseUnary() as number);
    if (this.eat('op', '+')) return +(this.parseUnary() as number);
    return this.parsePostfix();
  }

  /** 一次式に `.name` / `[expr]` を後置で重ねる。関数呼び出し `(` は受理しない。 */
  private parsePostfix(): unknown {
    let value = this.parsePrimary();
    for (;;) {
      if (this.eat('op', '.')) {
        const t = this.peek();
        if (t?.type !== 'name') throw new JinjaExprError('. の後に名前が必要です');
        this.pos += 1;
        value = lookupMember(value, t.value);
        continue;
      }
      if (this.eat('op', '[')) {
        const key = this.parseOr();
        this.expect('op', ']');
        if (typeof key !== 'string' && typeof key !== 'number') {
          throw new JinjaExprError('添字は文字列か数値のみ受け付けます');
        }
        value = lookupMember(value, key);
        continue;
      }
      // 関数呼び出しは許可リスト外。ここで弾くのが SSTI を通さない要
      // (`{{ range.constructor("…")() }}` は必ずここで落ちる)。
      if (this.peek()?.type === 'op' && this.peek()?.value === '(') {
        throw new JinjaExprError('関数呼び出しは解釈しません');
      }
      return value;
    }
  }

  private parsePrimary(): unknown {
    const t = this.peek();
    if (!t) throw new JinjaExprError('式が途中で終わっています');
    if (t.type === 'op' && t.value === '(') {
      this.pos += 1;
      const inner = this.parseOr();
      this.expect('op', ')');
      return inner;
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
          return this.lookupName(t.value);
      }
    }
    throw new JinjaExprError(`解釈できないトークン: ${t.value}`);
  }

  /** 名前解決も own property のみ(prototype 経由の `constructor` 等へ届かせない)。 */
  private lookupName(name: string): unknown {
    if (!Object.hasOwn(this.ctx, name)) return undefined;
    const v = this.ctx[name];
    return typeof v === 'function' ? undefined : v;
  }
}

/** nunjucks の `compareOps` と同じ演算子へ委譲する(`==` は緩い比較のまま)。 */
function compareOp(op: string, a: unknown, b: unknown): boolean {
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
  const x = a as number;
  const y = b as number;
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

// ── 3. 公開 API ──

/**
 * Jinja 式 `src` を `ctx` に対して評価する。許可リストの外なら `JinjaExprError`。
 * 例外を握り潰さないのが本関数の契約で、握るかどうかは呼び出し側が決める。
 */
export function evaluateJinjaExpr(src: string, ctx: JinjaCtx): unknown {
  return new Parser(tokenize(src), ctx).parseAll();
}

/**
 * 評価結果を `{{ }}` の出力テキストへ変換する。nunjucks の `suppressValue`
 * (autoescape 無効)+ 文字列連結と同じ規則: null / undefined は空文字、それ以外は
 * JS の文字列化(配列は `a,b`、オブジェクトは `[object Object]`)。
 */
export function stringifyJinjaValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value);
}
