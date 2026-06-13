/**
 * Deterministic, client-side block-level diff of two rendered template HTML
 * documents. Used by the 版の比較 (compare) result screen.
 *
 * The two versions are rendered to full HTML (via `renderJinja`) and parsed in
 * the browser. We split each document into A4 *pages* (separated by explicit
 * `page-break-before/after: always` markers — the same ones the editor writes
 * through `geom.ts`) and, within a page, into top-level *blocks* (the direct
 * children of `<body>`). Blocks are aligned by a stable key and compared by
 * normalized markup, so we can highlight exactly which blocks changed and count
 * them ("変更ブロック N 箇所").
 */

export type BlockStatus = 'same' | 'changed' | 'added' | 'removed';

export interface DiffBlock {
  /** stable key used to align the same block across the two versions */
  key: string;
  status: BlockStatus;
}

export interface DiffPage {
  index: number;
  changed: boolean;
  changedBlockCount: number;
  blocks: DiffBlock[];
  /** page markup for the 前回 pane, changed/removed blocks already highlighted */
  beforeHtml: string;
  /** page markup for the 今回 pane, changed/added blocks already highlighted */
  afterHtml: string;
}

export interface HtmlDiff {
  pages: DiffPage[];
  changedPageCount: number;
}

/** Highlight classes injected onto changed blocks (styled inside the iframe). */
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

/** Group top-level blocks into pages at explicit page-break markers. */
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

/** A block's anchor: catalog part id → element id → first class → tag name. */
function rawKey(el: HTMLElement): string {
  return (
    el.getAttribute('data-part-id') ||
    el.id ||
    (el.classList[0] ? `.${el.classList[0]}` : '') ||
    el.tagName.toLowerCase()
  );
}

/** Disambiguate repeated anchors within a page by occurrence (".x#1", ".x#2"). */
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

function diffPage(index: number, beforePage: HTMLElement[], afterPage: HTMLElement[]): DiffPage {
  const before = keyedBlocks(beforePage);
  const after = keyedBlocks(afterPage);
  const beforeMap = new Map(before.map((b) => [b.key, b.el]));
  const afterMap = new Map(after.map((b) => [b.key, b.el]));

  // Union of keys: after's order first, then before-only blocks.
  const keys = [
    ...after.map((b) => b.key),
    ...before.filter((b) => !afterMap.has(b.key)).map((b) => b.key),
  ];

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

/** Build the page/block diff between two rendered HTML documents. */
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
