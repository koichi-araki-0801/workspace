// =============================================================================
// inertJinja.ts — テキストの位置に置いても実行面を生まない Jinja トークンの判定
// =============================================================================
// テンプレの不変ゲート(`server/src/security/templateScripts.ts`)は、テキストの位置の Jinja の
// うち、ここで不活性と言えないものを単位にして基準と突き合わせる。判定は許可リストで書く。
// 危ない形を数え上げる向きでは、`{{ "<"|safe }}`・`{% set lt %}<{% endset %}` のような形が
// 数え切れないため(設計正典の却下済み設計「描画で生まれる実行面を、危ない形の数え上げで単位にする」)。
//
// 根拠は**本番の Python Jinja2 の出力**で考える(評価器の `jsString` ではない)。本番の描画器の
// 設定は分からないので、autoescape 無し・sandbox 無しを前提にする。テキストの位置で守るのは次の
// 2 つだけである。
//   1. 値のデータに無い `<` を出さないこと(リテラルの原文の文字を制限し、Python の `str()` が
//      自分から `<` を書く値を出さない)
//   2. Python の任意のコードに届かないこと(`_` で始まる名前・メンバを禁じる。sandbox と同じ決まり)
// 属性値の中と CSS の中の Jinja は、ここを通さず形を問わず単位にする(呼び出し側の規則)。
// 属性値の中では、許可した文字だけのリテラル(`'javascript'`)も後ろの地の `:` とつながるため。
//
// 式の文法は評価器(`jinjaExpr.ts` の `inspectJinjaExpr`)を基準にする。評価器が読めない形
// (`~`・インラインの `if`・`in`・一覧に無いフィルタ等)は、Python では読めても不活性と言わない。

import { parseForHeader } from './fillRender.js';
import { inspectJinjaExpr, JINJA_FUNCTION_NAMES, type JinjaExprInspection } from './jinjaExpr.js';
import type { JinjaToken } from './jinjaLex.js';

/**
 * リテラルの原文(引用符の内側)に許す文字。ASCII の英字・数字・空白と `- . , # + * ! ?`、
 * U+0080 以降。原文で見るのは、評価器が `\x3c` を `x3c` と読む一方で Python は `<` と読むから。
 * `\` `%` `{` `:` `_` などを外すことで、エスケープ・書式・属性名の綴りから `<` や dunder を作れない。
 */
const LITERAL_CHAR_RE = /^[A-Za-z0-9 \t\n\r\-.,#+*!?\u0080-￿]*$/;

/** 本体がキーワードだけで終わる文。 */
const BARE_KEYWORDS = new Set(['else', 'endif', 'endfor', 'raw', 'endraw']);

/**
 * 出力すると Python の `str()` が自分から `<` を書く値を返すフィルタ。`select` 系・`batch`・`slice`
 * はジェネレータを返し `<generator object …>` になる。`for` の対象と `if` の条件では使ってよい
 * (出力しないので)。`rejectattr` は評価器の一覧に無いが、一覧に足したときに漏れないよう並べておく。
 */
const GENERATOR_FILTERS = new Set([
  'select',
  'reject',
  'selectattr',
  'rejectattr',
  'batch',
  'slice',
]);

/** 同じ連鎖で生成器の直後に掛けると、出るのがリストか数になるフィルタ(`xs|select|list`)。 */
const GENERATOR_SINKS = new Set(['list', 'length']);

/** `<Namespace {…}>` を返す関数。中身にリテラル・データが入る。 */
const NAMESPACE_CALL = 'namespace';

/** `<LoopContext …>` になる名前。 */
const LOOP_NAME = 'loop';

/**
 * 出してよい `loop` のメンバ(数・真偽値)。`previtem` `nextitem` は要素そのもの(namespace を回すと
 * `<Namespace …>`)、`cycle` `changed` は `<bound method …>` を出すので外す。許可リストにするのは、
 * 一覧に無いメンバ(`loop["nextitem"]` の添字を含む)を数え上げずに外すため。
 */
const LOOP_SAFE_MEMBERS = new Set([
  'index',
  'index0',
  'revindex',
  'revindex0',
  'first',
  'last',
  'length',
  'depth',
  'depth0',
]);

/**
 * 値として出すと Python の repr(`<class 'range'>`・`<function …>`・`<TemplateReference …>`)になる
 * 名前。評価器の関数の一覧と、Jinja2 の `DEFAULT_NAMESPACE`(range dict lipsum cycler joiner
 * namespace)と `self`、テンプレートの中だけにある `super` `caller` `varargs` `kwargs`。メンバを
 * 引いても(`range.start` は `<member 'start' …>`)外す。
 * 本番の描画器が global を足している(`env.globals` に関数・クラスを置く)と、その名前も同じく repr を
 * 出すが、ここからは見えない。分かったら足す。
 */
const GLOBAL_NAMES = new Set([
  ...JINJA_FUNCTION_NAMES,
  'range',
  'dict',
  'lipsum',
  'cycler',
  'joiner',
  'namespace',
  'self',
  'super',
  'caller',
  'varargs',
  'kwargs',
]);

const SET_RE = /^set\s+([A-Za-z]\w*)(\.[A-Za-z]\w*)?\s*=([\s\S]*)$/;

/**
 * 式が不活性な式か(評価器の文法で読め、名前が `_` で始まらず、リテラルの原文が許可した文字だけ)。
 * 不活性なら部品を、そうでなければ null を返す。
 */
function inspectInert(src: string): JinjaExprInspection | null {
  const r = inspectJinjaExpr(src);
  if (!r.ok) return null;
  if (r.names.some((n) => n.startsWith('_'))) return null;
  return r.strings.every((s) => LITERAL_CHAR_RE.test(s.raw)) ? r : null;
}

/**
 * 式の中で、`str()` が `<` を書く値そのものを作る部品。`nested` はリストの中か呼び出しの引数の中で、
 * そこにあると、入れ物から取り出した値がそのものになる(`set l = [ns]` の `l[0]`)。
 * `taint` は、どこにあっても束ねた名前を何を引いても出せなくする部品(global・裸の `loop`・loop の
 * 要素を返すメンバ)。それ以外は、最上位にあれば束ねた名前のそのままの出力だけを止める。
 * 裸の `loop` が `taint` なのは、`loop` が反復でき、`__iter__` が `(要素, LoopContext)` の組を返す
 * (要素に自分自身を含む)うえ、別名にするとメンバの許可リスト(`LOOP_SAFE_MEMBERS`)が効かなく
 * なるため。メンバを引けるのは字面が `loop.` のときだけで、`{% set outer = loop %}{{ outer.index }}`
 * も単位になる(拾いすぎる側)。
 */
interface Atom {
  readonly nested: boolean;
  readonly taint: boolean;
}

function atomsOf(r: JinjaExprInspection): Atom[] {
  const out: Atom[] = [];
  for (const c of r.calls) {
    if (c.name === NAMESPACE_CALL && !c.member) {
      out.push({ nested: c.inList || c.inCall, taint: false });
    }
  }
  for (const x of r.refs) {
    const nested = x.inList || x.inCall;
    if (GLOBAL_NAMES.has(x.name)) out.push({ nested, taint: true });
    else if (x.name !== LOOP_NAME) continue;
    else if (!x.member) out.push({ nested, taint: true });
    else if (x.memberName === null || !LOOP_SAFE_MEMBERS.has(x.memberName)) {
      out.push({ nested, taint: true });
    }
  }
  for (const f of r.filters) {
    if (!GENERATOR_FILTERS.has(f.name)) continue;
    if (f.next !== null && GENERATOR_SINKS.has(f.next)) continue;
    out.push({ nested: f.inList || f.inCall, taint: false });
  }
  return out;
}

/**
 * 束ねの辺の種類。`top` は最上位の裸の参照(束ねた名前をそのまま束ね直す)、`nested` は入れ物の中の
 * 裸の参照(取り出すとそのものになる)、`member` はメンバを引いた参照と、for の対象の最上位の参照
 * (回して取り出すのは要素なので、何を引いても出せない名前だけが伝わる)。
 */
type EdgeKind = 'top' | 'nested' | 'member';

/**
 * 文書の Jinja のトークンが不活性かを判定する。`{% set N = namespace(…) %}` などで束ねた名前を
 * `{{ N }}` と出すと `<Namespace {…}>` になるので、束ねた名前を文書全体で 1 つの集合に集めてから
 * 判定する。スコープは考えず、文書の後ろで束ねた名前も前の出力に当てる(拾いすぎる側)。
 * 束ねは、テキストの位置以外(タグ・属性値・CSS・チップの中)の文も含めて渡すこと。
 */
export class InertJinjaJudge {
  /** そのまま(メンバを引かずに)出すと `<` を書く値を束ねた名前。 */
  private readonly bound = new Set<string>();
  /**
   * 何を引いて出しても不活性と言えない名前。入れ物に危ない値を入れて束ねた名前(`set l = [ns]`・
   * `set d = namespace(k=ns)`)、global や `loop.previtem` を束ねた名前、読めない文(右辺が文法の外の
   * `set`・ブロックの `set`・`with`・`macro` など)が束ねる名前、属性に危ない値を置いた namespace
   * (`set ns.x = ns2`)。読めない文は基準にあれば単位として通るので、束ねた名前を後から出す形を
   * ここで止める。
   */
  private readonly tainted = new Set<string>();
  private readonly inspected = new Map<string, JinjaExprInspection | null>();

  constructor(tokens: Iterable<JinjaToken>) {
    const edges = new Map<string, { to: string; kind: EdgeKind }[]>();
    const seeds: [string, 'bound' | 'tainted'][] = [];
    const link = (r: JinjaExprInspection, to: string, bareTop: EdgeKind) => {
      for (const x of r.refs) {
        const kind = x.member ? 'member' : x.inList || x.inCall ? 'nested' : bareTop;
        const list = edges.get(x.name);
        if (list === undefined) edges.set(x.name, [{ to, kind }]);
        else list.push({ to, kind });
      }
    };
    const taint = (names: readonly string[]) => {
      for (const n of names) seeds.push([n, 'tainted']);
    };
    for (const tok of tokens) {
      if (tok.kind !== 'stmt') continue;
      if (tok.keyword === 'set') {
        const m = SET_RE.exec(tok.body);
        const r = m ? this.inspect(m[3] as string) : null;
        if (!m || r === null) {
          taint(bindingTargets(tok));
          continue;
        }
        const target = m[1] as string;
        const atoms = atomsOf(r);
        if (m[2] !== undefined) {
          // `{{ ns.x }}` はメンバの出力として通るので、属性へ置く値に危ない部品があれば ns ごと止める。
          if (atoms.length > 0) taint([target]);
          link(r, target, 'nested');
        } else {
          if (atoms.some((a) => a.taint || a.nested)) taint([target]);
          else if (atoms.length > 0) seeds.push([target, 'bound']);
          link(r, target, 'top');
        }
      } else if (tok.keyword === 'for') {
        const head = parseForHeader(tok.body);
        const r = head === null ? null : this.inspect(head.iter);
        if (head === null || r === null) {
          taint(bindingTargets(tok));
          continue;
        }
        // 取り出す要素がそのものになるのは、入れ物の中に置いたときだけ(`for g in [ns]`)。例外は
        // `loop` で、反復でき要素に自分自身を含むので、`taint` の部品として最上位でも伝わる。
        if (atomsOf(r).some((a) => a.taint || a.nested)) taint(head.vars);
        for (const v of head.vars) link(r, v, 'member');
      } else taint(bindingTargets(tok));
    }
    for (let s = seeds.pop(); s !== undefined; s = seeds.pop()) {
      const [name, state] = s;
      const into = state === 'bound' ? this.bound : this.tainted;
      if (into.has(name)) continue;
      into.add(name);
      for (const e of edges.get(name) ?? []) {
        if (state === 'tainted' || e.kind === 'nested') seeds.push([e.to, 'tainted']);
        else if (e.kind === 'top') seeds.push([e.to, 'bound']);
      }
    }
  }

  /** 同じ式を何度も読まないよう、原文で覚える。 */
  private inspect(src: string): JinjaExprInspection | null {
    let r = this.inspected.get(src);
    if (r === undefined) {
      r = inspectInert(src);
      this.inspected.set(src, r);
    }
    return r;
  }

  /**
   * テキストの位置に置いた `tok` が、描画で値のデータに無い `<` を出さず、Python の任意のコードにも
   * 届かないと言えるか。言えなければ false(呼び出し側が単位にする)。
   *
   * 判定するのは描画の出力だけで、**トークンの字面が HTML の走査に与える影響は見ない**。コメントは
   * 何も出力しないので true だが、中身に `<b title=` を書けば、描画前の字面を読む走査器はそこから
   * タグを読み、後ろの `<script>` を属性値として飲み込む。字面の中にタグらしい `<` があるトークンを
   * 単位にするのは呼び出し側(`server/src/security/templateScripts.ts` の `pushJinjaUnits`)の役目。
   */
  isInert(tok: JinjaToken): boolean {
    if (tok.kind === 'comment') return true;
    if (tok.kind === 'stmt') return this.inertStatement(tok);
    const r = this.inspect(tok.body);
    return r !== null && this.safeToOutput(r);
  }

  /**
   * 出力の規則: Python の `str()` で自分から `<` を書く値を出さない。危ない部品(`atomsOf`)を
   * 式のどこにも置かず、束ねた名前をメンバを引かずに使わず、何を引いても出せない名前を使わない
   * (フィルタを通しても、`or` で返しても外す。拾いすぎる側)。
   *
   * データの dict のメソッド名を引いた `{{ fund.items }}` は Python が `<built-in method items of dict
   * object at 0x…>` を出すが、閉じの `>` まで Python が書く固定の綴りで、要素名は `built-in` になり
   * 中身を差し込めないので script にはならない。止めるにはメソッド名の一覧(denylist)が要るので
   * ここでは単位にしない。
   */
  private safeToOutput(r: JinjaExprInspection): boolean {
    if (atomsOf(r).length > 0) return false;
    return !r.refs.some((x) => this.tainted.has(x.name) || (!x.member && this.bound.has(x.name)));
  }

  private inertStatement(tok: JinjaToken): boolean {
    const kw = tok.keyword;
    const body = tok.body;
    if (kw === null) return false;
    if (BARE_KEYWORDS.has(kw)) return body === kw;
    if (kw === 'if' || kw === 'elif') {
      // 条件は何も出力しないので、出力の規則は掛けない。
      return this.inspect(body.slice(kw.length)) !== null;
    }
    if (kw === 'for') {
      // `for … if …` と `recursive` は対象の式の後ろに付き、評価器の文法の外として落ちる。
      const head = parseForHeader(body);
      if (head === null || head.vars.some((v) => v.startsWith('_'))) return false;
      return this.inspect(head.iter) !== null;
    }
    if (kw === 'set') {
      const m = SET_RE.exec(body);
      if (!m) return false; // ブロックの set(`{% set x %}…{% endset %}`)を含む
      const r = this.inspect(m[3] as string);
      if (r === null) return false;
      // 名前への代入は、束ねた名前の出力の側で止める。属性への代入(`set ns.x = …`)は
      // `{{ ns.x }}` がメンバの出力として通るので、右辺に出力の規則を掛ける。
      return m[2] === undefined || this.safeToOutput(r);
    }
    return false;
  }
}

/** 束ねる先ではない語(文の中のキーワードと定数)。 */
const NOT_TARGETS = new Set([
  'in',
  'as',
  'import',
  'with',
  'without',
  'context',
  'recursive',
  'if',
  'else',
  'and',
  'or',
  'not',
  'is',
  'true',
  'false',
  'none',
  'True',
  'False',
  'None',
]);

const IDENT_RE = /[\p{L}_][\p{L}\p{N}_]*/gu;
const QUOTED_RE = /"(?:[^"\\]|\\[\s\S])*"|'(?:[^'\\]|\\[\s\S])*'/g;

/** 文字列リテラルの外にある語。 */
function identifiers(src: string): string[] {
  return [...src.replace(QUOTED_RE, ' ').matchAll(IDENT_RE)]
    .map((m) => m[0])
    .filter((n) => !NOT_TARGETS.has(n));
}

/**
 * 読めない文が束ねうる名前(拾いすぎる側)。`set` は最初の `=` より前(無ければ全部。ブロックの set)、
 * `for` は `in` より前、`with` は `=` の直前の名前、`macro` `call` `import` `from` `do` は文の中の
 * 語すべて(引数・別名・書き換える先)。ほかの文(`include` `filter` など)は名前を束ねない。
 */
function bindingTargets(tok: JinjaToken): string[] {
  const rest = tok.body.slice((tok.keyword ?? '').length);
  switch (tok.keyword) {
    case 'set': {
      const eq = rest.indexOf('=');
      return identifiers(eq < 0 ? rest : rest.slice(0, eq));
    }
    case 'for': {
      const m = /\bin\b/.exec(rest);
      return identifiers(m === null ? rest : rest.slice(0, m.index));
    }
    case 'with':
      return [...rest.matchAll(/([\p{L}_][\p{L}\p{N}_]*)\s*=(?!=)/gu)].map((m) => m[1] as string);
    case 'macro':
    case 'call':
    case 'import':
    case 'from':
    case 'do':
      return identifiers(rest);
    default:
      return [];
  }
}
