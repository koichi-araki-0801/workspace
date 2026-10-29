// =============================================================================
// jinjaPartRerender.ts — 編集タブで挿入した Jinja パーツを、ペアの値で描き直す(純関数)
// =============================================================================
// 編集タブに挿入したカタログのパーツは、挿入した時点で写し元(交付版など)の値ファイルの値で描いた
// 地の HTML になり、Jinja の原文は本文に残らない。そのままペアへ写すと、写し先(全体版など)に
// 写し元の値が入る。そこで承認後のペア同期(`pairSyncService.ts`)の前に、手で直していないパーツだけを
// カタログの `内容HTML` から写し先の値で描き直す。
//
// 「直していない」の判定は、カタログの `内容HTML` を写し元の値で描いた形と、承認された本文の
// パーツ(GrapesJS の直列化を通った形)が、DOM 上で同じになる形への正規化(shared の
// `samePartHtml`)で一致すること。正規化が寄せるのは DOM と見た目が変わらない書き方の違いだけで、
// テキストや属性値の中身が違えば必ず一致しない: 判定を誤って「直していない」に倒すと手直しを捨てて
// 描き直すことになり、逆に「直した」に倒しても承認された HTML をそのまま写すだけ(警告を添える)で
// 失うものが無いため。

import {
  containsJinja,
  findEditingMarkers,
  isHtmlSpace,
  isTagNameEnd,
  JinjaBudget,
  readAttr,
  renderPlainFilled,
  type SampleData,
  samePartHtml,
} from '@editor/shared';
import { collectExecutableUnits } from '../security/templateScripts.js';
import { applyOps, extractSyncParts } from './partSync.js';

/**
 * 描いた HTML の根(先頭の開始タグ)へ `data-part-id` を付ける。位置は GrapesJS が挿入したパーツを
 * 書き出す順(他の属性 → `data-part-id` → `class` → `style`)に揃える: ペア同期は生の HTML の SHA-1 で
 * 比べるので、写し先の本文と書き方が違うと、誰も直していない往復の承認で「両側変更」の競合になる。
 * 属性の原文と、最後の属性の後ろ(` />` など)はそのまま残す。根の開始タグが読めなければ null
 * (描き直しを見送る)。
 */
function withPartId(html: string, partId: string): string | null {
  if (!/^<[A-Za-z]/.test(html)) return null;
  let k = 1;
  while (k < html.length && !isTagNameEnd(html[k])) k++;
  const head = html.slice(0, k);
  const others: string[] = [];
  const classes: string[] = [];
  const styles: string[] = [];
  let lastEnd = k;
  while (k < html.length && html[k] !== '>') {
    if (isHtmlSpace(html[k]) || html[k] === '/') {
      k++;
      continue;
    }
    const a = readAttr(html, k, html.length);
    const raw = html.slice(k, a.next).trimEnd();
    if (a.name === 'class') classes.push(raw);
    else if (a.name === 'style') styles.push(raw);
    else if (a.name !== 'data-part-id') others.push(raw);
    k = a.next;
    lastEnd = k;
  }
  if (k >= html.length) return null;
  const quote = partId.includes('"') ? "'" : '"';
  const attrs = [...others, `data-part-id=${quote}${partId}${quote}`, ...classes, ...styles];
  return `${head} ${attrs.join(' ')}${html.slice(lastEnd)}`;
}

/**
 * 描き直したパーツが、承認で書く本文の検査(`confirmedWrite.ts` の往復用の印の関所と実行コードの
 * 不変性)に通るか。`safe` は値の HTML をエスケープせずに描くので、写し先の値に script・イベント属性・
 * 往復用の印があるとパーツに入る。置き換える承認済みのパーツと能動コンテンツの並びが同じなら、
 * 置き換えても本文全体の並びは変わらない。通らなければ描き直さず、承認された HTML をそのまま写す。
 */
function passesWriteGates(next: string, approvedPart: string): boolean {
  if (findEditingMarkers(next).length > 0) return false;
  const before = collectExecutableUnits(approvedPart);
  const after = collectExecutableUnits(next);
  return before.length === after.length && before.every((u, i) => u === after[i]);
}

interface JinjaPartRerenderInput {
  /** 承認された本文(値入り HTML)。 */
  sourceHtml: string;
  /** partId → カタログの `内容HTML`。Jinja を含まないものは見ない。 */
  catalog: ReadonlyMap<string, string>;
  /** 写し元の値ファイルの値(「直していない」の判定に使う)。 */
  sourceValues: SampleData;
  /** 写し先の値ファイルの値(描き直しに使う)。 */
  targetValues: SampleData;
  /**
   * 写し先の本文。同じキーのパーツが写し先でも直されていなければ(写し先の値で描いた形と一致すれば)、
   * 描いた結果でなく写し先のバイト列を使う。生の HTML の SHA-1 で比べるペア同期で、属性の書き方の
   * 違いだけで競合にしないため。
   */
  targetHtml: string;
}

interface JinjaPartRerenderResult {
  html: string;
  /** 写し先の値で描き直したパーツのキー(`partId#n`)。 */
  rerendered: string[];
  /** 手で直した(または描けない)ので、そのまま残したパーツのキー。 */
  edited: string[];
  /** 描き直したが、写し先の値が欠けた・描けない書き方があって空欄になったパーツ。 */
  blanks: { partKey: string; missing: readonly string[]; unsupported: readonly string[] }[];
}

/**
 * 1 回の承認で描く回数の上限。描画は `withReviewLock` の中で同期的に走るので、同じ承認で描く量が
 * 増えるほど event loop が止まる。描いた結果はパーツ ID ごとに覚えるので、回数はパーツの種類の 2 倍で
 * 済むが、カタログの種類が多い本文でも止まる時間に上限を置く。
 */
const MAX_RENDERS = 100;

/** 1 回の承認で描いた HTML の合計の文字数の上限(出力は評価の量と別に伸ばせる)。 */
const MAX_RENDERED_CHARS = 20_000_000;

type Rendered = ReturnType<typeof renderPlainFilled>;

/** 描けなかった理由。`error` は壊れた Jinja、`limit` は 1 回の承認の上限に届いたこと。 */
type RenderOutcome = Rendered | 'error' | 'limit';

/**
 * 1 回の承認の描画の受け持ち。結果は「原文 + 値」で決まるので、同じ側(写し元 / 写し先)の値で描く
 * 同じパーツは 1 回だけ描き、出現が何回あっても描く回数は増えない。評価の量は承認の全体で 1 つの
 * `JinjaBudget` を引き合い、回数・量・出力のどれかが上限に届いたら以後は描かない。上限に届いた描画は
 * 途中で省いた結果なので使わない。
 */
function createRenderer(catalog: ReadonlyMap<string, string>) {
  const budget = new JinjaBudget();
  const memo = new Map<string, RenderOutcome>();
  let renders = 0;
  let chars = 0;
  const overLimit = () => budget.exhausted || chars > MAX_RENDERED_CHARS;
  return (side: 'source' | 'target', partId: string, values: SampleData): RenderOutcome => {
    const key = `${side}:${partId}`;
    const hit = memo.get(key);
    if (hit !== undefined) return hit;
    let out: RenderOutcome = 'limit';
    if (renders < MAX_RENDERS && !overLimit()) {
      renders++;
      try {
        const r = renderPlainFilled(catalog.get(partId) ?? '', values, { budget });
        chars += r.html.length;
        out = overLimit() ? 'limit' : r;
      } catch {
        out = 'error';
      }
    }
    memo.set(key, out);
    return out;
  };
}

/** `sourceHtml` の Jinja パーツのうち、直していないものを写し先の値で描き直す。 */
export function rerenderUneditedJinjaParts(input: JinjaPartRerenderInput): JinjaPartRerenderResult {
  const rerendered: string[] = [];
  const edited: string[] = [];
  const blanks: JinjaPartRerenderResult['blanks'] = [];
  const ops: { start: number; end: number; text: string; seq: number }[] = [];
  const targetParts = new Map(extractSyncParts(input.targetHtml).map((p) => [p.key, p.html]));
  const render = createRenderer(input.catalog);
  for (const part of extractSyncParts(input.sourceHtml)) {
    const raw = input.catalog.get(part.partId);
    if (raw === undefined || !containsJinja(raw)) continue;
    // 壊れた Jinja・上限に届いたものは描けないので、承認された HTML をそのまま写す側に倒す。
    const asApproved = render('source', part.partId, input.sourceValues);
    if (typeof asApproved === 'string') {
      edited.push(part.key);
      continue;
    }
    if (!samePartHtml(asApproved.html, part.html)) {
      edited.push(part.key);
      continue;
    }
    const rendered = render('target', part.partId, input.targetValues);
    if (typeof rendered === 'string') {
      edited.push(part.key);
      continue;
    }
    const current = targetParts.get(part.key);
    const next =
      current !== undefined && samePartHtml(current, rendered.html)
        ? current
        : withPartId(rendered.html.trim(), part.partId);
    const diagnostics = rendered.diagnostics;
    if (next === null || !passesWriteGates(next, part.html)) {
      edited.push(part.key);
      continue;
    }
    ops.push({ start: part.start, end: part.end, text: next, seq: ops.length });
    rerendered.push(part.key);
    if (diagnostics.missing.length > 0 || diagnostics.unsupported.length > 0)
      blanks.push({ partKey: part.key, ...diagnostics });
  }
  const html = ops.length > 0 ? applyOps(input.sourceHtml, ops) : input.sourceHtml;
  return { html, rerendered, edited, blanks };
}
