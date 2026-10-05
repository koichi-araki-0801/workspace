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
// 持たない規則は中身全体で見分ける。セレクタの属性値は `[src="x"]` の形にそろえる(GrapesJS は
// ブラウザが書き出したセレクタを使うため)。同じキーが複数あれば `splitCssRules` は出現順の番号を
// 足す。`mergeCssRuleChangesFromBaseline` は同じキーの重複を 1 つの規則として識別し(出現番号を
// 付けない)、その中の出現を前から対応づける。GrapesJS は重複を別々の規則のまま持ち、宣言が空に
// なった規則だけを `getCss` に出さない(スタイルの編集は同じセレクタの最後の規則に入るので、
// 消えるのも最後の規則)。そこで空の出現を外したうえで、変更の判定・ペア側が手つかずかの判定・
// 当てる処理をすべて出現ごとに行う。ペア側の出現の形が原文と違う(宣言の配り方が違う・まとめて
// ある・重複が多い)ときは対応が取れないので競合にする — 1 本にまとめて当てると、間にある別の
// 規則とのカスケードがどこに置いても崩れうるため。
// 規則の間のコメントはどの規則にも属さず、同期の対象にならない。

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
  /** ブロックの前置きの原文(`.a ` の末尾空白を除いたもの)。ブロックを持たない文は空。 */
  head: string;
  /** 宣言の並び(正規化済み)。ブロックを持たない文と、中に入れ子のブロックを持つ規則は undefined。 */
  decls: string[] | undefined;
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

/** 原文を規則へ分ける(キーと入れ子の情報つき)。 */
function scanCssRules(css: string): ScannedRule[] {
  const { punct, comments, atRules } = collectCssStructure(css);
  const commentEnd = new Map(comments.map((c) => [c.start, c.end]));

  /** `[from, to)` でコメントと空白を除いた最初の文字の位置。無ければ undefined。 */
  const firstSignificant = (from: number, to: number): number | undefined => {
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
  };

  /** `[from, to)` からコメントを除き、空白を畳み、`,` の前後の空白を消す(キー用)。 */
  const normalize = (from: number, to: number): string => {
    let out = '';
    let k = from;
    while (k < to) {
      const skip = commentEnd.get(k);
      if (skip !== undefined) {
        out += ' ';
        k = skip;
        continue;
      }
      out += css[k];
      k++;
    }
    return (
      out
        // `\` + 改行は文字列の行の継続で、文字ごと消える。空白へ畳む前に消す(`\\` は残す)。
        .replace(/\\(\r\n|[\n\r\f]|[\s\S])/g, (m, c: string) => (/^[\r\n\f]/.test(c) ? '' : m))
        .replace(/\s+/g, ' ')
        .replace(/\s*,\s*/g, ',')
        .trim()
    );
  };

  const found: Array<{
    chain: string[];
    identity: string;
    start: number;
    end: number;
    head: string;
    decls: string[] | undefined;
  }> = [];
  const chain: string[] = [];
  let segStart = 0;
  let i = 0;
  while (i < punct.length) {
    const { ch, at } = punct[i];
    if (ch === '{') {
      const start = firstSignificant(segStart, at) ?? at;
      const name = atRules.get(start)?.toLowerCase();
      const prelude = normalize(start, at);
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
      let identity = name === undefined ? canonicalAttrQuotes(prelude) : prelude;
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
        head: css.slice(start, at).trimEnd(),
        decls,
      });
      segStart = end;
      i = j;
      continue;
    }
    // `;` と `}` の手前にある、ブロックを持たない文(`@charset "x";` など)。
    const start = firstSignificant(segStart, at);
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
    return {
      key: n === 1 ? first : JSON.stringify([...parts, n]),
      atRules: r.chain,
      text: css.slice(r.start, r.end),
      start: r.start,
      end: r.end,
      chainKey: JSON.stringify(r.chain),
      group: first,
      head: r.head,
      decls: r.decls,
    };
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
 *   同じなら当てる。違えば(版種固有に直してある・出現の形が違う)競合として飛ばす。削除も同じ。
 *   `ref` に無い規則は target にも無いことを求める。
 * - 当てるときは `from` と next の出現を前から対応させ、変わった出現だけを target の同じ番目の
 *   出現へ書き、next に無い末尾の出現を消す。`ref` と `from` の出現数が違う・next の出現が
 *   `from` より多いときは対応が取れないので競合にする。空の出現は原文のまま残す。
 * - 変わっていない規則には触らない。target が既に next と同じ形なら何もしない。
 * - 追加(target に無い規則を当てる)は、next で同じ入れ子の中にある直前の規則の後ろへ入れる。
 *   その規則が target に無ければ、外側の入れ子 at-rule で包んで末尾へ入れる。
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
  /** target が `ref` の形のままか。出現ごとに比べる(両方に無い場合も含む)。 */
  const untouched = (key: string, tr: MergeRule | undefined): boolean => {
    const r = ref.get(key);
    if (r === undefined || tr === undefined) return r === tr;
    return sameOccurrences(occurrencesOf(tr), occurrencesOf(r));
  };
  /** 変わったが target に無いので、追加と同じ位置へ入れる規則。 */
  const inserts = new Set<string>();

  // ── 1. 変更と削除(from の順)──
  for (const fr of from) {
    const nr = nMap.get(fr.key);
    const F = occurrencesOf(fr);
    const N = nr === undefined ? undefined : occurrencesOf(nr);
    if (N !== undefined && sameOccurrences(F, N)) continue;
    const tr = tMap.get(fr.key);
    if (
      N === undefined ? tr === undefined : tr !== undefined && sameOccurrences(occurrencesOf(tr), N)
    )
      continue;
    if (!untouched(fr.key, tr)) {
      conflicts.push(fr.key);
      continue;
    }
    if (N === undefined) {
      for (const p of tr?.parts ?? []) edits.push(removalOf(target, p));
      applied.push(fr.key);
      continue;
    }
    if (tr === undefined) {
      inserts.add(fr.key);
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
    L.forEach((p, i) => {
      if (i >= N.length) edits.push(removalOf(target, p));
      else if (!sameCssRule(F[i].text, N[i].text))
        edits.push({ start: p.start, end: p.end, text: N[i].text });
    });
    applied.push(fr.key);
  }

  // ── 2. 追加(next の順)。挿入位置ごとにまとめ、next の順を保つ ──
  const groups = new Map<
    string,
    { anchor: MergeRule | undefined; atRules: string[]; texts: string[] }
  >();
  for (const [index, nr] of n.entries()) {
    if (fromKeys.has(nr.key) && !inserts.has(nr.key)) continue;
    const tr = tMap.get(nr.key);
    if (tr !== undefined) {
      if (!sameOccurrences(occurrencesOf(tr), occurrencesOf(nr))) conflicts.push(nr.key);
      continue;
    }
    if (!inserts.has(nr.key) && !untouched(nr.key, tr)) {
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

  return { css: edits.length === 0 ? target : applyEdits(target, edits), applied, conflicts };
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
  return scanCssRules(css).map((r) => ({ ...r, parts: [r] }));
}

/**
 * 同じキーの重複(出現番号の付くもの)を 1 つの規則にまとめる(`parts` に出現を持つ)。並びは最後の
 * 出現の位置の順。`text` は畳んだ本文: 宣言だけの規則は宣言の後勝ち(`!important` は後ろの通常の
 * 宣言に負けない)= 実際のカスケードの値で 1 本にし、宣言の並びは最初に現れた順を保つ。入れ子の
 * ブロックを持つ規則(`@keyframes` など)とブロックを持たない文は、最後の出現を代表にする。
 */
function folded(css: string): MergeRule[] {
  const rules = scanCssRules(css);
  const groups = new Map<string, ScannedRule[]>();
  for (const r of rules) groups.set(r.group, [...(groups.get(r.group) ?? []), r]);
  const out: MergeRule[] = [];
  for (const parts of groups.values()) {
    const last = parts[parts.length - 1];
    out.push({ ...last, key: last.group, text: foldedText(parts), parts });
  }
  return out.sort((a, b) => a.start - b.start);
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
