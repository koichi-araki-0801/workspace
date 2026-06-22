// =============================================================================
// htmlBlockDiff.ts — レンダリング済みテンプレ HTML のクライアント側 細粒度差分
// =============================================================================
// 役割: 2 つのレンダリング済みテンプレート HTML を決定的に diff する。版の比較
// (compare)の結果画面で使う。
//
// 2 版は `renderJinja` で完全な HTML へレンダリングし、ブラウザ内でパースする。
// 各ドキュメントを明示的な `page-break-before/after: always` マーカー
// (editor が `geom.ts` 経由で書き出すものと同一)で A4 の `page` に分割し、page 内では
// `<body>` 直下の子要素である top-level の `block` に整列する。
//
// 整列した block のうち中身が変わったものは、ブロック全体を塗るのではなく **ツリーを
// 再帰的に降りて**変わった部分だけを着色する(粒度を細かくするのが目的):
//   - ネストした要素は同じ安定キーで整列し、変わった子要素・追加/削除された子要素
//     だけを着色する。
//   - テキストは語句単位(英数字は単語、CJK は 1 文字)で LCS 差分を取り、挿入された
//     語句(緑)・削除された語句(赤)だけを `<span>` で包む。
// これにより「どの文字が変わったか」までハイライトでき、変更 block 数も数えられる。

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
  /** 前回ペイン用の page マークアップ。削除/変更箇所は既にハイライト済み。 */
  beforeHtml: string;
  /** 今回ペイン用の page マークアップ。追加/変更箇所は既にハイライト済み。 */
  afterHtml: string;
}

export interface HtmlDiff {
  pages: DiffPage[];
  changedPageCount: number;
}

// ── 1. ハイライト用クラス(スタイルは `iframe` 内で定義) ──────────────────────
// block 級(要素まるごと): 追加/削除された要素、または着色しきれない変更の保険。
export const HL_CHANGED = 'cmp-changed';
export const HL_ADDED = 'cmp-added';
export const HL_REMOVED = 'cmp-removed';
// 語句級(テキスト中の差分): 挿入語句(after ペイン)・削除語句(before ペイン)。
export const HL_INS = 'cmp-ins';
export const HL_DEL = 'cmp-del';

// ── 2. パースと page 分割 ─────────────────────────────────────────────────
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

// ── 3. ノードの整列キー ───────────────────────────────────────────────────
function isElement(n: Node): n is HTMLElement {
  return n.nodeType === Node.ELEMENT_NODE;
}
function isText(n: Node): n is Text {
  return n.nodeType === Node.TEXT_NODE;
}

/** element のアンカー: catalog part id → element id → 先頭 class → tag 名 の順で決める。 */
function rawKey(el: HTMLElement): string {
  return (
    el.getAttribute('data-part-id') ||
    el.id ||
    (el.classList[0] ? `.${el.classList[0]}` : '') ||
    el.tagName.toLowerCase()
  );
}

/** diff の対象にする子ノード: 要素ノードと、空白のみでないテキストノード。 */
function childUnits(parent: Node): Node[] {
  return Array.from(parent.childNodes).filter(
    (n) => isElement(n) || (isText(n) && (n.textContent ?? '').trim() !== ''),
  );
}

/** ノードの整列キー(要素は `rawKey`、テキストは `#text`)。 */
function unitKey(n: Node): string {
  return isElement(n) ? rawKey(n) : '#text';
}

/** 親の中で重複するキーを出現順で一意化する("#text#1", ".row#2")。 */
function keyedUnits(parent: Node): { key: string; node: Node }[] {
  const seen = new Map<string, number>();
  return childUnits(parent).map((node) => {
    const base = unitKey(node);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return { key: `${base}#${n}`, node };
  });
}

// ── 4. 正規化と同一判定 ───────────────────────────────────────────────────
function normalize(el: HTMLElement): string {
  return el.outerHTML.replace(/\s+/g, ' ').trim();
}
function collapse(text: string | null): string {
  return (text ?? '').replace(/\s+/g, ' ').trim();
}

/** 2 ノードがマークアップ上同一か(要素は正規化 outerHTML、テキストは折り畳み比較)。 */
function sameMarkup(x: Node, y: Node): boolean {
  if (isElement(x) && isElement(y)) return normalize(x) === normalize(y);
  if (isText(x) && isText(y)) return collapse(x.textContent) === collapse(y.textContent);
  return false;
}

// ── 5. 語句単位のテキスト diff ────────────────────────────────────────────
// 英数字の連なりは 1 単語、CJK・記号・空白はそれぞれ 1 トークンに刻む。日本語は
// 文字単位、英語は単語単位という直感的な粒度になる。
function tokenize(text: string): string[] {
  return text.match(/[A-Za-z0-9]+|\s+|[^A-Za-z0-9\s]/gu) ?? [];
}

type DiffOp = { type: 'same' | 'del' | 'ins'; text: string };

/** 2 トークン列の LCS から、前後を再構成できる順序付き編集列を作る。 */
function diffTokens(a: string[], b: string[]): DiffOp[] {
  const n = a.length;
  const m = b.length;
  // lcs[i][j] = a[i..], b[j..] の最長共通部分列長。
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: 'same', text: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      ops.push({ type: 'del', text: a[i++] });
    } else {
      ops.push({ type: 'ins', text: b[j++] });
    }
  }
  while (i < n) ops.push({ type: 'del', text: a[i++] });
  while (j < m) ops.push({ type: 'ins', text: b[j++] });
  return ops;
}

/** 片側ペインの再構成: 共通語句は素のテキスト、差分語句は `<span>` で着色して包む。 */
function sideNodes(ops: DiffOp[], doc: Document, side: 'before' | 'after'): Node[] {
  const markType = side === 'before' ? 'del' : 'ins';
  const cls = side === 'before' ? HL_DEL : HL_INS;
  const nodes: Node[] = [];
  let plain = '';
  let marked = '';
  const flushPlain = () => {
    if (plain) {
      nodes.push(doc.createTextNode(plain));
      plain = '';
    }
  };
  const flushMarked = () => {
    if (marked) {
      const span = doc.createElement('span');
      span.className = cls;
      span.textContent = marked;
      nodes.push(span);
      marked = '';
    }
  };
  for (const op of ops) {
    if (op.type === markType) {
      flushPlain();
      marked += op.text;
    } else if (op.type === 'same') {
      flushMarked();
      plain += op.text;
    }
    // 反対側だけの編集(before における ins 等)はこのペインには現れないので無視。
  }
  flushPlain();
  flushMarked();
  return nodes;
}

/** 対応するテキストノード対を語句 diff し、各ノードを着色済みノード列で置換する。 */
function inlineWordDiff(beforeText: Text, afterText: Text): void {
  const ops = diffTokens(
    tokenize(beforeText.textContent ?? ''),
    tokenize(afterText.textContent ?? ''),
  );
  const bDoc = beforeText.ownerDocument;
  const aDoc = afterText.ownerDocument;
  beforeText.replaceWith(...sideNodes(ops, bDoc, 'before'));
  afterText.replaceWith(...sideNodes(ops, aDoc, 'after'));
}

// ── 6. ノード木の再帰 diff(クローンを直接書き換える) ──────────────────────
function markWhole(node: Node, cls: string): void {
  if (isElement(node)) node.classList.add(cls);
  else if (isText(node) && node.textContent) {
    const span = node.ownerDocument.createElement('span');
    span.className = cls;
    span.textContent = node.textContent;
    node.replaceWith(span);
  }
}

/**
 * 同じキーで対応する 2 要素(同一 tag)の子を整列し、変わった部分だけを着色する。
 * 何かを着色できたら `true`、属性のみ差分などで降りても着色対象が無ければ `false`。
 * `before`/`after` はいずれも書き換え用クローン。
 */
function diffElement(before: HTMLElement, after: HTMLElement): boolean {
  const bUnits = keyedUnits(before);
  const aUnits = keyedUnits(after);
  const bMap = new Map(bUnits.map((u) => [u.key, u.node]));
  const aMap = new Map(aUnits.map((u) => [u.key, u.node]));
  // after の出現順を先に、続けて after に無い before のみのキーを並べる。
  const keys = [
    ...aUnits.map((u) => u.key),
    ...bUnits.filter((u) => !aMap.has(u.key)).map((u) => u.key),
  ];

  let marked = false;
  for (const key of keys) {
    const b = bMap.get(key);
    const a = aMap.get(key);
    if (a && b) {
      if (sameMarkup(a, b)) continue; // 完全一致の部分木はそのまま残す
      if (isText(a) && isText(b)) {
        inlineWordDiff(b, a);
        marked = true;
      } else if (isElement(a) && isElement(b) && a.tagName === b.tagName) {
        // 同 tag の要素対はさらに降りる。降りても何も着けられなければ保険で要素ごと。
        if (!diffElement(b, a)) {
          markWhole(b, HL_CHANGED);
          markWhole(a, HL_CHANGED);
        }
        marked = true;
      } else {
        // 同スロットだが種別/tag が違う → 削除+追加として扱う。
        markWhole(b, HL_REMOVED);
        markWhole(a, HL_ADDED);
        marked = true;
      }
    } else if (a) {
      markWhole(a, HL_ADDED);
      marked = true;
    } else if (b) {
      markWhole(b, HL_REMOVED);
      marked = true;
    }
  }
  return marked;
}

// ── 7. top-level block の整列と分類 ───────────────────────────────────────
function keyedBlocks(page: HTMLElement[]): { key: string; el: HTMLElement }[] {
  const seen = new Map<string, number>();
  return page.map((el) => {
    const base = rawKey(el);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return { key: `${base}#${n}`, el };
  });
}

interface RenderedBlock {
  status: BlockStatus;
  /** before ペインに出すマークアップ(着色済み)。after のみの block では空。 */
  beforeHtml: string;
  /** after ペインに出すマークアップ(着色済み)。before のみの block では空。 */
  afterHtml: string;
}

/** 1 つの top-level block 対を分類し、両ペイン分の着色済みマークアップを作る。 */
function renderBlock(
  before: HTMLElement | undefined,
  after: HTMLElement | undefined,
): RenderedBlock {
  if (after && before) {
    if (sameMarkup(after, before)) {
      return { status: 'same', beforeHtml: before.outerHTML, afterHtml: after.outerHTML };
    }
    const bClone = before.cloneNode(true) as HTMLElement;
    const aClone = after.cloneNode(true) as HTMLElement;
    if (after.tagName === before.tagName) {
      if (!diffElement(bClone, aClone)) {
        bClone.classList.add(HL_CHANGED);
        aClone.classList.add(HL_CHANGED);
      }
    } else {
      bClone.classList.add(HL_CHANGED);
      aClone.classList.add(HL_CHANGED);
    }
    return { status: 'changed', beforeHtml: bClone.outerHTML, afterHtml: aClone.outerHTML };
  }
  if (after) {
    const clone = after.cloneNode(true) as HTMLElement;
    clone.classList.add(HL_ADDED);
    return { status: 'added', beforeHtml: '', afterHtml: clone.outerHTML };
  }
  // before のみ(after が undefined)。
  const clone = (before as HTMLElement).cloneNode(true) as HTMLElement;
  clone.classList.add(HL_REMOVED);
  return { status: 'removed', beforeHtml: clone.outerHTML, afterHtml: '' };
}

function diffPage(index: number, beforePage: HTMLElement[], afterPage: HTMLElement[]): DiffPage {
  const before = keyedBlocks(beforePage);
  const after = keyedBlocks(afterPage);
  const beforeMap = new Map(before.map((b) => [b.key, b.el]));
  const afterMap = new Map(after.map((b) => [b.key, b.el]));

  const rendered = new Map<string, RenderedBlock>();
  const blocks: DiffBlock[] = [];
  // after の出現順を先に、続けて before のみの block を並べて分類する。
  const keys = [
    ...after.map((b) => b.key),
    ...before.filter((b) => !afterMap.has(b.key)).map((b) => b.key),
  ];
  for (const key of keys) {
    const r = renderBlock(beforeMap.get(key), afterMap.get(key));
    rendered.set(key, r);
    blocks.push({ key, status: r.status });
  }

  const changedBlockCount = blocks.filter((b) => b.status !== 'same').length;
  return {
    index,
    changed: changedBlockCount > 0,
    changedBlockCount,
    blocks,
    // 各ペインは自分の版の block 並び順で組み立てる(削除/追加もその順で現れる)。
    beforeHtml: before.map((b) => rendered.get(b.key)?.beforeHtml ?? '').join('\n'),
    afterHtml: after.map((b) => rendered.get(b.key)?.afterHtml ?? '').join('\n'),
  };
}

/** 2 つのレンダリング済み HTML ドキュメント間の page/細粒度差分を構築する。 */
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
