// =============================================================================
// partMarks.ts — 変更パーツの通し番号(①②③)とパーツ名
// =============================================================================
// 承認タブと編集画面が同じ番号を振るための共有部品。番号は差分(`HtmlDiff`)の変更のあるパーツへ
// ページ順・紙面の並び順で 1 から振る。名前は業務名 → 先頭の文字 → 「ページN・パーツM」の順。
/// <reference lib="dom" />

import type { DiffBlock, HtmlDiff } from './htmlDiff.js';
import type { HtmlParser } from './htmlParser.js';
import { reviewedPageOrder } from './reviewedCandidate.js';

export type ChangedPartKind = 'changed' | 'added' | 'removed';

export interface ChangedPart {
  /** 1 始まりの通し番号。 */
  no: number;
  /** `DiffBlock.partKey`(判定のキー)。 */
  partKey: string;
  /** 確定版側のキー(承認タブのコメント宛先)。確定版に無ければ null。 */
  beforePartKey: string | null;
  kind: ChangedPartKind;
  /** 0 始まり。左面に出るページ(左面に無ければ null)。 */
  beforePage: number | null;
  /** 0 始まり。右面に出るページ(右面に無ければ null)。 */
  afterPage: number | null;
  /** 着色済み(`DiffBlock` と同じ)。 */
  beforeHtml: string;
  afterHtml: string;
  rawBeforeHtml: string;
  rawAfterHtml: string;
  /** 「ページN・パーツM」。 */
  label: string;
  coarse: boolean;
}

export const PART_NAME_MAX_CHARS = 20;

/**
 * 変更のあるパーツへ、ページ順・紙面の並び順(`reviewedPageOrder`)で 1 から番号を振る。
 * ページを移ったパーツは削除と追加の 2 つの block に同じ `partKey` で現れるので、1 つにまとめて
 * `changed` とし、左右のページを両方埋める。
 */
export function numberChangedParts(diff: HtmlDiff): ChangedPart[] {
  const parts: ChangedPart[] = [];
  const byKey = new Map<string, ChangedPart>();
  for (const page of diff.pages) {
    // 全キーを「残る」扱いにして、削除パーツを比較元での位置の近くへ差し込んだ並びを得る。
    const all = new Map<string, string>(
      [...page.beforeKeys, ...page.afterKeys, ...page.blocks.map((b) => b.key)].map((k) => [
        k,
        '1',
      ]),
    );
    const blockByKey = new Map<string, DiffBlock>(page.blocks.map((b) => [b.key, b]));
    for (const key of reviewedPageOrder(page.beforeKeys, page.afterKeys, all)) {
      const block = blockByKey.get(key);
      if (block === undefined || block.status === 'same') continue;
      const hasBefore = block.status !== 'added';
      const hasAfter = block.status !== 'removed';
      const existing = byKey.get(block.partKey);
      if (existing === undefined) {
        const part: ChangedPart = {
          no: parts.length + 1,
          partKey: block.partKey,
          beforePartKey: block.beforePartKey,
          kind: block.status,
          beforePage: hasBefore ? page.index : null,
          afterPage: hasAfter ? page.index : null,
          beforeHtml: block.beforeHtml,
          afterHtml: block.afterHtml,
          rawBeforeHtml: block.rawBeforeHtml,
          rawAfterHtml: block.rawAfterHtml,
          label: block.label,
          coarse: block.coarse,
        };
        parts.push(part);
        byKey.set(block.partKey, part);
        continue;
      }
      existing.kind = 'changed';
      existing.beforePartKey ??= block.beforePartKey;
      existing.coarse = existing.coarse || block.coarse;
      if (hasBefore && existing.beforePage === null) {
        existing.beforePage = page.index;
        existing.beforeHtml = block.beforeHtml;
        existing.rawBeforeHtml = block.rawBeforeHtml;
      }
      if (hasAfter && existing.afterPage === null) {
        existing.afterPage = page.index;
        existing.afterHtml = block.afterHtml;
        existing.rawAfterHtml = block.rawAfterHtml;
      }
    }
  }
  return parts;
}

/** 空白を詰め、`maxChars` 文字を超えたら `…` で切る。 */
export function partNameFromText(text: string, maxChars: number = PART_NAME_MAX_CHARS): string {
  const chars = Array.from(text.replace(/\s+/g, ' ').trim());
  return chars.length > maxChars ? `${chars.slice(0, maxChars).join('')}…` : chars.join('');
}

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

/** 最初の空でないテキストを返す。`TreeWalker` は linkedom に無いので `childNodes` を再帰で辿る。 */
function firstText(node: Node): string {
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === TEXT_NODE) {
      const text = (child.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (text !== '') return text;
    } else if (child.nodeType === ELEMENT_NODE) {
      const el = child as Element;
      // 赤入れの旧文言は名前にしない。
      if (el.hasAttribute('data-redline')) continue;
      const found = firstText(el);
      if (found !== '') return found;
    }
  }
  return '';
}

/** パーツの先頭の文字から作る名前。文字が無ければ空。表は最初のセルの文字になる。 */
export function partNameOfElement(el: Element): string {
  return partNameFromText(firstText(el));
}

export function partNameOfHtml(html: string, parse: HtmlParser): string {
  return partNameOfElement(parse(html).body);
}

/** 業務名 → 先頭の文字 → 「ページN・パーツM」の順で表示名を決める。 */
export function partDisplayName(input: {
  catalogName?: string;
  firstText: string;
  fallbackLabel: string;
}): string {
  if (input.catalogName !== undefined && input.catalogName !== '') return input.catalogName;
  return input.firstText !== '' ? input.firstText : input.fallbackLabel;
}
