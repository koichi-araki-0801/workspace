// =============================================================================
// jinjaPartRerender.ts — 編集タブで挿入した Jinja パーツを、ペアの値で描き直す(純関数)
// =============================================================================
// 編集タブに挿入したカタログのパーツは、挿入した時点で写し元(交付版など)の値ファイルの値で描いた
// 地の HTML になり、Jinja の原文は本文に残らない。そのままペアへ写すと、写し先(全体版など)に
// 写し元の値が入る。そこで承認後のペア同期(`pairSyncService.ts`)の前に、手で直していないパーツだけを
// カタログの `内容HTML` から写し先の値で描き直す。
//
// 「直していない」の判定は、カタログの `内容HTML` を写し元の値で描いた形と、承認された本文の
// パーツが同じ規則の正規化(`normalizePartHtml`)で一致すること。正規化はわざと狭くする: 判定を
// 誤って「直していない」に倒すと手直しを捨てて描き直すことになり、逆に「直した」に倒しても承認された
// HTML をそのまま写すだけ(警告を添える)で失うものが無いため。

import { containsJinja, renderPlainFilled, type SampleData } from '@editor/shared';
import { applyOps, extractSyncParts } from './partSync.js';

/**
 * 比較用の正規形。`data-part-id`(挿入時に editor が根へ付ける)を除き、連続空白を 1 つにし、
 * タグ間の空白を消す。属性の順序・引用符・自己終了の書き方は揃えない(上の倒し方の理由)。
 * 空白を先に 1 つへ畳むのは、後段の正規表現が空白の連なりで二次の走査をしないため。
 */
export function normalizePartHtml(html: string): string {
  return html
    .replace(/\s+/g, ' ')
    .replace(/ ?data-part-id ?= ?(?:"[^"]*"|'[^']*'|[^ >]*)/gi, '')
    .replace(/> </g, '><')
    .trim();
}

/**
 * 描いた HTML の根(先頭の開始タグ)へ `data-part-id` を付ける。挿入時(`useGrapes.ts` の
 * `insertPart`)と同じく根に付け、次の承認でもペア同期とメモがこのパーツを同じ id で引けるようにする。
 * 根の開始タグが読めなければ null(描き直しを見送る)。
 */
function withPartId(html: string, partId: string): string | null {
  const m = /^<([A-Za-z][A-Za-z0-9-]*)/.exec(html);
  if (!m) return null;
  const quote = partId.includes('"') ? "'" : '"';
  const at = m[0].length;
  return `${html.slice(0, at)} data-part-id=${quote}${partId}${quote}${html.slice(at)}`;
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

/** `sourceHtml` の Jinja パーツのうち、直していないものを写し先の値で描き直す。 */
export function rerenderUneditedJinjaParts(input: JinjaPartRerenderInput): JinjaPartRerenderResult {
  const rerendered: string[] = [];
  const edited: string[] = [];
  const blanks: JinjaPartRerenderResult['blanks'] = [];
  const ops: { start: number; end: number; text: string; seq: number }[] = [];
  for (const part of extractSyncParts(input.sourceHtml)) {
    const raw = input.catalog.get(part.partId);
    if (raw === undefined || !containsJinja(raw)) continue;
    let next: string | null;
    let diagnostics: ReturnType<typeof renderPlainFilled>['diagnostics'];
    try {
      const asApproved = renderPlainFilled(raw, input.sourceValues).html;
      if (normalizePartHtml(asApproved) !== normalizePartHtml(part.html)) {
        edited.push(part.key);
        continue;
      }
      const rendered = renderPlainFilled(raw, input.targetValues);
      next = withPartId(rendered.html.trim(), part.partId);
      diagnostics = rendered.diagnostics;
    } catch {
      // 壊れた Jinja は描けないので、承認された HTML をそのまま写す側に倒す。
      edited.push(part.key);
      continue;
    }
    if (next === null) {
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
