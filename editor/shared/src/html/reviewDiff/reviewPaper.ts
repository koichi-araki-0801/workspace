// =============================================================================
// reviewPaper.ts — 承認タブの左右の紙面の本文(判定・空き枠・番号の属性付き)
// =============================================================================
// 役割: 差分(`HtmlDiff`)に判定を当て、承認タブの左(変更前=現行版)・右(変更後=申請版)の紙面の
// 本文 HTML を組む。右面は申請版を基準に、却下した変更・削除だけ現行版へ戻す(D9)。相手の面にだけ
// あるパーツは空き枠(`data-review-ghost`)で場所を空け、変更パーツには `data-review-no` を付ける。
// 文書側は属性と文言だけを持ち、色・枠・番号札の見た目はホスト(server)が描く。`style` 属性は
// 書かない(Vivliostyle は `style` 属性を写さないため)。申請者の本文に同じ属性・差分の色の
// class が書かれていてもホストが自分の札と取り違えないよう、断片から前もって外す(`cleanPiece`)。
// `buildReviewedHtmlCandidate` とは別物で、そちらは未判定を現行版のままにする(最終確定の候補)。
// こちらは未判定を申請版のまま見せる。
/// <reference lib="dom" />

import { type DiffBlock, type DiffPage, HL_DEL, HL_INS, type HtmlDiff } from './htmlDiff.js';
import type { HtmlParser } from './htmlParser.js';
import { PAGEBREAK_CLASS } from './pageSplit.js';
import type { ChangedPart } from './partMarks.js';
import { reviewedPageOrder } from './reviewedCandidate.js';

/** 変更パーツの番号(文字列)。ホストが番号札を描き、パーツへ移る手がかりにする。 */
export const REVIEW_NO_ATTR = 'data-review-no';
/** 空き枠の印。値は `added` | `removed` | `rejected-added`。 */
export const REVIEW_GHOST_ATTR = 'data-review-ghost';
/** 却下のため現行版のままであることの印。 */
export const REVIEW_KEEP_ATTR = 'data-review-keep';

export const REVIEW_GHOST_TEXT = {
  added: '（なし・新規追加）',
  removed: '（なし・削除）',
  rejectedAdded: '（却下のため追加しない）',
} as const;
export const REVIEW_KEEP_TEXT = '却下のため現行版のまま';

export type PaperDecision = 'pending' | 'approved' | 'rejected';

export interface ReviewPaper {
  html: string;
  /** 論理ページの数(改ページの区切りで数える)。物理ページの絞り込みには使わない。 */
  pageCount: number;
}

type GhostKind = 'added' | 'removed' | 'rejected-added';

const GHOST_TEXT: Record<GhostKind, string> = {
  added: REVIEW_GHOST_TEXT.added,
  removed: REVIEW_GHOST_TEXT.removed,
  'rejected-added': REVIEW_GHOST_TEXT.rejectedAdded,
};

interface Piece {
  html: string;
  /** 空き枠・地の文のように、改ページの指定を持たないか。 */
  breakAfter: boolean;
}

// ── 1. 申請者の本文から紙面の目印を外す ──────────────────────────────────────
/** ホストが紙面の目印として読む属性の接頭辞(`data-review-no` など。札の印 `data-review-badge` も)。 */
const REVIEW_ATTR_PREFIX = 'data-review-';
/** 目印らしい文字列が無い断片は parse し直さずにそのまま返す(属性名は大小を問わない)。 */
const MARK_HINT_RE = new RegExp(`${REVIEW_ATTR_PREFIX}|${HL_INS}|${HL_DEL}`, 'i');

const isHlClass = (c: string): boolean => c.toLowerCase() === HL_INS || c.toLowerCase() === HL_DEL;
/** HTML の class の区切りは ASCII の空白だけ(全角空白などは class 名の一部)。 */
const classesOf = (el: Element): string[] =>
  (el.getAttribute('class') ?? '').split(/[ \t\n\f\r]+/).filter((c) => c !== '');

/** 要素が `data-review-*` か `cmp-ins` / `cmp-del` の class を持つか。 */
function hasMarks(el: Element): boolean {
  return (
    el.getAttributeNames().some((n) => n.toLowerCase().startsWith(REVIEW_ATTR_PREFIX)) ||
    classesOf(el).some(isHlClass)
  );
}

/** 要素 1 つから `data-review-*` と、`stripHl` なら `cmp-ins` / `cmp-del` の class を外す。 */
function stripMarks(el: Element, stripHl: boolean): void {
  for (const name of el.getAttributeNames()) {
    if (name.toLowerCase().startsWith(REVIEW_ATTR_PREFIX)) el.removeAttribute(name);
  }
  if (!stripHl || !el.hasAttribute('class')) return;
  const kept = classesOf(el).filter((c) => !isHlClass(c));
  if (kept.length === 0) el.removeAttribute('class');
  else el.setAttribute('class', kept.join(' '));
}

/**
 * 着色済みの木 `h` のうち、差分が足した `<span>`(原文のテキストノードを置き換えたもの)を集める。
 * 差分は原文の複製のテキストノードを「テキスト + 子要素を持たない `<span>`」の並びへ置き換える
 * だけで、要素を足したり並べ替えたりしない。だから原文 `r` と子を順に突き合わせ、原文のテキストの
 * 位置に現れた `<span>` だけが差分のもの。形が食い違えば `false`(呼び手は着色を捨てる)。
 */
function collectDiffSpans(r: Node, h: Node, spans: Set<Element>): boolean {
  const hc = Array.from(h.childNodes);
  let j = 0;
  for (const c of Array.from(r.childNodes)) {
    if (c.nodeType === 3) {
      let need = (c.textContent ?? '').length;
      while (need > 0) {
        const n = hc[j++];
        if (n === undefined) return false;
        if (n.nodeType === 1) {
          const el = n as Element;
          if (el.tagName !== 'SPAN' || el.childElementCount > 0) return false;
          spans.add(el);
        } else if (n.nodeType !== 3) return false;
        need -= (n.textContent ?? '').length;
      }
      if (need !== 0) return false;
      continue;
    }
    const n = hc[j++];
    if (n === undefined || n.nodeType !== c.nodeType) return false;
    if (c.nodeType === 1) {
      if ((n as Element).tagName !== (c as Element).tagName) return false;
      if (!collectDiffSpans(c, n, spans)) return false;
    }
  }
  return j === hc.length;
}

/**
 * 断片から申請者の目印を外した `body` を返す。`highlightHtml` があれば着色済みを基にし、差分が
 * 足した `<span>` の `cmp-ins` / `cmp-del` だけを残す。原文と突き合わせられなければ着色を捨てて
 * 原文を基にする(色は補助で、判定の正典は親画面の文字の差分)。目印が無ければ `null`(触らない)。
 */
function cleanPiece(rawHtml: string, highlightHtml: string | undefined, parse: HtmlParser) {
  if (!MARK_HINT_RE.test(rawHtml)) return null;
  const rawBody = parse(rawHtml).body;
  // 文字列が `<style>` の中身や地の文にあるだけなら組み直さない(`<style>` 始まりの断片は
  // ブラウザの parse で head へ移り、body から組み直すと落ちる)。
  if (!Array.from(rawBody.querySelectorAll('*')).some(hasMarks)) return null;
  let body = rawBody;
  const spans = new Set<Element>();
  if (highlightHtml !== undefined) {
    const hBody = parse(highlightHtml).body;
    if (collectDiffSpans(rawBody, hBody, spans)) body = hBody;
    else spans.clear();
  }
  for (const el of Array.from(body.querySelectorAll('*'))) stripMarks(el, !spans.has(el));
  return body;
}

// ── 2. 断片へ自分の属性を付ける ───────────────────────────────────────────────
/** 断片の先頭の要素へ属性を付ける。先頭が要素でない(地の文だけ・`<style>` 等)なら触らない。 */
function withAttrs(
  piece: { raw: string; highlighted?: string },
  attrs: readonly [string, string][],
  parse: HtmlParser,
): string {
  const html = piece.highlighted ?? piece.raw;
  const cleaned = cleanPiece(piece.raw, piece.highlighted, parse);
  if (attrs.length === 0) return cleaned === null ? html : cleaned.innerHTML;
  const body = cleaned ?? parse(html).body;
  const first = Array.from(body.childNodes).find(
    (n) => n.nodeType !== 3 || (n.textContent ?? '').trim() !== '',
  );
  const untouched = cleaned === null ? html : body.innerHTML;
  if (first === undefined || first.nodeType !== 1) return untouched;
  const el = first as Element;
  if (el.tagName === 'STYLE' || el.tagName === 'SCRIPT') return untouched;
  for (const [name, value] of attrs) el.setAttribute(name, value);
  return body.innerHTML;
}

function ghost(kind: GhostKind, no: number | undefined): Piece {
  const noAttr = no === undefined ? '' : ` ${REVIEW_NO_ATTR}="${no}"`;
  return {
    html: `<div ${REVIEW_GHOST_ATTR}="${kind}"${noAttr}>${GHOST_TEXT[kind]}</div>`,
    breakAfter: false,
  };
}

/** 1 つの block が、指定の面でどう出るか。 */
function pieceOf(input: {
  block: DiffBlock;
  side: 'before' | 'after';
  decision: PaperDecision;
  highlight: boolean;
  no: number | undefined;
  parse: HtmlParser;
}): Piece {
  const { block, side, decision, highlight, no, parse } = input;
  const attrOf = (keep: boolean): [string, string][] => {
    const attrs: [string, string][] = [];
    if (no !== undefined) attrs.push([REVIEW_NO_ATTR, String(no)]);
    if (keep) attrs.push([REVIEW_KEEP_ATTR, '']);
    return attrs;
  };
  const beforePiece = (keep: boolean): Piece => ({
    html: withAttrs(
      {
        raw: block.rawBeforeHtml,
        highlighted: highlight && !keep ? block.beforeHtml : undefined,
      },
      attrOf(keep),
      parse,
    ),
    breakAfter: block.beforeBreakAfter,
  });
  const afterPiece = (): Piece => ({
    html: withAttrs(
      { raw: block.rawAfterHtml, highlighted: highlight ? block.afterHtml : undefined },
      attrOf(false),
      parse,
    ),
    breakAfter: block.afterBreakAfter,
  });

  if (block.status === 'same') {
    return side === 'before'
      ? {
          html: withAttrs({ raw: block.rawBeforeHtml }, [], parse),
          breakAfter: block.beforeBreakAfter,
        }
      : {
          html: withAttrs({ raw: block.rawAfterHtml }, [], parse),
          breakAfter: block.afterBreakAfter,
        };
  }
  if (side === 'before') {
    return block.status === 'added' ? ghost('added', no) : beforePiece(false);
  }
  const rejected = decision === 'rejected';
  if (block.status === 'changed') return rejected ? beforePiece(true) : afterPiece();
  if (block.status === 'added') return rejected ? ghost('rejected-added', no) : afterPiece();
  return rejected ? beforePiece(true) : ghost('removed', no);
}

function pageText(
  page: DiffPage,
  input: {
    side: 'before' | 'after';
    decisionOf: (partKey: string) => PaperDecision;
    highlight: boolean;
    numberOf: ReadonlyMap<string, number>;
    parse: HtmlParser;
  },
): { text: string; endsWithInlineBreak: boolean } {
  const pieces = new Map<string, Piece>();
  for (const block of page.blocks) {
    pieces.set(
      block.key,
      pieceOf({
        block,
        side: input.side,
        decision: input.decisionOf(block.partKey),
        highlight: input.highlight,
        no: block.status === 'same' ? undefined : input.numberOf.get(block.partKey),
        parse: input.parse,
      }),
    );
  }
  const selected = new Map([...pieces].map(([k, p]) => [k, p.html]));
  // 右面は申請版の並びを基準に、左面は比較元の並びを基準に、相手の面にだけあるキーを差し込む。
  const order =
    input.side === 'after'
      ? reviewedPageOrder(page.beforeKeys, page.afterKeys, selected)
      : reviewedPageOrder(page.afterKeys, page.beforeKeys, selected);
  const shown = order.map((key) => pieces.get(key)).filter((p): p is Piece => p !== undefined);
  return {
    text: shown
      .map((p) => p.html)
      .filter((h) => h !== '')
      .join('\n'),
    endsWithInlineBreak: shown.at(-1)?.breakAfter ?? false,
  };
}

/**
 * 承認タブの片面の本文を組む。ページは `buildReviewedHtmlCandidate` と同じく改ページの区切りで
 * つなぐ。その面に無いページ(反対側にだけあるページ)は、中身が空なら出さない。
 */
export function buildReviewPaper(input: {
  diff: HtmlDiff;
  parts: readonly ChangedPart[];
  decisionOf: (partKey: string) => PaperDecision;
  side: 'before' | 'after';
  highlight: boolean;
  parse: HtmlParser;
}): ReviewPaper {
  const { diff, side } = input;
  const numberOf = new Map(input.parts.map((p) => [p.partKey, p.no]));
  const ownPageCount = side === 'after' ? diff.afterPageCount : diff.beforePageCount;
  const sep = `\n<div class="${PAGEBREAK_CLASS}"></div>\n`;
  let html = '';
  let pageCount = 0;
  let previousEndsWithInlineBreak = false;
  diff.pages.forEach((page, index) => {
    const { text, endsWithInlineBreak } = pageText(page, {
      side,
      decisionOf: input.decisionOf,
      highlight: input.highlight,
      numberOf,
      parse: input.parse,
    });
    const appended = index >= ownPageCount;
    if (appended && text === '') return;
    if (pageCount > 0) html += appended && previousEndsWithInlineBreak ? '\n' : sep;
    html += text;
    pageCount++;
    previousEndsWithInlineBreak = text !== '' && endsWithInlineBreak;
  });
  return { html, pageCount };
}
