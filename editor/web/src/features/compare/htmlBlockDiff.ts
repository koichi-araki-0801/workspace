// =============================================================================
// htmlBlockDiff.ts — レンダリング済みテンプレ HTML のクライアント側 block 差分
// =============================================================================
// 役割: 2 つのレンダリング済みテンプレート HTML を決定的に block 単位で diff する。
// 版の比較(compare)の結果画面で使う。
//
// 2 版は `renderJinja` で完全な HTML へレンダリングし、ブラウザ内でパースする。
// 各ドキュメントを明示的な `page-break-before/after: always` マーカー
// (editor が `geom.ts` 経由で書き出すものと同一)で A4 の `page` に分割し、page 内では
// `<body>` 直下の子要素である top-level の `block` に分割する。block は安定キーで
// 整列し、正規化したマークアップで比較するため、どの block が変わったかを正確に
// ハイライトし、その数("変更ブロック N 箇所")を数えられる。

export type BlockStatus = 'same' | 'changed' | 'added' | 'removed';

export interface DiffBlock {
  /** 2 版で同じ block を整列させるための安定キー。 */
  key: string;
  status: BlockStatus;
}

export interface DiffPage {
  index: number;
  changed: boolean;
  changedBlockCount: number;
  blocks: DiffBlock[];
  /** 前回ペイン用の page マークアップ。changed/removed block は既にハイライト済み。 */
  beforeHtml: string;
  /** 今回ペイン用の page マークアップ。changed/added block は既にハイライト済み。 */
  afterHtml: string;
}

export interface HtmlDiff {
  pages: DiffPage[];
  changedPageCount: number;
}

/** 変更 block に付与するハイライト用クラス(スタイルは `iframe` 内で定義)。 */
export const HL_CHANGED = 'cmp-changed';
export const HL_ADDED = 'cmp-added';
export const HL_REMOVED = 'cmp-removed';

function parseBody(html: string): HTMLElement {
  return new DOMParser().parseFromString(html, 'text/html').body;
}

function topLevelBlocks(body: HTMLElement): HTMLElement[] {
  return Array.from(body.children) as HTMLElement[];
}

function hasBreak(el: HTMLElement, which: 'before' | 'after'): boolean {
  const style = (el.getAttribute('style') ?? '').toLowerCase();
  return (
    new RegExp(`page-break-${which}\\s*:\\s*always`).test(style) ||
    new RegExp(`(^|[^-])break-${which}\\s*:\\s*(always|page)`).test(style)
  );
}

/** top-level の block を、明示的な page-break マーカーで page にグループ化する。 */
function paginate(blocks: HTMLElement[]): HTMLElement[][] {
  const pages: HTMLElement[][] = [[]];
  for (const el of blocks) {
    let cur = pages[pages.length - 1];
    if (hasBreak(el, 'before') && cur.length > 0) {
      pages.push([]);
      cur = pages[pages.length - 1];
    }
    cur.push(el);
    if (hasBreak(el, 'after')) pages.push([]);
  }
  if (pages.length > 1 && pages[pages.length - 1].length === 0) pages.pop();
  return pages;
}

/** block のアンカー: catalog part id → element id → 先頭 class → tag 名 の順で決める。 */
function rawKey(el: HTMLElement): string {
  return (
    el.getAttribute('data-part-id') ||
    el.id ||
    (el.classList[0] ? `.${el.classList[0]}` : '') ||
    el.tagName.toLowerCase()
  );
}

/** page 内で重複するアンカーを出現順で一意化する(".x#1", ".x#2")。 */
function keyedBlocks(page: HTMLElement[]): { key: string; el: HTMLElement }[] {
  const seen = new Map<string, number>();
  return page.map((el) => {
    const base = rawKey(el);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return { key: `${base}#${n}`, el };
  });
}

function normalize(el: HTMLElement): string {
  return el.outerHTML.replace(/\s+/g, ' ').trim();
}

function renderSide(
  items: { key: string; el: HTMLElement }[],
  statusOf: Map<string, BlockStatus>,
  side: 'before' | 'after',
): string {
  return items
    .map(({ key, el }) => {
      const status = statusOf.get(key) ?? 'same';
      const clone = el.cloneNode(true) as HTMLElement;
      if (status === 'changed') clone.classList.add(HL_CHANGED);
      else if (status === 'added' && side === 'after') clone.classList.add(HL_ADDED);
      else if (status === 'removed' && side === 'before') clone.classList.add(HL_REMOVED);
      return clone.outerHTML;
    })
    .join('\n');
}

/** page の block キーの和集合: after の順を先に、続けて before のみの block を並べる。 */
function unionKeys(
  after: { key: string }[],
  before: { key: string }[],
  afterMap: Map<string, HTMLElement>,
): string[] {
  return [
    ...after.map((b) => b.key),
    ...before.filter((b) => !afterMap.has(b.key)).map((b) => b.key),
  ];
}

/**
 * 整列済みの各キーを、正規化マークアップの比較で分類する: 両方に存在
 * (same/changed)、after のみ(added)、before のみ(removed)。ハイライト用の
 * キー別ステータス map と、順序付き block 一覧を返す。
 */
function classifyBlocks(
  keys: string[],
  beforeMap: Map<string, HTMLElement>,
  afterMap: Map<string, HTMLElement>,
): { statusOf: Map<string, BlockStatus>; blocks: DiffBlock[] } {
  const statusOf = new Map<string, BlockStatus>();
  const blocks: DiffBlock[] = [];
  for (const key of keys) {
    const a = afterMap.get(key);
    const bf = beforeMap.get(key);
    let status: BlockStatus;
    if (a && bf) status = normalize(a) === normalize(bf) ? 'same' : 'changed';
    else if (a) status = 'added';
    else status = 'removed';
    statusOf.set(key, status);
    blocks.push({ key, status });
  }
  return { statusOf, blocks };
}

function diffPage(index: number, beforePage: HTMLElement[], afterPage: HTMLElement[]): DiffPage {
  const before = keyedBlocks(beforePage);
  const after = keyedBlocks(afterPage);
  const beforeMap = new Map(before.map((b) => [b.key, b.el]));
  const afterMap = new Map(after.map((b) => [b.key, b.el]));

  const { statusOf, blocks } = classifyBlocks(
    unionKeys(after, before, afterMap),
    beforeMap,
    afterMap,
  );

  const changedBlockCount = blocks.filter((b) => b.status !== 'same').length;
  return {
    index,
    changed: changedBlockCount > 0,
    changedBlockCount,
    blocks,
    beforeHtml: renderSide(before, statusOf, 'before'),
    afterHtml: renderSide(after, statusOf, 'after'),
  };
}

/** 2 つのレンダリング済み HTML ドキュメント間の page/block 差分を構築する。 */
export function buildHtmlDiff(beforeHtml: string, afterHtml: string): HtmlDiff {
  const beforePages = paginate(topLevelBlocks(parseBody(beforeHtml)));
  const afterPages = paginate(topLevelBlocks(parseBody(afterHtml)));
  const pageCount = Math.max(beforePages.length, afterPages.length);

  const pages: DiffPage[] = [];
  for (let i = 0; i < pageCount; i++) {
    pages.push(diffPage(i, beforePages[i] ?? [], afterPages[i] ?? []));
  }
  return { pages, changedPageCount: pages.filter((p) => p.changed).length };
}
