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
// 足す。`mergeCssRuleChangesFromBaseline` は重複を 1 本に畳んでから比べる。GrapesJS は重複を
// 別々の規則のまま持ち、宣言の無効な規則は読み込みで落とす(出現番号が原文とずれる)。スタイルの
// 編集は同じセレクタの最後の規則に入るので、出現ごとの対応では「どの出現が変わったか」が原文と
// 合わないことがある。畳めば、どの出現を編集しても実際のカスケードと同じ値で比べられる。
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
 * 規則の比較と書き換えの単位。重複を畳んだときは `parts` が原文の出現で、`start`/`end` は
 * 最後の出現(置き換え・追加の基準)を指す。
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
      // `[x='y'i]` の `i` はブラウザが `[x="y" i]` と書き出す。
      if (/[a-z]/i.test(sel[i] ?? '')) out += ' ';
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
      value += cp === 0 || cp > 0x10ffff ? '\ufffd' : String.fromCodePoint(cp);
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
    return out
      .replace(/\s+/g, ' ')
      .replace(/\s*,\s*/g, ',')
      .trim();
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
 * - 変わった規則は、target の同じ規則が `ref`(target が今も持っているはずの形)と同じなら当てる。
 *   違えば(版種固有に直してある)競合として飛ばす。`ref` に無い規則は target にも無いことを求める。
 * - 変わっていない規則には触らない。target が既に next と同じ形なら何もしない。
 * - 追加(target に無い規則を当てる)は、next で同じ入れ子の中にある直前の規則の後ろへ入れる。
 *   その規則が target に無ければ、外側の入れ子 at-rule で包んで末尾へ入れる。
 */
function mergeRuleChanges(
  from: MergeRule[],
  ref: ReadonlyMap<string, string>,
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
  /** target が `ref` の形のままか(両方に無い場合も含む)。 */
  const untouched = (key: string, tr: MergeRule | undefined): boolean => {
    const r = ref.get(key);
    return r === undefined || tr === undefined ? r === tr?.text : sameCssRule(tr.text, r);
  };
  /** 変わったが target に無いので、追加と同じ位置へ入れる規則。 */
  const inserts = new Set<string>();

  // ── 1. 変更と削除(from の順)──
  for (const fr of from) {
    const nr = nMap.get(fr.key);
    if (nr !== undefined && sameCssRule(fr.text, nr.text)) continue;
    const tr = tMap.get(fr.key);
    if (nr === undefined ? tr === undefined : tr !== undefined && sameCssRule(tr.text, nr.text))
      continue;
    if (!untouched(fr.key, tr)) {
      conflicts.push(fr.key);
      continue;
    }
    if (nr === undefined) {
      for (const p of tr?.parts ?? []) edits.push(removalOf(target, p));
      applied.push(fr.key);
    } else if (tr === undefined) {
      inserts.add(fr.key);
    } else {
      // 重複を畳んだ規則は最後の出現の位置へ 1 本で置き、ほかの出現は消す。最後の出現の位置なら、
      // 編集した値(後勝ちで効いていた宣言)が間にある別の規則との順序を変えずに効く。
      for (const p of tr.parts) {
        edits.push(
          p === tr.parts.at(-1)
            ? { start: p.start, end: p.end, text: nr.text }
            : removalOf(target, p),
        );
      }
      applied.push(fr.key);
    }
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
      if (!sameCssRule(tr.text, nr.text)) conflicts.push(nr.key);
      continue;
    }
    if (!inserts.has(nr.key) && !untouched(nr.key, tr)) {
      conflicts.push(nr.key);
      continue;
    }
    const anchor = anchorFor(n, index, tMap);
    const groupKey = anchor !== undefined ? `after:${anchor.key}` : `end:${nr.chainKey}`;
    const group = groups.get(groupKey) ?? { anchor, atRules: nr.atRules, texts: [] };
    group.texts.push(nr.text);
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

/** 規則のキー → 原文。 */
function textsByKey(rules: MergeRule[]): Map<string, string> {
  return new Map(rules.map((r) => [r.key, r.text]));
}

/** 重複を畳まず、出現ごとに 1 規則にする(キーは出現番号つき)。 */
function asIs(css: string): MergeRule[] {
  return scanCssRules(css).map((r) => ({ ...r, parts: [r] }));
}

/**
 * 重複した規則(出現番号の付くもの)を、最後の出現の位置にある 1 本へ畳む。宣言だけの規則は
 * 宣言の後勝ち(`!important` は後ろの通常の宣言に負けない)= 実際のカスケードの値で 1 本にし、
 * 宣言の並びは最初に現れた順を保つ。入れ子のブロックを持つ規則(`@keyframes` など)とブロックを
 * 持たない文は、最後の出現を代表にする。並びは最後の出現の位置の順。
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
    for (const decl of p.decls ?? []) {
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
  return mergeRuleChanges(b, textsByKey(b), asIs(next), target, asIs(target));
}

/**
 * 変更の検出と、ペア側(target)の照合を別の形で行う版。4 つの CSS とも重複した規則を畳んで
 * 比べ(`folded`)、当てるときはペア側の重複を最後の出現へ 1 本にまとめる。承認の CSS は GrapesJS が書き直した形
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
    textsByKey(folded(rawBase)),
    folded(next),
    target,
    folded(target),
  );
}
