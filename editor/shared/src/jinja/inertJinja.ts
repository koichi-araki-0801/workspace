// =============================================================================
// inertJinja.ts — テキストの位置に置いても実行面を生まない Jinja トークンの判定
// =============================================================================
// テンプレの不変ゲート(`server/src/security/templateScripts.ts`)は、テキストの位置の Jinja の
// うち、ここで不活性と言えないものを単位にして基準と突き合わせる。判定は許可リストで書く。
// 危ない形を数え上げる向きでは、`{{ "<"|safe }}`・`{% set lt %}<{% endset %}` のような形が
// 数え切れないため(設計正典の却下済み設計「描画で生まれる実行面を、危ない形の数え上げで単位にする」)。
//
// 根拠は**本番の Python Jinja2 の出力**で考える。本番の描画器の設定は分からないので、autoescape
// 無し・sandbox 無しを前提にする。テキストの位置で守るのは次の 2 つだけである。
//   1. 値のデータに無い `<` を出さないこと(リテラルの原文の文字を制限する)
//   2. Python の任意のコードに届かないこと(`_` で始まる名前・メンバを禁じる。sandbox と同じ決まり)
// 属性値の中と CSS の中の Jinja は、ここを通さず形を問わず単位にする(呼び出し側の規則)。
// 属性値の中では、許可した文字だけのリテラル(`'javascript'`)も後ろの地の `:` とつながるため。
//
// この版は評価器の文法で式を確かめない。式の字面からリテラルと名前を拾い、出力の規則も字面で
// 判定する(拾いすぎる側)。

import { parseForHeader } from './fillRender.js';
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
 * 出力すると Python の `str()` が自分から `<` を書く値を返すフィルタ・関数。`select` 系・`batch`・
 * `slice` はジェネレータを返し `<generator object …>` に、`namespace` は `<Namespace {…}>` に
 * なる(中身にリテラル・データが入る)。`for` の対象と `if` の条件では使ってよい(出力しないので)。
 */
const GENERATOR_NAMES = new Set(['select', 'reject', 'selectattr', 'rejectattr', 'batch', 'slice']);

interface ExprWord {
  name: string;
  /** 直前が `.`(メンバ名)か。 */
  member: boolean;
  /** 直後(空白を飛ばして)の文字。 */
  next: string;
}

interface ExprScan {
  ok: boolean;
  words: ExprWord[];
}

/**
 * 式の字面からリテラルと名前を拾う。リテラルの原文が許可した文字の外にあるか、名前・メンバ名が
 * `_` で始まるか、引用符が閉じなければ `ok:false`。
 */
function scanExpr(src: string): ExprScan {
  const words: ExprWord[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i] as string;
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== c) j += src[j] === '\\' ? 2 : 1;
      if (j >= n) return { ok: false, words };
      if (!LITERAL_CHAR_RE.test(src.slice(i + 1, j))) return { ok: false, words };
      i = j + 1;
      continue;
    }
    if (/[0-9]/.test(c)) {
      while (i < n && /[0-9A-Za-z_.]/.test(src[i] as string)) i++;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const start = i;
      while (i < n && /\w/.test(src[i] as string)) i++;
      const name = src.slice(start, i);
      if (name.startsWith('_')) return { ok: false, words };
      let b = start - 1;
      while (b >= 0 && /\s/.test(src[b] as string)) b--;
      let a = i;
      while (a < n && /\s/.test(src[a] as string)) a++;
      words.push({ name, member: src[b] === '.', next: src[a] ?? '' });
      continue;
    }
    i++;
  }
  return { ok: true, words };
}

/** 式が不活性か(リテラルの文字と名前の決まりだけを見る)。空の式は不活性ではない。 */
function inertExpr(src: string): ExprScan | null {
  if (src.trim() === '') return null;
  const scan = scanExpr(src);
  return scan.ok ? scan : null;
}

/** `namespace(…)` の呼び出しを含むか。 */
function callsNamespace(words: readonly ExprWord[]): boolean {
  return words.some((w) => !w.member && w.name === 'namespace' && w.next === '(');
}

/**
 * 出力の規則: Python の `str()` で自分から `<` を書く値を出さない。`namespace(…)`・`select` 系・
 * `batch`・`slice` の結果と、裸の `loop`(`<LoopContext …>`)を外す。
 *
 * データの dict のメソッド名を引いた `{{ fund.items }}` は Python が `<built-in method items of dict
 * object at 0x…>` を出すが、閉じの `>` まで Python が書く固定の綴りで、要素名は `built-in` になり
 * 中身を差し込めないので script にはならない。止めるにはメソッド名の一覧(denylist)が要るので
 * ここでは単位にしない。
 */
function safeToOutput(words: readonly ExprWord[]): boolean {
  if (callsNamespace(words)) return false;
  if (words.some((w) => GENERATOR_NAMES.has(w.name))) return false;
  return !words.some((w) => !w.member && w.name === 'loop' && w.next !== '.' && w.next !== '[');
}

const SET_RE = /^set\s+[A-Za-z]\w*(?:\.[A-Za-z]\w*)?\s*=([\s\S]*)$/;

function inertStatement(tok: JinjaToken): boolean {
  const kw = tok.keyword;
  const body = tok.body;
  if (kw === null) return false;
  if (BARE_KEYWORDS.has(kw)) return body === kw;
  if (kw === 'if' || kw === 'elif') {
    // 条件は何も出力しないので、出力の規則は掛けない。
    return inertExpr(body.slice(kw.length)) !== null;
  }
  if (kw === 'for') {
    const head = parseForHeader(body);
    if (head === null || head.vars.some((v) => v.startsWith('_'))) return false;
    const scan = inertExpr(head.iter);
    // `for … if …` と `recursive` は対象の式の後ろに付く。字面で見つけたら外す。
    return scan !== null && !scan.words.some((w) => w.name === 'if' || w.name === 'recursive');
  }
  if (kw === 'set') {
    const m = SET_RE.exec(body);
    if (!m) return false; // ブロックの set(`{% set x %}…{% endset %}`)を含む
    const scan = inertExpr(m[1] as string);
    // 束ねた名前の追跡を持たない間は、`namespace` を束ねる文そのものを外す。束ねた名前を
    // `{{ ns }}` と出すと `<Namespace {…}>` になるため(基準にあれば通る)。
    return scan !== null && !callsNamespace(scan.words);
  }
  return false;
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
export function isInertJinjaToken(tok: JinjaToken): boolean {
  if (tok.kind === 'comment') return true;
  if (tok.kind === 'stmt') return inertStatement(tok);
  const scan = inertExpr(tok.body);
  return scan !== null && safeToOutput(scan.words);
}
