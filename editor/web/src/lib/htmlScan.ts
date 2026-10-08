// =============================================================================
// htmlScan.ts — Jinja を伏せた原文の HTML 構造走査
// =============================================================================
// 作成タブの往復で「この位置は表の行の間か、属性値の中か、SVG の中か」を原文の位置で答える。
// DOM パーサは使わない。パーサは表の中のテキストを追い出す(foster parenting)など原文の位置を
// 保たないため、位置を保つ近似として開始・終了タグだけを読み、開いた要素のスタックを持つ。
// 入力は Jinja トークンを同じ長さの `J` で伏せた文字列(`maskJinja`)なので、トークン内の引用符や
// `>` が属性の解釈を狂わせない。近似が外れる壊れた HTML は呼び出し側の自己検査が受け止める。

import {
  commentEnd,
  findRawTextEnd,
  isAsciiAlpha,
  isHtmlSpace,
  isTagNameEnd,
  lexJinja,
  maskRanges,
  newCommentEndMemo,
  RAW_TEXT_ELEMENTS,
} from '@editor/shared';

// ── 1. 型 ──

export interface ScannedElement {
  tag: string;
  start: number;
  startTagEnd: number;
  end: number;
  parent: ScannedElement | null;
  foreign: 'svg' | 'math' | null;
  implicitlyClosed: boolean;
}

export type PositionContext =
  | { kind: 'text'; parent: ScannedElement | null }
  | { kind: 'attrValue'; element: ScannedElement }
  | { kind: 'tagOther'; element: ScannedElement }
  | { kind: 'rawText'; element: ScannedElement }
  // コメント、宣言、`</` + 伏せ字(ブラウザが > まで偽コメントとして読み捨てる)、
  // 対応しない終了タグ(同じく > まで読み捨てる)
  | { kind: 'htmlComment' };

export interface HtmlScan {
  elements: ScannedElement[];
  contextAt(pos: number): PositionContext;
  /**
   * 範囲を中身として丸ごと含む最も内側(最も狭い)の要素。無ければ null。`includeStartTag` を立てると
   * 開始タグの中から始まる範囲も覆う(属性値をまたぐブロックは開始タグの中から始まる)。
   */
  innermostContaining(start: number, end: number, includeStartTag?: boolean): ScannedElement | null;
}

// ── 2. 伏せ字 ──

/** 伏せ字の 1 文字。規則表の判定も、トークンが占める位置をこの文字で見分ける。 */
const MASK_CHAR = 'J';

/**
 * トークンの範囲を同じ長さの `J` に置き換える。改行は残し、行の数を変えない。申請の関所
 * (`shared/src/security/editingMarkers.ts`)も同じ伏せ方の写しを読むので、`maskRanges` を共有する。
 */
export function maskJinja(src: string, tokens: readonly { start: number; end: number }[]): string {
  return maskRanges(src, tokens, MASK_CHAR);
}

/**
 * `src` の Jinja を伏せて走査する。`tokens` を省くと自分で字句解析し、解析できない原文は伏せずに
 * そのまま走査する(呼び出し側は壊れた原文でも位置の目安だけは要る)。
 */
export function scanMaskedHtml(
  src: string,
  tokens?: readonly { start: number; end: number }[],
): HtmlScan {
  if (tokens) return scanHtml(maskJinja(src, tokens));
  const lexed = lexJinja(src);
  return scanHtml(lexed.ok ? maskJinja(src, lexed.tokens) : src);
}

// ── 3. 規則表 ──

const VOID = new Set('area base br col embed hr img input link meta source track wbr'.split(' '));
const P_CLOSERS = new Set(
  (
    'address article aside blockquote details div dl fieldset figcaption figure footer form ' +
    'h1 h2 h3 h4 h5 h6 header hr main nav ol p pre section table ul'
  ).split(' '),
);
const TABLE_SECTIONS = ['thead', 'tbody', 'tfoot'];
/** HTML の「スコープ」の境界。この内側の開始タグは外側の要素を暗黙に閉じない。 */
const SCOPE_BOUNDARY = new Set([
  'html',
  'template',
  'object',
  'marquee',
  'applet',
  'foreignobject',
]);
const P_STOPS = ['td', 'th', 'table', 'caption', 'button'];

/**
 * 開始タグが暗黙に閉じる要素と、探索を打ち切る境界。境界の外の同名要素は別の入れ子なので
 * 閉じない(表のセルの中の `p` が外側の `p` を閉じない、など)。
 */
const IMPLIED: Record<string, { closes: readonly string[]; stops: readonly string[] }> = {
  li: { closes: ['li'], stops: ['ul', 'ol', 'table', 'td', 'th'] },
  dt: { closes: ['dt', 'dd'], stops: ['dl', 'table'] },
  dd: { closes: ['dt', 'dd'], stops: ['dl', 'table'] },
  td: { closes: ['td', 'th'], stops: ['tr', 'table'] },
  th: { closes: ['td', 'th'], stops: ['tr', 'table'] },
  tr: { closes: ['tr'], stops: ['table'] },
  thead: { closes: TABLE_SECTIONS, stops: ['table'] },
  tbody: { closes: TABLE_SECTIONS, stops: ['table'] },
  tfoot: { closes: TABLE_SECTIONS, stops: ['table'] },
  option: { closes: ['option'], stops: ['select'] },
  optgroup: { closes: ['option', 'optgroup'], stops: ['select'] },
};

interface Span {
  from: number;
  ctx: PositionContext;
}

// ── 4. 走査 ──

export function scanHtml(masked: string): HtmlScan {
  const len = masked.length;
  const lower = masked.toLowerCase();
  const commentMemo = newCommentEndMemo();
  const elements: ScannedElement[] = [];
  const stack: ScannedElement[] = [];
  // from の昇順に並べる。各区間は次の区間の from まで続く。
  const spans: Span[] = [];
  let textFrom = 0;

  const top = () => stack[stack.length - 1] ?? null;
  const push = (from: number, ctx: PositionContext) => {
    if (spans[spans.length - 1]?.from === from) spans.pop();
    spans.push({ from, ctx });
  };
  /** textFrom から to までを、いまのスタックの先頭を親とするテキストとして区切る。 */
  const flushText = (to: number) => {
    if (to > textFrom) push(textFrom, { kind: 'text', parent: top() });
  };
  /** スタックの index 以降を暗黙に閉じる。 */
  const closeFrom = (index: number, at: number) => {
    for (let i = stack.length - 1; i >= index; i--) {
      const el = stack[i];
      if (el) {
        el.end = at;
        el.implicitlyClosed = true;
      }
    }
    stack.length = index;
  };
  /** スタックを上から見て、closes の要素があればそこまで閉じる。stops に当たったら諦める。 */
  const closeNearest = (closes: readonly string[], stops: readonly string[], at: number) => {
    for (let i = stack.length - 1; i >= 0; i--) {
      const el = stack[i];
      const t = el?.tag ?? '';
      if (closes.includes(t)) {
        closeFrom(i, at);
        return;
      }
      if (stops.includes(t) || SCOPE_BOUNDARY.has(t) || el?.foreign != null) return;
    }
  };

  let i = 0;
  while (i < len) {
    if (masked[i] !== '<') {
      i++;
      continue;
    }
    // コメントと宣言(<!DOCTYPE …> 等)。後者は本文でないのでコメントと同じ扱いにする。
    if (masked.startsWith('<!--', i) || masked[i + 1] === '!' || masked[i + 1] === '?') {
      flushText(i);
      // コメントの閉じ方は `commentEnd`(ブラウザと同じ)。閉じなければ末尾までコメントとみなす。
      let to: number;
      if (masked.startsWith('<!--', i)) to = commentEnd(masked, i + 4, commentMemo);
      else {
        const gt = masked.indexOf('>', i + 2);
        to = gt < 0 ? -1 : gt + 1;
      }
      if (to < 0) to = len;
      push(i, { kind: 'htmlComment' });
      i = textFrom = to;
      continue;
    }
    // `</` の直後が伏せ字(`J`)なら、ブラウザは偽コメントとして `>` まで読み捨てる。
    if (masked[i + 1] === '/' && masked[i + 2] === MASK_CHAR) {
      flushText(i);
      const close = masked.indexOf('>', i + 3);
      const to = close < 0 ? len : close + 1;
      push(i, { kind: 'htmlComment' });
      i = textFrom = to;
      continue;
    }
    // 終了タグ
    if (masked[i + 1] === '/' && isAsciiAlpha(masked[i + 2])) {
      flushText(i);
      let j = i + 2;
      while (j < len && !isTagNameEnd(masked[j])) j++;
      const name = lower.slice(i + 2, j);
      const gt = masked.indexOf('>', j);
      const to = gt < 0 ? len : gt + 1;
      let found = -1;
      for (let k = stack.length - 1; k >= 0; k--) {
        if (stack[k]?.tag === name) {
          found = k;
          break;
        }
      }
      const matched = found >= 0 ? stack[found] : undefined;
      if (matched) {
        push(i, { kind: 'tagOther', element: matched });
        closeFrom(found + 1, to);
        matched.end = to;
        matched.implicitlyClosed = false;
        stack.length = found;
      } else {
        // ブラウザは対応しない終了タグを `>` まで読み捨てるので、ここに置いたものは残らない。
        push(i, { kind: 'htmlComment' });
      }
      i = textFrom = to;
      continue;
    }
    // 開始タグ
    // `<` + 伏せ字は開始タグでなくテキスト(伏せ字は英字だが、実際の Jinja は名前でない)。
    if (isAsciiAlpha(masked[i + 1]) && masked[i + 1] !== MASK_CHAR) {
      flushText(i);
      let j = i + 1;
      while (j < len && !isTagNameEnd(masked[j])) j++;
      const tag = lower.slice(i + 1, j);
      const outer = top();
      const underForeign = outer?.foreign != null && outer.tag !== 'foreignobject';
      if (!underForeign) {
        const rule = IMPLIED[tag];
        if (rule) closeNearest(rule.closes, rule.stops, i);
        if (tag !== 'p' && P_CLOSERS.has(tag)) closeNearest(['p'], P_STOPS, i);
        if (tag === 'p') closeNearest(['p'], P_STOPS, i);
      }
      const parent = top();
      let foreign: 'svg' | 'math' | null = null;
      if (tag === 'svg' || tag === 'math') foreign = tag;
      else if (underForeign) foreign = outer?.foreign ?? null;
      const el: ScannedElement = {
        tag,
        start: i,
        startTagEnd: len,
        end: len,
        parent,
        foreign,
        implicitlyClosed: false,
      };
      elements.push(el);

      // 属性。引用符つきの値の中だけ attrValue、それ以外は tagOther。
      let segFrom = i;
      let selfClose = false;
      let closed = false;
      let k = j;
      while (k < len) {
        const c = masked[k];
        if (c === '>') {
          k++;
          closed = true;
          break;
        }
        if (c === '/' && masked[k + 1] === '>') {
          selfClose = true;
          k += 2;
          closed = true;
          break;
        }
        if (isHtmlSpace(c) || c === '/') {
          k++;
          continue;
        }
        while (k < len) {
          const d = masked[k];
          if (isHtmlSpace(d) || d === '=' || d === '>' || (d === '/' && masked[k + 1] === '>'))
            break;
          k++;
        }
        let m = k;
        while (isHtmlSpace(masked[m])) m++;
        if (masked[m] !== '=') continue;
        m++;
        while (isHtmlSpace(masked[m])) m++;
        const q = masked[m];
        if (q === '"' || q === "'") {
          const close = masked.indexOf(q, m + 1);
          push(segFrom, { kind: 'tagOther', element: el });
          push(m + 1, { kind: 'attrValue', element: el });
          segFrom = close < 0 ? len : close;
          k = close < 0 ? len : close + 1;
        } else {
          while (m < len && !isHtmlSpace(masked[m]) && masked[m] !== '>') m++;
          k = m;
        }
      }
      push(segFrom, { kind: 'tagOther', element: el });
      el.startTagEnd = k;
      textFrom = i = k;
      if (!closed) {
        el.implicitlyClosed = true;
        break;
      }
      // HTML 要素の `/>` はブラウザが無視する(開いたまま)ので、自己終了は foreign の内側だけ。
      const foreignSelfClose = selfClose && (foreign !== null || underForeign);
      if (foreignSelfClose || (foreign === null && !underForeign && VOID.has(tag))) {
        el.end = k;
        continue;
      }
      stack.push(el);
      el.implicitlyClosed = true;
      // 生テキスト要素は対応する終了タグまで、中身をタグとして読まない。
      if (RAW_TEXT_ELEMENTS.has(tag) && foreign === null && !underForeign) {
        const close = findRawTextEnd(lower, tag, k).at;
        const to = close < 0 ? len : close;
        if (to > k) push(k, { kind: 'rawText', element: el });
        textFrom = i = to;
      }
      continue;
    }
    i++;
  }
  flushText(len);
  return makeScan(elements, spans, len);
}

function makeScan(elements: ScannedElement[], spans: Span[], len: number): HtmlScan {
  return {
    elements,
    contextAt(pos) {
      let lo = 0;
      let hi = spans.length - 1;
      let hit = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if ((spans[mid]?.from ?? 0) <= pos) {
          hit = mid;
          lo = mid + 1;
        } else hi = mid - 1;
      }
      const s = hit >= 0 ? spans[hit] : undefined;
      if (!s || pos >= len) return { kind: 'text', parent: null };
      return s.ctx;
    },
    innermostContaining(start, end, includeStartTag = false) {
      let best: ScannedElement | null = null;
      for (const e of elements) {
        // 既定は開始タグの内側から数えるので、範囲が要素ちょうどなら、その要素ではなく親を返す。
        const inside = (includeStartTag ? e.start : e.startTagEnd) <= start && end <= e.end;
        if (inside && (!best || e.end - e.start <= best.end - best.start)) best = e;
      }
      return best;
    },
  };
}
