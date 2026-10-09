// =============================================================================
// cssRules.ts — CSS を「規則」単位に分け、承認で変わった規則だけをペア側へ当てる
// =============================================================================
// ペア同期(交付版⇄全体版)の CSS 転写に使う。CSS はテンプレ単位のファイルで、版種ごとに手で
// 直した規則が混ざるため、ファイル丸ごとの上書きはできない。base(承認前)→ next(承認後)で
// 変わった規則だけを見て、ペア側(target)の同じ規則が base のままなら当て、違えば競合にする。
// 承認の CSS は GrapesJS が書き直した形で届くので、ペア同期は変更の検出(baseline → next)と
// ペア側の照合(原文の base と target)を分ける `mergeCssRuleChangesFromBaseline` を使う。
//
// 字句は `collectCssStructure`(外部参照検査と同じ走査器)から取る。別の正規表現で `{` `}` を
// 数えると、文字列やコメントに入った括弧で検査と分割の解釈が割れる。新しい依存(postcss 等)は
// 足さない — 遮断端末への配布物が増えるため。
//
// 規則のキーは「外側の入れ子 at-rule の前置きの並び + セレクタ」を JSON 配列にした文字列。
// `@page` は前置き(`@page` / `@page :first` / `@page cover`)で、`@font-face` は `font-family` +
// `font-weight` + `font-style` の値で見分ける(中身をキーにすると、版種固有に直した規則への変更が
// 「削除 + 追加」になり、競合にならず後ろへ追記されて勝ってしまうため)。それ以外のセレクタを
// 持たない規則は中身全体で見分ける。
//
// GrapesJS はセレクタと media の文字列をブラウザの CSSOM(`selectorText` / `mediaText`)から取る。
// ブラウザは `.a>.b` を `.a > .b`、`:before` を `::before` のように書き直すので、原文と書き出しで
// キーが割れないよう、意味の変わらない書き方の違いだけをそろえる。セレクタでは、コメントを消し
// (`.a/**/.b` は `.a.b` と同じ)、結合子 `>` `+` `~` と `(` `)` の内側の空白を消し、旧式の擬似要素
// 4 つを `::` にし、型セレクタ・擬似クラスと擬似要素の名前・属性名を小文字にし、属性値を
// `[src="x"]` の形にする。at-rule の前置きでは、コメントを空白にし、名前を小文字にし、`@media` は
// 文字列の外を小文字にし、`@media` `@supports` `@container` は `:` の後ろと括弧の内側の空白を消す。
// `@page` は `@page` + 空白 1 つ + ページセレクタの形にする。クラス名・id・属性値・文字列・
// エスケープした文字・`@container` や `@layer` の名前は大文字小文字を区別するので変えない(別の
// 規則を同じキーに畳むと、無関係な規則へ変更が当たる)。入れ子の前置き(`atRules`)も同じ形に
// そろえ、追加の規則を包むときはその形のまま書き出す(どれも有効な CSS の形)。
//
// 同じキーが複数あれば `splitCssRules` は出現順の番号を
// 足す。`mergeCssRuleChangesFromBaseline` は同じキーの重複を 1 つの規則として識別し(出現番号を
// 付けない)、その中の出現を前から対応づける。GrapesJS は重複を別々の規則のまま持ち、宣言が空に
// なった規則だけを `getCss` に出さない(スタイルの編集は同じセレクタの最後の規則に入るので、
// 消えるのも最後の規則)。そこで空の出現を外したうえで、変更の判定・ペア側が手つかずかの判定・
// 当てる処理をすべて出現ごとに行う。ペア側の出現の形が原文と違う(宣言の配り方が違う・まとめて
// ある・重複が多い)ときは対応が取れないので競合にする — 1 本にまとめて当てると、間にある別の
// 規則とのカスケードがどこに置いても崩れうるため。
// 規則の間のコメントはどの規則にも属さず、同期の対象にならない。
//
// GrapesJS はセレクタの並び(`.a, .b{…}`)を 1 セレクタ 1 規則に分けて持つ(`.a{…}` `.b{…}`)。
// キーの正規化だけでは原文と突き合わせられないので、照合の経路(`folded` / `asIs`)では 4 つの
// CSS とも並びを 1 セレクタずつの「見かけの規則」に展開する。見かけの規則は物理の規則の位置を
// 共有し、並びの順に並ぶので、同じキーの出現は物理と見かけを区別せずに位置の順で数えられる
// (GrapesJS の書き出しの順と同じ)。公開の `splitCssRules` は展開しない(canvas へ流す CSS は
// 原文の規則のまま扱う)。
//
// ペア側への書き戻しは物理の規則ごとに 1 回にまとめる。並びのセレクタが全部同じ変更なら並びの
// まま本文だけを置き換え(原文のセレクタの書き方を残す)、全部消えたら規則ごと消す。片方だけが
// 変わった・消えたときは、元の規則の位置で 1 セレクタ 1 規則に分け、変わらないセレクタには原文の
// 宣言を残す。並びのまま新しい本文を当てると変えていないセレクタまで変わり、末尾へ書き足すと
// ほかの規則とのカスケードの順が変わるため。

import { collectCssStructure } from '../security/cssExternalRefs.js';

/**
 * CSS の 1 規則。`start`〜`end` は規則本体の原文範囲で、囲む at-rule の前置き・手前のコメントと
 * 空白を含まない。
 */
export interface CssRule {
  /** `JSON.stringify([...atRules, 識別子(, 出現番号)])`。 */
  key: string;
  /** 規則を囲む入れ子 at-rule の前置き(正規化済み。外側から順。最上位なら [])。例 `['@media print']`。 */
  atRules: string[];
  /** 規則本体の原文(`sel{…}` / `@font-face{…}` / `@charset "x";`。`css.slice(start, end)`)。 */
  text: string;
  start: number;
  end: number;
}

/** `mergeCssRuleChanges` の結果。`applied` と `conflicts` はキーの列。 */
export interface CssMergeResult {
  css: string;
  applied: string[];
  conflicts: string[];
  /**
   * baseline にあるのに原文(rawBase)と突き合わせられず、当てなかった変更・削除のキー。`conflicts`
   * (ペア側が版種固有に直してある)とは扱いが違うので分ける。`mergeCssRuleChanges` では常に空。
   */
  unmatched: string[];
}

/** 子の規則を持つ(中へ降りる)at-rule。ここに無い at-rule のブロックは中身ごと 1 規則にする。 */
const GROUPING_AT_RULES = new Set([
  'media',
  'supports',
  'layer',
  'container',
  'document',
  '-moz-document',
  'scope',
  'starting-style',
]);

/** 前置きが at-keyword だけの形(`@font-face` `@page`)。 */
const BARE_AT_KEYWORD_RE = /^@[-\w\\]+$/;

/** 規則本体(正規化済み)から宣言 `prop` の値を取る(引用符は外す)。無ければ空。 */
function descriptor(body: string, prop: string): string {
  const m = new RegExp(`(?:^|[{;])\\s*${prop}\\s*:\\s*([^;}]*)`, 'i').exec(body);
  return (m?.[1] ?? '')
    .trim()
    .replace(/^(["'])(.*)\1$/, '$2')
    .toLowerCase();
}

interface ScannedRule extends CssRule {
  /** `atRules` を比較用に文字列にしたもの。 */
  chainKey: string;
  /** 出現番号を付けないキー(同じ規則の重複で共通)。 */
  group: string;
  /**
   * ブロックの前置きの原文(`.a ` の末尾空白を除いたもの。エスケープした空白 `.a\ ` は残す)。
   * ブロックを持たない文は空。
   */
  head: string;
  /** ブロックの原文(`{` から `}` まで)。ブロックを持たない文は空。 */
  body: string;
  /** 宣言の並び(正規化済み)。ブロックを持たない文と、中に入れ子のブロックを持つ規則は undefined。 */
  decls: string[] | undefined;
  /**
   * セレクタの並びを展開した見かけの規則なら、元の物理の規則の `start`。`start`/`end` は物理の
   * 規則全体を指し、`text` と `head` はこのセレクタ(原文の書き方)+ 原文の本文になる。
   */
  listOf?: number;
  /** 見かけの規則の、並びの中の番号(0 始まり)。 */
  listIndex?: number;
}

/**
 * 規則の比較と書き換えの単位。`parts` が原文の出現(原文の順)で、`start`/`end` は最後の出現
 * (追加の挿入位置の基準)を指す。`text` は重複を畳んだ本文で、`foldedCssRuleTexts` にだけ使う。
 */
interface MergeRule extends ScannedRule {
  parts: ScannedRule[];
}

/**
 * セレクタの属性値の書き方を、ブラウザの書き出し(`[src="x"]`)にそろえる。GrapesJS はセレクタを
 * ブラウザに解かせて書き出すので、原文の `[src=x]` `[src='x']` と同じキーにするため。
 */
function canonicalAttrQuotes(sel: string): string {
  let out = '';
  let inAttr = false;
  let i = 0;
  while (i < sel.length) {
    const c = sel[i];
    if (c === '\\' && !(inAttr && out.at(-1) === '=')) {
      out += sel.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (!inAttr) {
      if (c === '[') inAttr = true;
      out += c;
      i++;
      continue;
    }
    if (c === ']') {
      inAttr = false;
      out += c;
      i++;
      continue;
    }
    if (c === ' ') {
      const prev = out.at(-1) ?? '';
      if (prev === '[' || prev === '=' || /[\]=~|^$*]/.test(sel[i + 1] ?? '')) {
        i++;
        continue;
      }
      out += c;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || out.at(-1) === '=') {
      const quoted = c === '"' || c === "'";
      const { value, next } = readAttrValue(sel, quoted ? i + 1 : i, quoted ? c : undefined);
      out += `"${value.replace(/["\\]/g, '\\$&')}"`;
      i = quoted ? next + 1 : next;
      // 大文字小文字の指定(`i` / `s`)はブラウザが `[x="y" i]` と空白を挟んだ小文字で書き出す。
      const flag = /^ ?([is])(?= ?\])/i.exec(sel.slice(i));
      if (flag !== null) {
        out += ` ${flag[1].toLowerCase()}`;
        i += flag[0].length;
      } else if (/[a-z]/i.test(sel[i] ?? '')) out += ' ';
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * 属性値を `from` から読み、エスケープを解いた値と終わりの位置を返す。引用符つきは `quote` の
 * 手前まで、引用符なしは空白か `]` の手前まで。
 *
 * エスケープの解き方は `security/cssExternalRefs.ts` の `readEscape` と似るが統合しない。
 * サロゲートの扱い(こちらは U+FFFD、あちらはそのまま)と空白の定義が違い、出力が変わる。
 */
function readAttrValue(
  sel: string,
  from: number,
  quote: string | undefined,
): { value: string; next: number } {
  let value = '';
  let k = from;
  while (k < sel.length) {
    const ch = sel[k];
    if (quote !== undefined ? ch === quote : ch === ' ' || ch === ']') break;
    if (ch === '\\' && k + 1 < sel.length) {
      const hex = /^[0-9a-f]{1,6}/i.exec(sel.slice(k + 1, k + 7))?.[0];
      if (hex === undefined) {
        value += sel[k + 1];
        k += 2;
        continue;
      }
      const cp = Number.parseInt(hex, 16);
      // 0・サロゲート・範囲外は U+FFFD(CSS Syntax の escaped code point)。
      const invalid = cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff);
      value += invalid ? '\ufffd' : String.fromCodePoint(cp);
      k += 1 + hex.length;
      if (sel[k] === ' ') k++;
      continue;
    }
    value += ch;
    k++;
  }
  return { value, next: k };
}

/** 識別子を作る文字(エスケープを除く)。非 ASCII も識別子の一部。 */
const IDENT_CHAR_RE = /[-\w\u0080-￿]/;

/** 単一の `:` でも書ける旧式の擬似要素。ブラウザは `::` で書き出す。 */
const LEGACY_PSEUDO_ELEMENTS = new Set(['before', 'after', 'first-line', 'first-letter']);

/** `s[k]` の `\` から始まるエスケープの長さ。16 進の後ろの空白 1 つ(CRLF も 1 つ)を含む。 */
function escapeLength(s: string, k: number): number {
  const hex = /^[0-9a-f]{1,6}/i.exec(s.slice(k + 1, k + 7))?.[0];
  if (hex === undefined) return Math.min(2, s.length - k);
  const after = k + 1 + hex.length;
  if (s.startsWith('\r\n', after)) return 1 + hex.length + 2;
  return 1 + hex.length + (/\s/.test(s[after] ?? '') ? 1 : 0);
}

/** `s[k]` の引用符から始まる文字列の終わり(閉じ引用符の次。閉じていなければ末尾)。 */
function stringEnd(s: string, k: number): number {
  const quote = s[k];
  let j = k + 1;
  while (j < s.length && s[j] !== quote) j += s[j] === '\\' ? escapeLength(s, j) : 1;
  return Math.min(j + 1, s.length);
}

/**
 * `s` の `k` から識別子を読む。`lower` ならエスケープの外を小文字にする(エスケープした文字は
 * 書いた字のまま意味を持つので触らない)。
 */
function readIdent(s: string, k: number, lower: boolean): { ident: string; next: number } {
  let ident = '';
  let j = k;
  while (j < s.length) {
    if (s[j] === '\\') {
      const n = escapeLength(s, j);
      ident += s.slice(j, j + n);
      j += n;
      continue;
    }
    if (!IDENT_CHAR_RE.test(s[j])) break;
    ident += lower ? s[j].toLowerCase() : s[j];
    j++;
  }
  return { ident, next: j };
}

/** `[…]` の属性名を小文字にする(HTML の属性名は大文字小文字を区別しない)。値はそのまま。 */
function lowerAttrName(attr: string): string {
  let out = '[';
  let j = 1;
  while (j < attr.length) {
    const c = attr[j];
    if (c === '\\') {
      const n = escapeLength(attr, j);
      out += attr.slice(j, j + n);
      j += n;
      continue;
    }
    if ('=~^$*]'.includes(c) || (c === '|' && attr[j + 1] === '=')) break;
    out += c.toLowerCase();
    j++;
  }
  return out + attr.slice(j);
}

const NTH_PSEUDOS = new Set(['nth-child', 'nth-last-child', 'nth-of-type', 'nth-last-of-type']);
const AN_PLUS_B_RE = /^([+-]?\d*)n\s*(?:([+-])\s*(\d+))?$/;

/** `An+B` を CSSOM の書き方へ直す(`a` が 0 なら `b` だけ、`a` が ±1 なら係数を省く)。 */
function canonicalAnPlusB(arg: string): string | undefined {
  if (arg === 'even') return '2n';
  if (arg === 'odd') return '2n+1';
  if (/^[+-]?\d+$/.test(arg)) return String(Number(arg));
  const m = AN_PLUS_B_RE.exec(arg);
  if (m === null) return undefined;
  const a = m[1] === '' || m[1] === '+' ? 1 : m[1] === '-' ? -1 : Number(m[1]);
  const b = m[3] === undefined ? 0 : Number(m[3]) * (m[2] === '-' ? -1 : 1);
  if (a === 0) return String(b);
  const coef = a === 1 ? '' : a === -1 ? '-' : String(a);
  return `${coef}n${b === 0 ? '' : b > 0 ? `+${b}` : String(b)}`;
}

/** `:nth-*()` の括弧の中身。`An+B` に、`nth-child` 系は ` of <セレクタ>` が続きうる。 */
function canonicalNthArg(raw: string): string | undefined {
  const text = raw.trim().toLowerCase();
  const of = /\s+of\s+/.exec(text);
  if (of === null) return canonicalAnPlusB(text);
  const nth = canonicalAnPlusB(text.slice(0, of.index));
  if (nth === undefined) return undefined;
  const rest = raw.trim().slice(of.index + of[0].length);
  return `${nth} of ${canonicalSelector(rest.trim())}`;
}

/**
 * 引数を大文字小文字を区別しない形で読む関数型の擬似クラス・擬似要素(引数がセレクタか
 * `an+b`・言語・方向)。ここに無い関数の引数は名前などで、大文字小文字を区別する。
 */
const CASELESS_ARG_PSEUDOS = new Set([
  'is',
  'not',
  'has',
  'where',
  'matches',
  '-webkit-any',
  'nth-child',
  'nth-last-child',
  'nth-of-type',
  'nth-last-of-type',
  'slotted',
  'host',
  'host-context',
  'lang',
  'dir',
]);

/** `s[k]` の `(` に対応する `)` の次の位置(文字列・エスケープ・入れ子を考慮。無ければ末尾)。 */
function parenEnd(s: string, k: number): number {
  let depth = 0;
  let j = k;
  while (j < s.length) {
    const c = s[j];
    if (c === '"' || c === "'") {
      j = stringEnd(s, j);
      continue;
    }
    if (c === '\\') {
      j += escapeLength(s, j);
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return j + 1;
    j++;
  }
  return s.length;
}

/**
 * セレクタ(空白を畳み、コメントを消したもの)を、ブラウザの書き出しと同じキーになる形にする。
 * 文字列・`[…]` の中身・エスケープは結合子や小文字化の対象から外す。
 */
function canonicalSelector(sel: string): string {
  let out = '';
  let i = 0;
  // 複合セレクタの先頭か(文頭・結合子・`,`・`(` の直後)。ここで始まる識別子は型セレクタ。
  let boundary = true;
  // 読み飛ばした空白。次の字が結合子・`)`・`,` なら捨て、それ以外なら子孫結合子として出す。
  let pendingSpace = false;
  const emit = (text: string, nextBoundary: boolean): void => {
    if (pendingSpace) out += ' ';
    pendingSpace = false;
    out += text;
    boundary = nextBoundary;
  };
  while (i < sel.length) {
    const c = sel[i];
    if (c === ' ') {
      // 空白(子孫結合子)の後ろも複合セレクタの先頭。16 進エスケープの後ろの空白は
      // `escapeLength` が食うのでここへは来ない。
      if (!boundary) pendingSpace = true;
      boundary = true;
      i++;
      continue;
    }
    if ('>+~,)'.includes(c)) {
      pendingSpace = false;
      out += c;
      boundary = c !== ')';
      i++;
      continue;
    }
    if (c === '(') {
      emit(c, true);
      i++;
      continue;
    }
    if (c === '\\') {
      const n = escapeLength(sel, i);
      emit(sel.slice(i, i + n), false);
      i += n;
      continue;
    }
    if (c === '"' || c === "'") {
      const end = stringEnd(sel, i);
      emit(sel.slice(i, end), false);
      i = end;
      continue;
    }
    if (c === '[') {
      let j = i + 1;
      while (j < sel.length && sel[j] !== ']') {
        if (sel[j] === '"' || sel[j] === "'") j = stringEnd(sel, j);
        else j += sel[j] === '\\' ? escapeLength(sel, j) : 1;
      }
      const end = Math.min(j + 1, sel.length);
      emit(lowerAttrName(sel.slice(i, end)), false);
      i = end;
      continue;
    }
    if (c === ':') {
      const double = sel[i + 1] === ':';
      const { ident, next } = readIdent(sel, i + (double ? 2 : 1), true);
      emit(`${double || LEGACY_PSEUDO_ELEMENTS.has(ident) ? '::' : ':'}${ident}`, false);
      i = next;
      if (sel[i] === '(' && NTH_PSEUDOS.has(ident)) {
        // ブラウザは `even` `odd` や `+n` `2n+0` などの書き方を CSSOM の形へ書き直す。同じ並びなので
        // 原文側も寄せる。An+B として読めない引数は触らない。
        const end = parenEnd(sel, i);
        if (sel[end - 1] === ')') {
          const folded = canonicalNthArg(sel.slice(i + 1, end - 1));
          if (folded !== undefined) {
            out += `(${folded})`;
            i = end;
            boundary = false;
            continue;
          }
        }
      }
      if (sel[i] === '(' && !CASELESS_ARG_PSEUDOS.has(ident)) {
        // 引数がセレクタでない関数(`::part()` `:state()` など)の名前は大文字小文字を区別するので、
        // 括弧の内側の空白を詰めるだけで中身はそのまま出す。
        const end = parenEnd(sel, i);
        const inner = sel.slice(i + 1, sel[end - 1] === ')' ? end - 1 : end).trim();
        emit(`(${inner}${sel[end - 1] === ')' ? ')' : ''}`, false);
        i = end;
      }
      continue;
    }
    if (c === '.' || c === '#') {
      const { ident, next } = readIdent(sel, i + 1, false);
      emit(c + ident, false);
      i = next;
      continue;
    }
    if (boundary && IDENT_CHAR_RE.test(c)) {
      const { ident, next } = readIdent(sel, i, true);
      emit(ident, false);
      i = next;
      continue;
    }
    emit(c, false);
    i++;
  }
  return canonicalAttrQuotes(out);
}

/** at-rule の名前(`@media` など。エスケープを含む)を前置きの先頭から取る。 */
const AT_KEYWORD_RE = /^@(?:[-\w\u0080-￿]|\\[\s\S])+/;

/** `@media` `@supports` `@container` は条件の書き方(空白)をブラウザが詰めて書き出す。 */
const CONDITION_AT_RULES = new Set(['media', 'supports', 'container']);

/**
 * at-rule の前置き(空白を畳み、コメントを空白にしたもの)をキーの形にする。名前は小文字にし、
 * 条件を持つ at-rule は `:` の後ろと括弧の内側の空白を消す。`@media` だけは文字列の外を全部
 * 小文字にする(メディアクエリは大文字小文字を区別しない。`@container` の名前などは区別する)。
 */
function canonicalAtPrelude(prelude: string, name: string): string {
  const keyword = AT_KEYWORD_RE.exec(prelude)?.[0] ?? '';
  const rest = prelude.slice(keyword.length).trim();
  const head = keyword.toLowerCase();
  if (!CONDITION_AT_RULES.has(name)) return rest === '' ? head : `${head} ${rest}`;
  let out = '';
  let i = 0;
  // 直前に出したのが `:` か `(`(エスケープの一部でない)か。後ろの空白を捨てる。
  let dropSpace = false;
  while (i < rest.length) {
    const c = rest[i];
    if (c === '"' || c === "'" || c === '\\') {
      const end = c === '\\' ? i + escapeLength(rest, i) : stringEnd(rest, i);
      out += rest.slice(i, end);
      i = end;
      dropSpace = false;
      continue;
    }
    if (c === ' ' && (dropSpace || rest[i + 1] === ')')) {
      i++;
      continue;
    }
    out += name === 'media' ? c.toLowerCase() : c;
    dropSpace = c === ':' || c === '(';
    i++;
  }
  return out === '' ? head : `${head} ${out}`;
}

/** `@page` の前置きを `@page` か `@page <ページセレクタ>` にする(ページ名は大文字小文字を残す)。 */
function canonicalPagePrelude(prelude: string): string {
  const keyword = AT_KEYWORD_RE.exec(prelude)?.[0] ?? '';
  const sel = prelude
    .slice(keyword.length)
    .trim()
    .replace(/\s+(?=:)/g, '')
    .replace(/(?<!\\):([-\w]+)/g, (_m, pseudo: string) => `:${pseudo.toLowerCase()}`);
  return sel === '' ? '@page' : `@page ${sel}`;
}

/**
 * 文字列の外だけ、空白の連続を 1 つにし、`,` の前後の空白を消し、前後を詰める。文字列の中の
 * 空白や `,` は値の一部(`[title="a , b"]` と `[title="a,b"]` は別のセレクタ)。属性値に空白を
 * 含めるには引用符が要るので、`[…]` の中も文字列だけ守れば足りる。
 */
function collapseOutsideStrings(s: string): string {
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '"' || c === "'" || c === '\\') {
      const end = c === '\\' ? i + escapeLength(s, i) : stringEnd(s, i);
      out += s.slice(i, end);
      i = end;
      continue;
    }
    if (/\s/.test(c) || c === ',') {
      let j = i;
      let comma = false;
      while (j < s.length && (/\s/.test(s[j]) || (s[j] === ',' && !comma))) {
        if (s[j] === ',') comma = true;
        j++;
      }
      out += comma ? ',' : ' ';
      i = j;
      continue;
    }
    out += c;
    i++;
  }
  return out.trim();
}

/**
 * `css` の `[from, to)` でコメントと空白を除いた最初の文字の位置。無ければ undefined。
 * `commentEnd` はコメントの開始位置 → 終わりの位置(`collectCssStructure` の `comments` から作る)で、
 * コメントの途中から始めないこと。規則や at-rule の頭(`atRules` のキー)を引くのに使う。
 */
export function firstSignificant(
  css: string,
  commentEnd: ReadonlyMap<number, number>,
  from: number,
  to: number,
): number | undefined {
  let k = from;
  while (k < to) {
    const skip = commentEnd.get(k);
    if (skip !== undefined) {
      k = skip;
      continue;
    }
    if (!/\s/.test(css[k])) return k;
    k++;
  }
  return undefined;
}

/**
 * `s` の `[from, to)` を括弧・`[…]`・文字列・エスケープの外の `,` で分けた範囲の列。`commentEnd`
 * (コメントの開始位置 → 終わり)を渡すと、コメントの中の `,` も分けない。
 */
function topLevelCommaSegments(
  s: string,
  from: number,
  to: number,
  commentEnd?: ReadonlyMap<number, number>,
): Array<[number, number]> {
  const segments: Array<[number, number]> = [];
  let segFrom = from;
  let depth = 0;
  let k = from;
  while (k < to) {
    const skip = commentEnd?.get(k);
    if (skip !== undefined) {
      k = skip;
      continue;
    }
    const c = s[k];
    if (c === '"' || c === "'") {
      k = stringEnd(s, k);
      continue;
    }
    if (c === '\\') {
      k += escapeLength(s, k);
      continue;
    }
    if (c === '(' || c === '[') depth++;
    else if ((c === ')' || c === ']') && depth > 0) depth--;
    else if (c === ',' && depth === 0) {
      segments.push([segFrom, k]);
      segFrom = k + 1;
    }
    k++;
  }
  segments.push([segFrom, to]);
  return segments;
}

/**
 * 原文を規則へ分ける(キーと入れ子の情報つき)。`expandLists` なら、宣言だけを持つ規則のセレクタの
 * 並びを 1 セレクタずつの見かけの規則に展開する(照合の経路だけが立てる)。
 */
function scanCssRules(css: string, expandLists = false): ScannedRule[] {
  const { punct, comments, atRules } = collectCssStructure(css);
  const commentEnd = new Map(comments.map((c) => [c.start, c.end]));

  /** `[from, to)` でコメントと空白を除いた最初の文字の位置。無ければ undefined。 */
  const significantAt = (from: number, to: number): number | undefined =>
    firstSignificant(css, commentEnd, from, to);

  /**
   * `[from, to)` のコメントを `commentAs` に置き換え、空白を畳み、`,` の前後の空白を消す(キー用)。
   * セレクタではコメントは区切りにならない(`.a` と `.b` の間のコメントは子孫結合子でなく、
   * `.a.b` と同じ)ので空文字、at-rule の前置きや
   * 宣言では区切りとして働くので空白にする。
   */
  const normalize = (from: number, to: number, commentAs: ' ' | '' = ' '): string => {
    let out = '';
    let k = from;
    while (k < to) {
      const skip = commentEnd.get(k);
      if (skip !== undefined) {
        out += commentAs;
        k = skip;
        continue;
      }
      out += css[k];
      k++;
    }
    // `\` + 改行は文字列の行の継続で、文字ごと消える。空白へ畳む前に消す(`\\` は残す)。
    return collapseOutsideStrings(
      out.replace(/\\(\r\n|[\n\r\f]|[\s\S])/g, (m, c: string) => (/^[\r\n\f]/.test(c) ? '' : m)),
    );
  };

  /**
   * `[from, to)` の末尾の空白を除いた終わりの位置。エスケープ(`\ ` と 16 進の後ろの空白)・
   * 文字列・コメントの中の空白は前置きの一部なので除かない(除くと `.a\ ` が `.a\` になり、
   * 後ろに `{` を書いたとき `\{` と読まれる)。
   */
  const trimmedEnd = (from: number, to: number): number => {
    let last = from;
    let k = from;
    while (k < to) {
      const skip = commentEnd.get(k);
      const c = css[k];
      if (skip !== undefined) k = skip;
      else if (c === '"' || c === "'") k = stringEnd(css, k);
      else if (c === '\\') k += escapeLength(css, k);
      else if (/\s/.test(c)) {
        k++;
        continue;
      } else k++;
      last = Math.min(k, to);
    }
    return last;
  };

  /**
   * `[from, to)` を括弧・`[…]`・文字列・コメント・エスケープの外の `,` で分けた範囲の列。
   * `:is(.a, .b)` や `[title="a,b"]` の `,` はセレクタの一部なので分けない。
   */
  const listSegments = (from: number, to: number): Array<[number, number]> =>
    topLevelCommaSegments(css, from, to, commentEnd);

  /**
   * セレクタの並び `[start, at)` を 1 セレクタずつ(正規化したキーと原文の書き方)にする。並びで
   * ない・空のセレクタがある・同じキーが 2 つある並びは展開しない(undefined)。同じキーが並びの
   * 中に 2 つあると、1 つの物理の規則の中で出現を分けて当てられないため、並びのキーのまま残す。
   */
  const expandList = (
    start: number,
    at: number,
  ): Array<{ identity: string; head: string }> | undefined => {
    const segments = listSegments(start, at);
    if (segments.length < 2) return undefined;
    const items = segments.map(([a, b]) => {
      const from = significantAt(a, b) ?? b;
      return {
        identity: canonicalSelector(normalize(from, b, '')),
        head: css.slice(from, trimmedEnd(from, b)),
      };
    });
    const identities = new Set(items.map((x) => x.identity));
    if (identities.has('') || identities.size !== items.length) return undefined;
    return items;
  };

  const found: Array<{
    chain: string[];
    identity: string;
    start: number;
    end: number;
    head: string;
    body: string;
    decls: string[] | undefined;
    /** 見かけの規則の本文(物理の規則は `css.slice(start, end)`)。 */
    text?: string;
    listIndex?: number;
  }> = [];
  const chain: string[] = [];
  let segStart = 0;
  let i = 0;
  while (i < punct.length) {
    const { ch, at } = punct[i];
    if (ch === '{') {
      const start = significantAt(segStart, at) ?? at;
      const name = atRules.get(start)?.toLowerCase();
      const prelude =
        name === undefined
          ? canonicalSelector(normalize(start, at, ''))
          : name === 'page'
            ? canonicalPagePrelude(normalize(start, at))
            : canonicalAtPrelude(normalize(start, at), name);
      if (name !== undefined && GROUPING_AT_RULES.has(name)) {
        chain.push(prelude);
        segStart = at + 1;
        i++;
        continue;
      }
      // 葉のブロック: 対応する `}` まで中身ごと 1 規則にする(入れ子のブロックへは降りない)。
      let depth = 1;
      let j = i + 1;
      let nested = false;
      const semis: number[] = [];
      for (; j < punct.length && depth > 0; j++) {
        if (punct[j].ch === '{') {
          depth++;
          nested = true;
        } else if (punct[j].ch === '}') depth--;
        else if (depth === 1) semis.push(punct[j].at);
      }
      const closeAt = depth === 0 ? punct[j - 1].at : css.length;
      const end = depth === 0 ? closeAt + 1 : css.length;
      let decls: string[] | undefined;
      if (!nested) {
        decls = [];
        let from = at + 1;
        for (const to of [...semis, closeAt]) {
          const d = normalize(from, to);
          if (d !== '') decls.push(d);
          from = to + 1;
        }
      }
      const list =
        expandLists && name === undefined && decls !== undefined
          ? expandList(start, at)
          : undefined;
      if (list !== undefined) {
        const body = css.slice(at, end);
        list.forEach(({ identity, head }, listIndex) => {
          found.push({
            chain: [...chain],
            identity,
            start,
            end,
            head,
            body,
            decls,
            text: head + body,
            listIndex,
          });
        });
        segStart = end;
        i = j;
        continue;
      }
      let identity = prelude;
      if (name !== undefined && name !== 'page' && BARE_AT_KEYWORD_RE.test(prelude)) {
        const body = normalize(at + 1, closeAt);
        const family = name === 'font-face' ? descriptor(body, 'font-family') : '';
        identity =
          family === ''
            ? `${prelude}{${body}}`
            : `${prelude}{font-family:${family};font-weight:${descriptor(body, 'font-weight')};font-style:${descriptor(body, 'font-style')}}`;
      }
      found.push({
        chain: [...chain],
        identity,
        start,
        end,
        head: css.slice(start, trimmedEnd(start, at)),
        body: css.slice(at, end),
        decls,
      });
      segStart = end;
      i = j;
      continue;
    }
    // `;` と `}` の手前にある、ブロックを持たない文(`@charset "x";` など)。
    const start = significantAt(segStart, at);
    if (start !== undefined) {
      // `;` で終わる文は `;` まで。`}` の手前で終わる文は末尾の空白を含めない。
      let end = ch === ';' ? at + 1 : at;
      if (ch === '}') while (end > start && /\s/.test(css[end - 1])) end--;
      found.push({
        chain: [...chain],
        identity: normalize(start, at),
        start,
        end,
        head: '',
        body: '',
        decls: undefined,
      });
    }
    // 対応の無い `}` は最上位で現れ、pop は何もしない(読み飛ばす)。
    if (ch === '}') chain.pop();
    segStart = at + 1;
    i++;
  }
  // 末尾の終端の無い文は規則にしない(書き換えの対象にせず、原文のまま残る)。

  const seen = new Map<string, number>();
  return found.map((r) => {
    const parts: Array<string | number> = [...r.chain, r.identity];
    const first = JSON.stringify(parts);
    const n = (seen.get(first) ?? 0) + 1;
    seen.set(first, n);
    const rule: ScannedRule = {
      key: n === 1 ? first : JSON.stringify([...parts, n]),
      atRules: r.chain,
      text: r.text ?? css.slice(r.start, r.end),
      start: r.start,
      end: r.end,
      chainKey: JSON.stringify(r.chain),
      group: first,
      head: r.head,
      body: r.body,
      decls: r.decls,
    };
    if (r.listIndex !== undefined) {
      rule.listOf = r.start;
      rule.listIndex = r.listIndex;
    }
    return rule;
  });
}

/**
 * CSS を規則単位に分ける。入れ子の at-rule(`@media` など)の中へは降り、それ以外のブロック
 * (`@font-face` `@keyframes` と通常の規則)は中身ごと 1 規則にする。
 */
export function splitCssRules(css: string): CssRule[] {
  return scanCssRules(css).map(({ key, atRules, text, start, end }) => ({
    key,
    atRules,
    text,
    start,
    end,
  }));
}

/** キーの 1 要素(セレクタか at-rule の前置き)を今の正規化の形にする。 */
function canonicalKeyPart(part: string): string {
  // `@font-face` などセレクタを持たない at-rule の識別子(`{` を含む)は中身から作った値なので
  // 書き方の正規化の対象外。
  if (part.startsWith('@') && part.includes('{')) return part;
  const text = collapseOutsideStrings(part);
  if (!text.startsWith('@')) return canonicalSelector(text);
  const name = (AT_KEYWORD_RE.exec(text)?.[0] ?? '@').slice(1).toLowerCase();
  return name === 'page' ? canonicalPagePrelude(text) : canonicalAtPrelude(text, name);
}

/**
 * 正規化したセレクタを括弧・`[…]`・文字列・エスケープの外の `,` で分ける。分けられない(並びで
 * ない・空のセレクタがある・同じセレクタが 2 つある)なら undefined。照合の経路の展開
 * (`scanCssRules` の `expandList`)と同じ条件にし、展開されないキーは並びのまま残す。
 */
function splitSelectorList(sel: string): string[] | undefined {
  const items = topLevelCommaSegments(sel, 0, sel.length).map(([a, b]) => sel.slice(a, b).trim());
  if (items.length < 2 || items.includes('') || new Set(items).size !== items.length) {
    return undefined;
  }
  return items;
}

/**
 * 同期状態ファイルに残った規則のキー(以前の正規化で作ったもの)を今のキーへ読み替える。
 * 要素ごとに今の正規化を当て直し、出現番号はそのまま残す。セレクタが並び(`.a,.b`)なら、照合の
 * 経路が 1 セレクタずつに展開するのに合わせてセレクタごとのキーに分ける。出現番号付きの並びは、
 * 並びの中の同じセレクタが何番目の出現かを古いキーからは決められないので、番号を外して各
 * セレクタの規則全体のキーにする。JSON 配列として読めないキーはそのまま返す。
 * 古いキーはセレクタの中のコメントを空白に置き換えてあるので、`.a` と `.b` の間にコメントを
 * 書いた規則の古いキー(`.a .b`)は今のキー(`.a.b`)へ戻せない。
 * 大文字の at-keyword の文(`@IMPORT …;`)は戻せない — 文のキーは原文の綴りのままなので、今の
 * キーに掛けても小文字に変わる。呼び出し側は、今のキーとして見つかるキーには掛けないこと。
 */
export function canonicalCssRuleKeys(key: string): string[] {
  let parts: unknown;
  try {
    parts = JSON.parse(key);
  } catch {
    return [key];
  }
  if (!Array.isArray(parts)) return [key];
  const next = parts.map((p) => (typeof p === 'string' ? canonicalKeyPart(p) : p));
  let last = next.length - 1;
  while (last >= 0 && typeof next[last] !== 'string') last--;
  const sel = last >= 0 ? (next[last] as string) : '';
  const list = sel.startsWith('@') ? undefined : splitSelectorList(sel);
  if (list === undefined) return [JSON.stringify(next)];
  const chain = next.slice(0, last);
  return list.map((s) => JSON.stringify([...chain, s]));
}

/** 比較用に書式の違い(空白・改行・ブロック最後の `;`)を消す(整形の差で競合にしない)。 */
function squash(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/\s*([{}:;,])\s*/g, '$1')
    .replace(/;}/g, '}')
    .trim();
}

/**
 * 2 つの規則の本文が書式の違いを除いて同じか。ペア同期の「解消済み」判定と転写の比較が
 * 同じ正規化を使うよう、この 1 本だけを公開する(呼び出し側で正規化を書き写さない)。
 */
export function sameCssRule(a: string, b: string): boolean {
  return squash(a) === squash(b);
}

/** 原文への 1 つの書き換え(`start`〜`end` を `text` にする。挿入は start === end)。 */
interface Edit {
  start: number;
  end: number;
  text: string;
}

/** 書き換えを原文のオフセットのまま当てる(範囲は互いに重ならない前提)。 */
function applyEdits(src: string, edits: Edit[]): string {
  // 同じ位置では挿入を先に当てる(直後の規則の置き換え・削除と並ぶため)。
  const sorted = [...edits].sort(
    (x, y) => x.start - y.start || x.end - x.start - (y.end - y.start),
  );
  let out = '';
  let pos = 0;
  for (const e of sorted) {
    out += src.slice(pos, e.start) + e.text;
    pos = e.end;
  }
  return out + src.slice(pos);
}

/** 規則を消す範囲。行に規則しか無ければ、行頭の空白と行末の改行まで含める。 */
function removalOf(src: string, rule: ScannedRule): Edit {
  let start = rule.start;
  let s = start;
  while (s > 0 && (src[s - 1] === ' ' || src[s - 1] === '\t')) s--;
  if (s === 0 || src[s - 1] === '\n') start = s;
  let end = rule.end;
  let e = end;
  while (e < src.length && (src[e] === ' ' || src[e] === '\t')) e++;
  if (src[e] === '\r') e++;
  if (src[e] === '\n') end = e + 1;
  return { start, end, text: '' };
}

/** 宣言として効く形(`名前:値`)か。 */
function isValidDecl(decl: string): boolean {
  return /^[^:]*[^:\s][^:]*:\s*\S/.test(decl);
}

/**
 * 効く宣言を 1 つも持たない出現(`.a{}` や宣言が無効なもの)か。GrapesJS はこの形の規則を
 * `getCss` に出さないので、出現を対応づけるときに外す(原文には残したまま触らない)。入れ子の
 * ブロックを持つ規則とブロックを持たない文は空とみなさない。
 *
 * 残差: プロパティ名の知識が無いので、未知のプロパティ(`.a{foo:bar}`)も効く宣言として数える。
 * GrapesJS がその出現を `getCss` に出さないと出現数が合わず、その規則の転写は競合になる。
 */
function isEmptyOccurrence(rule: ScannedRule): boolean {
  return rule.decls !== undefined && !rule.decls.some(isValidDecl);
}

/**
 * 対応づけに使う出現(原文の順)。重複があるときは空の出現を外す。出現が 1 つの規則は外さない
 * (重複の無い規則は、空でも本文どうしで比べる)。
 */
function occurrencesOf(rule: MergeRule): ScannedRule[] {
  return rule.parts.length === 1 ? rule.parts : rule.parts.filter((p) => !isEmptyOccurrence(p));
}

/** 2 つの出現の並びが、数も各出現の本文(`sameCssRule`)も同じか。 */
function sameOccurrences(a: readonly ScannedRule[], b: readonly ScannedRule[]): boolean {
  return a.length === b.length && a.every((x, i) => sameCssRule(x.text, b[i].text));
}

/** `at` の行頭からの空白(行頭から空白だけが続くときのみ)。 */
function indentBefore(src: string, at: number): string {
  let s = at;
  while (s > 0 && (src[s - 1] === ' ' || src[s - 1] === '\t')) s--;
  return s === 0 || src[s - 1] === '\n' ? src.slice(s, at) : '';
}

/**
 * 並びの中の 1 セレクタの書き戻し。`bodies` はそのセレクタに書く本文(`{` から `}` まで。next に
 * 同じセレクタの出現が複数あれば複数)、`'remove'` は消す。結果の無いセレクタは「そのまま」。
 */
type ListOutcome = { bodies: string[] } | 'remove';

/**
 * 物理の規則(セレクタの並び)へのセレクタごとの結果を、その規則の位置での 1 つの書き換えにする。
 * `items` は並びの見かけの規則(並びの順)。全部消すなら規則ごと消し、全部が同じ 1 つの本文なら
 * 並びの前置きを原文のまま残して本文だけを置き換える。それ以外は残るセレクタを並びの順に 1 規則ずつ
 * 書く(元の規則と同じ位置なので、ほかの規則とのカスケードの順は変わらない)。
 */
function listRewrite(
  src: string,
  items: readonly ScannedRule[],
  outcomes: ReadonlyMap<number, ListOutcome>,
): Edit {
  const physical = items[0];
  const results = items.map((p) => outcomes.get(p.listIndex ?? 0));
  if (results.every((r) => r === 'remove')) return removalOf(src, physical);
  const { start, end } = physical;
  const single = results.map((r) =>
    typeof r === 'object' && r.bodies.length === 1 ? r.bodies[0] : undefined,
  );
  const first = single[0];
  if (first !== undefined && single.every((b) => b !== undefined && sameCssRule(b, first))) {
    return { start, end, text: src.slice(start, end - physical.body.length) + first };
  }
  const texts = items.flatMap((p, i) => {
    const r = results[i];
    if (r === undefined) return [p.text];
    return r === 'remove' ? [] : r.bodies.map((b) => p.head + b);
  });
  return { start, end, text: texts.join(`\n${indentBefore(src, start)}`) };
}

/** next で同じ入れ子の中にあり、target に元からある直前の規則(target 側の位置で返す)。 */
function anchorFor(
  rules: MergeRule[],
  index: number,
  present: ReadonlyMap<string, MergeRule>,
): MergeRule | undefined {
  const { chainKey } = rules[index];
  for (let k = index - 1; k >= 0; k--) {
    if (rules[k].chainKey !== chainKey) continue;
    const hit = present.get(rules[k].key);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/**
 * `from` → next で変わった規則(追加・変更・削除)だけを target へ当てる(2 つの公開関数の本体)。
 *
 * 比べるのは出現の並び(`occurrencesOf`。重複の無い規則は出現 1 つ)で、数と各出現の本文が
 * 同じなら同じ規則とみなす。
 *
 * - 変わった規則は、target の同じ規則が `ref`(target が今も持っているはずの形)と出現ごとに
 *   同じなら当てる。違えば(版種固有に直してある・出現の形が違う・target に無い)競合として
 *   飛ばす。削除も同じ。`from` に無い規則の追加は、`ref` にも target にも無いことを求める。
 * - 当てるときは `from` と next の出現を前から対応させ、変わった出現だけを target の同じ番目の
 *   出現へ書き、next に無い末尾の出現を消す。`ref` と `from` の出現数が違う・next の出現が
 *   `from` より多いときは対応が取れないので競合にする。空の出現は原文のまま残す(規則ごと削除する
 *   とき = next に無いキーは、空の出現も含めて全部消す)。
 * - 変わっていない規則には触らない。target が既に next と同じ形なら何もしない。
 * - 追加(target に無い規則を当てる)は、next で同じ入れ子の中にある直前の規則の後ろへ入れる。
 *   その規則が target に無ければ、外側の入れ子 at-rule で包んで末尾へ入れる。target に原文と同じ
 *   空の規則だけがあるときは、最後の空の出現を置き換える。
 * - 並びの書き戻し: target の出現が見かけの規則(セレクタの並びの一部)なら、置き換え・削除を
 *   書き換えの列へ直接積まず、物理の規則ごとにセレクタの結果として集め(`listOutcomes`)、最後に
 *   `listRewrite` で 1 つの書き換えにする。同じ物理の規則へ書き換えを別々に積むと範囲が重なって
 *   壊れるため。競合になったセレクタは結果を積まないので「そのまま」(原文の宣言)で残る。
 *   追加の錨としては物理の規則の終わりを指すので、分割の書き換えと範囲は重ならない。
 * - `ref` に無いキーの変更・削除(正規化と並びの展開で吸収できない食い違い)は当てずに `unmatched`
 *   へ出す。ペア側の原文はそのキーで引けないので、変更を追加として末尾へ入れると同じ規則が二重に
 *   なり、削除は黙って飛ばすと消したはずの規則が残る。target が既に next と同じ形なら何もしない。
 */
function mergeRuleChanges(
  from: MergeRule[],
  ref: ReadonlyMap<string, MergeRule>,
  n: MergeRule[],
  target: string,
  t: MergeRule[],
): CssMergeResult {
  const fromKeys = new Set(from.map((r) => r.key));
  const nMap = new Map(n.map((r) => [r.key, r]));
  const tMap = new Map(t.map((r) => [r.key, r]));
  const edits: Edit[] = [];
  const applied: string[] = [];
  const conflicts: string[] = [];
  const unmatched: string[] = [];
  /** target が `ref` の形のままか。出現ごとに比べる(両方に無い場合も含む)。 */
  const untouched = (key: string, tr: MergeRule | undefined): boolean => {
    const r = ref.get(key);
    if (r === undefined || tr === undefined) return r === tr;
    return sameOccurrences(occurrencesOf(tr), occurrencesOf(r));
  };
  /** 物理の規則(`listOf`)→ 並びの番号 → そのセレクタの結果。 */
  const listOutcomes = new Map<number, Map<number, ListOutcome>>();
  /** target の出現 `p` を `text`(置き換え)か消す(undefined)ように書き換える。 */
  const rewrite = (p: ScannedRule, text: string | undefined, bodies: () => string[]): void => {
    if (p.listOf === undefined) {
      edits.push(text === undefined ? removalOf(target, p) : { start: p.start, end: p.end, text });
      return;
    }
    const outcomes = listOutcomes.get(p.listOf) ?? new Map<number, ListOutcome>();
    outcomes.set(p.listIndex ?? 0, text === undefined ? 'remove' : { bodies: bodies() });
    listOutcomes.set(p.listOf, outcomes);
  };

  // ── 1. 変更と削除(from の順)──
  for (const fr of from) {
    const nr = nMap.get(fr.key);
    const F = occurrencesOf(fr);
    const N = nr === undefined ? undefined : occurrencesOf(nr);
    if (N !== undefined && sameOccurrences(F, N)) continue;
    const tr = tMap.get(fr.key);
    if (!ref.has(fr.key)) {
      // 削除は target に無いことしか分からないので、既に当たっているとは判定できない。
      if (N !== undefined && tr !== undefined && sameOccurrences(occurrencesOf(tr), N)) continue;
      unmatched.push(fr.key);
      continue;
    }
    if (
      N === undefined ? tr === undefined : tr !== undefined && sameOccurrences(occurrencesOf(tr), N)
    )
      continue;
    // `ref` にあるキーなので、target に無ければ(ペア側が消してある)それも競合。
    if (tr === undefined || !untouched(fr.key, tr)) {
      conflicts.push(fr.key);
      continue;
    }
    if (N === undefined) {
      for (const p of tr.parts) rewrite(p, undefined, () => []);
      applied.push(fr.key);
      continue;
    }
    // 出現ごとに当てる。GrapesJS は重複を別々の規則のまま持ち、宣言が空になった最後の規則だけを
    // `getCss` から落とすので、F(baseline)と N(next)は前から i 番目どうしが対応する。原文と
    // F の出現数が違う・N が F より多い形は対応が取れないので競合にする。
    const L = occurrencesOf(tr);
    const R = occurrencesOf(ref.get(fr.key) as MergeRule);
    if (R.length !== F.length || N.length > F.length) {
      conflicts.push(fr.key);
      continue;
    }
    for (const [i, p] of L.entries()) {
      if (i >= N.length) rewrite(p, undefined, () => []);
      else if (!sameCssRule(F[i].text, N[i].text)) rewrite(p, N[i].text, () => [N[i].body]);
    }
    applied.push(fr.key);
  }

  // ── 2. 追加(next の順)。挿入位置ごとにまとめ、next の順を保つ ──
  const groups = new Map<
    string,
    { anchor: MergeRule | undefined; atRules: string[]; texts: string[] }
  >();
  for (const [index, nr] of n.entries()) {
    if (fromKeys.has(nr.key)) continue;
    const tr = tMap.get(nr.key);
    if (tr !== undefined) {
      if (sameOccurrences(occurrencesOf(tr), occurrencesOf(nr))) continue;
      // 原文の空の規則(`getCss` に出ないので baseline に無い)に宣言を足した編集。ペア側も原文と
      // 同じ空の形(空の規則の数も同じ)なら、最後の空の出現を next の出現で置き換える(前の空の出現は残す)。
      const last = tr.parts[tr.parts.length - 1];
      if (
        untouched(nr.key, tr) &&
        tr.parts.every(isEmptyOccurrence) &&
        tr.parts.length === ref.get(nr.key)?.parts.length
      ) {
        const occurrences = occurrencesOf(nr);
        rewrite(last, occurrences.map((p) => p.text).join('\n'), () =>
          occurrences.map((p) => p.body),
        );
        applied.push(nr.key);
      } else conflicts.push(nr.key);
      continue;
    }
    if (!untouched(nr.key, tr)) {
      conflicts.push(nr.key);
      continue;
    }
    const anchor = anchorFor(n, index, tMap);
    const groupKey = anchor !== undefined ? `after:${anchor.key}` : `end:${nr.chainKey}`;
    const group = groups.get(groupKey) ?? { anchor, atRules: nr.atRules, texts: [] };
    group.texts.push(...occurrencesOf(nr).map((p) => p.text));
    groups.set(groupKey, group);
    applied.push(nr.key);
  }
  let appendLead = target === '' || target.endsWith('\n') ? '' : '\n';
  for (const g of groups.values()) {
    if (g.anchor !== undefined) {
      const indent = indentBefore(target, g.anchor.start);
      const text = g.texts.map((x) => `\n${indent}${x}`).join('');
      edits.push({ start: g.anchor.end, end: g.anchor.end, text });
      continue;
    }
    const wrapped = g.atRules.reduceRight(
      (inner, prelude) => `${prelude} {\n${inner}\n}`,
      g.texts.join('\n'),
    );
    edits.push({ start: target.length, end: target.length, text: `${appendLead}${wrapped}\n` });
    appendLead = '';
  }

  // ── 3. 並びの書き戻し(物理の規則ごとに 1 つの書き換え)──
  if (listOutcomes.size > 0) {
    const items = new Map<number, ScannedRule[]>();
    for (const p of t.flatMap((r) => r.parts)) {
      if (p.listOf !== undefined) items.set(p.listOf, [...(items.get(p.listOf) ?? []), p]);
    }
    for (const [listOf, outcomes] of listOutcomes) {
      const list = (items.get(listOf) ?? []).sort(
        (a, b) => (a.listIndex ?? 0) - (b.listIndex ?? 0),
      );
      edits.push(listRewrite(target, list, outcomes));
    }
  }

  return {
    css: edits.length === 0 ? target : applyEdits(target, edits),
    applied,
    conflicts,
    unmatched,
  };
}

/** 規則のキー → 規則。 */
function byKey(rules: MergeRule[]): Map<string, MergeRule> {
  return new Map(rules.map((r) => [r.key, r]));
}

/** 規則のキー → 原文。 */
function textsByKey(rules: MergeRule[]): Map<string, string> {
  return new Map(rules.map((r) => [r.key, r.text]));
}

/** 重複を畳まず、出現ごとに 1 規則にする(キーは出現番号つき)。 */
function asIs(css: string): MergeRule[] {
  return scanCssRules(css, true).map((r) => ({ ...r, parts: [r] }));
}

/**
 * 同じキーの重複(出現番号の付くもの)を 1 つの規則にまとめる(`parts` に出現を持つ)。並びは最後の
 * 出現の位置の順。`text` は畳んだ本文: 宣言だけの規則は宣言の後勝ち(`!important` は後ろの通常の
 * 宣言に負けない)= 実際のカスケードの値で 1 本にし、宣言の並びは最初に現れた順を保つ。入れ子の
 * ブロックを持つ規則(`@keyframes` など)とブロックを持たない文は、最後の出現を代表にする。
 */
function folded(css: string): MergeRule[] {
  const rules = scanCssRules(css, true);
  const groups = new Map<string, ScannedRule[]>();
  for (const r of rules) groups.set(r.group, [...(groups.get(r.group) ?? []), r]);
  const out: MergeRule[] = [];
  for (const parts of groups.values()) {
    const last = parts[parts.length - 1];
    out.push({ ...last, key: last.group, text: foldedText(parts), parts });
  }
  // 同じ並びの見かけの規則は位置を共有するので、並びの順で並べる。
  return out.sort((a, b) => a.start - b.start || (a.listIndex ?? 0) - (b.listIndex ?? 0));
}

function foldedText(parts: ScannedRule[]): string {
  if (parts.length === 1) return parts[0].text;
  if (parts.some((p) => p.decls === undefined)) return parts[parts.length - 1].text;
  const winners = new Map<string, { decl: string; important: boolean }>();
  for (const p of parts) {
    for (const decl of (p.decls ?? []).filter(isValidDecl)) {
      const colon = decl.indexOf(':');
      const prop = colon === -1 ? decl : decl.slice(0, colon).trim().toLowerCase();
      const important = /!\s*important$/i.test(decl);
      if (winners.get(prop)?.important && !important) continue;
      winners.set(prop, { decl, important });
    }
  }
  return `${parts[0].head}{${[...winners.values()].map((w) => w.decl).join(';')}}`;
}

/**
 * 重複を畳んだ規則のキー → 本文(`mergeCssRuleChangesFromBaseline` のキーと同じ形)。ペア同期で、
 * 転写後の規則が両版で一致したかを判定するのに使う。
 */
export function foldedCssRuleTexts(css: string): Map<string, string> {
  return textsByKey(folded(css));
}

/**
 * base → next で変わった規則(追加・変更・削除)だけを、target へ 3 者比較で当てる。
 * target の同じ規則が base と同じなら当て、違えば競合にする(`mergeRuleChanges` を見よ)。
 * テストから直接検証するために公開する。
 */
export function mergeCssRuleChanges(base: string, next: string, target: string): CssMergeResult {
  const b = asIs(base);
  return mergeRuleChanges(b, byKey(b), asIs(next), target, asIs(target));
}

/**
 * 変更の検出と、ペア側(target)の照合を別の形で行う版。4 つの CSS とも同じキーの重複を 1 つの
 * 規則として識別し(`folded`)、出現ごとに比べて当てる(`mergeRuleChanges`)。承認の CSS は GrapesJS が書き直した形
 * (一括指定の展開・色の正規化・url の引用符)で届くので、外部ツールが書いた原文と直に比べると
 * 編集していない規則まで「変わった」に見える。
 *
 * - 変わった規則は `baseline`(確定版の CSS を GrapesJS が読み込んだ直後の形)→ `next` で見る。
 * - target の同じ規則は `rawBase`(承認前のファイルの原文)と比べる。target も原文なので、
 *   書き直しの差で競合にならない。
 */
export function mergeCssRuleChangesFromBaseline(
  rawBase: string,
  baseline: string,
  next: string,
  target: string,
): CssMergeResult {
  return mergeRuleChanges(
    folded(baseline),
    byKey(folded(rawBase)),
    folded(next),
    target,
    folded(target),
  );
}
