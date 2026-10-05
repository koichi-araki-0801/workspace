// =============================================================================
// cssRules.ts — CSS を「規則」単位に分け、承認で変わった規則だけをペア側へ当てる
// =============================================================================
// ペア同期(交付版⇄全体版)の CSS 転写に使う。CSS はテンプレ単位のファイルで、版種ごとに手で
// 直した規則が混ざるため、ファイル丸ごとの上書きはできない。base(承認前)→ next(承認後)で
// 変わった規則だけを見て、ペア側(target)の同じ規則が base のままなら当て、違えば競合にする。
//
// 字句は `collectCssStructure`(外部参照検査と同じ走査器)から取る。別の正規表現で `{` `}` を
// 数えると、文字列やコメントに入った括弧で検査と分割の解釈が割れる。新しい依存(postcss 等)は
// 足さない — 遮断端末への配布物が増えるため。
//
// 規則のキーは「外側の入れ子 at-rule の前置きの並び + セレクタ」を JSON 配列にした文字列。
// セレクタを持たない規則(`@font-face` など)は中身を含めて見分け、同じキーが複数あれば出現順の
// 番号を足す。規則の間のコメントはどの規則にも属さず、同期の対象にならない。

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

/** 前置きが at-keyword だけの形(`@font-face` `@page`)。中身で見分ける。 */
const BARE_AT_KEYWORD_RE = /^@[-\w\\]+$/;

interface ScannedRule extends CssRule {
  /** `atRules` を比較用に文字列にしたもの。 */
  chainKey: string;
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

  const found: Array<{ chain: string[]; identity: string; start: number; end: number }> = [];
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
      for (; j < punct.length && depth > 0; j++) {
        if (punct[j].ch === '{') depth++;
        else if (punct[j].ch === '}') depth--;
      }
      const closeAt = depth === 0 ? punct[j - 1].at : css.length;
      const end = depth === 0 ? closeAt + 1 : css.length;
      const identity =
        name !== undefined && BARE_AT_KEYWORD_RE.test(prelude)
          ? `${prelude}{${normalize(at + 1, closeAt)}}`
          : prelude;
      found.push({ chain: [...chain], identity, start, end });
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
      found.push({ chain: [...chain], identity: normalize(start, at), start, end });
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
  rules: ScannedRule[],
  index: number,
  present: ReadonlyMap<string, ScannedRule>,
): ScannedRule | undefined {
  const { chainKey } = rules[index];
  for (let k = index - 1; k >= 0; k--) {
    if (rules[k].chainKey !== chainKey) continue;
    const hit = present.get(rules[k].key);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/**
 * base → next で変わった規則(追加・変更・削除)だけを、target へ 3 者比較で当てる。
 *
 * - target の同じ規則が base と同じなら当てる。違えば(版種固有に直してある)競合として飛ばす。
 * - 変わっていない規則には触らない。target が既に next と同じ形なら何もしない。
 * - 追加は、next で同じ入れ子の中にある直前の規則の後ろへ入れる。その規則が target に無ければ、
 *   外側の入れ子 at-rule で包んで末尾へ入れる。
 */
export function mergeCssRuleChanges(base: string, next: string, target: string): CssMergeResult {
  const b = scanCssRules(base);
  const n = scanCssRules(next);
  const t = scanCssRules(target);
  const bKeys = new Set(b.map((r) => r.key));
  const nMap = new Map(n.map((r) => [r.key, r]));
  const tMap = new Map(t.map((r) => [r.key, r]));
  const edits: Edit[] = [];
  const applied: string[] = [];
  const conflicts: string[] = [];

  // ── 1. 変更と削除(base の順)──
  for (const br of b) {
    const nr = nMap.get(br.key);
    if (nr !== undefined && sameCssRule(br.text, nr.text)) continue;
    const tr = tMap.get(br.key);
    if (nr === undefined) {
      if (tr === undefined) continue;
      if (!sameCssRule(tr.text, br.text)) {
        conflicts.push(br.key);
        continue;
      }
      edits.push(removalOf(target, tr));
      applied.push(br.key);
      continue;
    }
    if (tr === undefined) {
      conflicts.push(br.key);
      continue;
    }
    if (sameCssRule(tr.text, nr.text)) continue;
    if (!sameCssRule(tr.text, br.text)) {
      conflicts.push(br.key);
      continue;
    }
    edits.push({ start: tr.start, end: tr.end, text: nr.text });
    applied.push(br.key);
  }

  // ── 2. 追加(next の順)。挿入位置ごとにまとめ、next の順を保つ ──
  const groups = new Map<
    string,
    { anchor: ScannedRule | undefined; atRules: string[]; texts: string[] }
  >();
  for (const [index, nr] of n.entries()) {
    if (bKeys.has(nr.key)) continue;
    const tr = tMap.get(nr.key);
    if (tr !== undefined) {
      if (!sameCssRule(tr.text, nr.text)) conflicts.push(nr.key);
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
