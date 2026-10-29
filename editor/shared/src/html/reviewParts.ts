// =============================================================================
// reviewParts.ts — パーツ判定を確定HTMLへ適用するための原文パーツ抽出
// =============================================================================
// DOMで再直列化せず、入力HTML上のouterHTML範囲を保持する。確定保存ではこの範囲だけを
// 削除・置換し、Jinja原文、改ページ、コメント、空白など対象外の文字列をバイト単位で維持する。
import { validation } from '../errors.js';
import { isAsciiAlpha, isHtmlSpace, readAttr } from './htmlLex.js';
import { asciiLower, findRawTextEnd, RAW_TEXT_ELEMENTS } from './rawText.js';

/** 承認用に抽出した本文直下のパーツ。`end`は元HTML上の排他的な終了位置。 */
export interface ReviewSourcePart {
  partKey: string;
  start: number;
  end: number;
  html: string;
}

/** 承認対象HTMLとして走査する最大長。リクエスト上限と同じ8MiBに固定する。 */
export const MAX_REVIEW_PART_SCAN_BYTES = 8 * 1024 * 1024;

interface HtmlToken {
  /** `comment` はコメントと `<!…>`・`<?…>`(本文直下の地の文の切れ目を数えるために残す)。 */
  kind: 'start' | 'end' | 'comment';
  name: string;
  start: number;
  end: number;
  selfClosing: boolean;
  attrsFrom: number;
  attrsTo: number;
}

interface BodyRange {
  from: number;
  to: number;
}

interface OpenElement {
  name: string;
  start: number;
  anchor: string | null;
  excluded: boolean;
}

const VOID_TAGS: ReadonlySet<string> = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

const JINJA_OPEN_RE = /\{\{|\{%|\{#/;

/** タグ名として受け付ける継続文字。 */
function isNameChar(c: string | undefined): boolean {
  return isAsciiAlpha(c) || (c !== undefined && c >= '0' && c <= '9') || c === '-' || c === ':';
}

/**
 * HTMLをタグ単位で走査する。境界を確定できない入力は部分結果へ倒さずvalidationで拒否する。
 */
function tokenizeHtml(html: string): HtmlToken[] {
  const tokens: HtmlToken[] = [];
  const length = html.length;
  let lower: string | null = null;
  let index = 0;

  while (index < length) {
    const open = html.indexOf('<', index);
    if (open < 0) break;

    index = open + 1;

    if (html.startsWith('!--', index)) {
      const close = html.indexOf('-->', index + 3);
      if (close < 0) throw validation('HTMLのパーツ境界を確認できません');
      index = close + 3;
      tokens.push(commentToken(open, index));
      continue;
    }

    const head = html[index];

    if (head === '!' || head === '?') {
      const close = html.indexOf('>', index + 1);
      if (close < 0) throw validation('HTMLのパーツ境界を確認できません');
      index = close + 1;
      tokens.push(commentToken(open, index));
      continue;
    }

    const closing = head === '/';
    if (closing) index++;

    const nameStart = index;
    if (!isAsciiAlpha(html[index])) {
      index = open + 1;
      continue;
    }

    index++;
    while (index < length && isNameChar(html[index])) index++;

    const name = html.slice(nameStart, index).toLowerCase();
    const attrsFrom = index;
    let tagEnd = -1;

    while (index < length) {
      const current = html[index];

      if (current === '"' || current === "'") {
        const quoteEnd = html.indexOf(current, index + 1);
        if (quoteEnd < 0) throw validation('HTMLのパーツ境界を確認できません');
        index = quoteEnd + 1;
        continue;
      }

      if (current === '>') {
        tagEnd = index + 1;
        break;
      }

      index++;
    }

    if (tagEnd < 0) throw validation('HTMLのパーツ境界を確認できません');

    const attrsTo = tagEnd - 1;
    const selfClosing =
      !closing && (VOID_TAGS.has(name) || (attrsTo > attrsFrom && html[attrsTo - 1] === '/'));

    tokens.push({
      kind: closing ? 'end' : 'start',
      name,
      start: open,
      end: tagEnd,
      selfClosing,
      attrsFrom,
      attrsTo,
    });

    index = tagEnd;

    if (closing || selfClosing || !RAW_TEXT_ELEMENTS.has(name)) continue;

    lower ??= asciiLower(html);
    const rawEnd = findRawTextEnd(lower, name, index).at;
    if (rawEnd < 0) throw validation('HTMLのパーツ境界を確認できません');

    const closeToken = readClosingTag(html, rawEnd, name);
    tokens.push(closeToken);
    index = closeToken.end;
  }

  return tokens;
}

/** コメント(と `<!…>`・`<?…>`)の範囲を表すトークン。 */
function commentToken(start: number, end: number): HtmlToken {
  return {
    kind: 'comment',
    name: '#comment',
    start,
    end,
    selfClosing: false,
    attrsFrom: end,
    attrsTo: end,
  };
}

/** raw-text要素の終了タグを読み、対応する終了トークンを返す。 */
function readClosingTag(html: string, start: number, name: string): HtmlToken {
  let index = start + 2 + name.length;

  while (index < html.length && html[index] !== '>') index++;
  if (index >= html.length) throw validation('HTMLのパーツ境界を確認できません');

  return {
    kind: 'end',
    name,
    start,
    end: index + 1,
    selfClosing: false,
    attrsFrom: start + 2 + name.length,
    attrsTo: index,
  };
}

/**
 * 完全HTMLならbody内部、本文断片なら入力全体を走査対象にする。
 * body開始・終了の片方だけ、複数body、終了が開始より前の入力は拒否する。
 */
function bodyRangeOf(html: string, tokens: readonly HtmlToken[]): BodyRange {
  const starts = tokens.filter((token) => token.kind === 'start' && token.name === 'body');
  const ends = tokens.filter((token) => token.kind === 'end' && token.name === 'body');

  if (starts.length === 0 && ends.length === 0) {
    return { from: 0, to: html.length };
  }

  if (starts.length !== 1 || ends.length !== 1) {
    throw validation('HTMLのbody境界を確認できません');
  }

  const start = starts[0];
  const end = ends[0];

  if (end.start < start.end) {
    throw validation('HTMLのbody境界を確認できません');
  }

  return { from: start.end, to: end.start };
}

/** 開始タグの属性を属性名から取得する。重複時は先に現れた値を使用する。 */
function attributesOf(html: string, token: HtmlToken): Map<string, string | null> {
  const attributes = new Map<string, string | null>();
  let index = token.attrsFrom;

  while (index < token.attrsTo) {
    while (index < token.attrsTo && (isHtmlSpace(html[index]) || html[index] === '/')) {
      index++;
    }

    if (index >= token.attrsTo) break;

    const attribute = readAttr(html, index, token.attrsTo);
    if (attribute.next <= index) {
      throw validation('HTMLのパーツ境界を確認できません');
    }

    if (!attributes.has(attribute.name)) {
      attributes.set(attribute.name, attribute.value);
    }

    index = attribute.next;
  }

  return attributes;
}

/** class属性の先頭クラス名を返す。 */
function firstClassOf(value: string | null | undefined): string | null {
  if (!value) return null;

  let index = 0;
  while (index < value.length && isHtmlSpace(value[index])) index++;

  const start = index;
  while (index < value.length && !isHtmlSpace(value[index])) index++;

  return index > start ? value.slice(start, index) : null;
}

/**
 * 承認画面と同じ優先順でアンカーを作る。
 * 採用される属性にJinjaがあれば、値差込み後と原文でキーが変わるため拒否する。
 */
function anchorOf(html: string, token: HtmlToken): { anchor: string; classes: string[] } {
  const attributes = attributesOf(html, token);
  const partId = attributes.get('data-part-id') || null;
  const id = attributes.get('id') || null;
  const classValue = attributes.get('class') || null;
  const firstClass = firstClassOf(classValue);

  const anchor = partId || id || (firstClass ? `.${firstClass}` : '') || token.name;

  if (JINJA_OPEN_RE.test(anchor)) {
    throw validation('パーツ識別子にJinjaを使用できません');
  }

  const classes =
    classValue === null ? [] : classValue.split(/[\t\n\f\r ]+/).filter((value) => value !== '');

  return { anchor, classes };
}

/** `style`と本文直下の`div.pagebreak`をパーツから除外する。 */
function isExcludedPart(name: string, classes: readonly string[]): boolean {
  return name === 'style' || (name === 'div' && classes.includes('pagebreak'));
}

/**
 * HTMLから承認対象となる本文直下パーツを抽出する。
 *
 * 完全HTMLではbody直下、bodyを持たない本文断片では入力直下だけを対象にする。
 * パーツキーは`data-part-id`、明示`id`、先頭class、タグ名の優先順で決め、
 * 同じアンカーへ文書全体の出現順で`#1`、`#2`を付与する。
 */
export function extractReviewParts(html: string): ReviewSourcePart[] {
  if (html.length > MAX_REVIEW_PART_SCAN_BYTES) {
    throw validation(
      `承認対象のHTMLが大きすぎます(${html.length}文字 > 上限${MAX_REVIEW_PART_SCAN_BYTES})`,
    );
  }

  const tokens = tokenizeHtml(html);
  const range = bodyRangeOf(html, tokens);
  const scoped = tokens.filter((token) => token.start >= range.from && token.end <= range.to);

  const parts: Array<Omit<ReviewSourcePart, 'partKey'> & { anchor: string }> = [];
  const stack: OpenElement[] = [];

  for (const token of scoped) {
    if (token.kind === 'comment') continue;

    if (token.kind === 'start') {
      const isRoot = stack.length === 0;
      let open: OpenElement = {
        name: token.name,
        start: token.start,
        anchor: null,
        excluded: true,
      };

      if (isRoot) {
        const { anchor, classes } = anchorOf(html, token);
        open = {
          name: token.name,
          start: token.start,
          anchor,
          excluded: isExcludedPart(token.name, classes),
        };
      }

      if (token.selfClosing) {
        if (isRoot && !open.excluded && open.anchor !== null) {
          parts.push({
            anchor: open.anchor,
            start: open.start,
            end: token.end,
            html: html.slice(open.start, token.end),
          });
        }
        continue;
      }

      stack.push(open);
      continue;
    }

    const current = stack.at(-1);
    if (!current || current.name !== token.name) {
      throw validation('HTMLのパーツ境界を確認できません');
    }

    stack.pop();

    if (stack.length === 0 && !current.excluded && current.anchor !== null) {
      parts.push({
        anchor: current.anchor,
        start: current.start,
        end: token.end,
        html: html.slice(current.start, token.end),
      });
    }
  }

  if (stack.length > 0) {
    throw validation('HTMLのパーツ境界を確認できません');
  }

  const seen = new Map<string, number>();

  return parts.map((part) => {
    const occurrence = (seen.get(part.anchor) ?? 0) + 1;
    seen.set(part.anchor, occurrence);

    return {
      partKey: `${part.anchor}#${occurrence}`,
      start: part.start,
      end: part.end,
      html: part.html,
    };
  });
}
/** 本文直下の 1 単位(要素か、空白でない地の文)の元HTML上の範囲。`end`は排他的。 */
export interface BodyUnitRange {
  /** 小文字のタグ名。地の文は `#text`。 */
  name: string;
  start: number;
  end: number;
}

/**
 * 本文直下の要素(`style` と区切りも含む)と、空白でない地の文の範囲を文書順に返す。`bodyEnd` は
 * 本文の終わり(`</body>` の位置。body の無い断片は入力の長さ)。
 *
 * edit 申請の確定(`reviewDiff/editReviewedHtml.ts`)が、DOM の差分の本文直下の並び
 * (`reviewDiff/htmlDiff.ts` の `topLevelUnitNames`)と順番で対応づけ、却下したパーツの範囲だけを
 * 切り貼りするのに使う。地の文はコメントで切れる(DOM のテキストノードと同じ)。空白かどうかは
 * 原文の文字で見るので、`&nbsp;` だけの地の文は DOM(空白として読む)と数が合わず、対応づけの
 * 検査で止まる。
 */
export function extractBodyUnits(html: string): { units: BodyUnitRange[]; bodyEnd: number } {
  if (html.length > MAX_REVIEW_PART_SCAN_BYTES) {
    throw validation(
      `承認対象のHTMLが大きすぎます(${html.length}文字 > 上限${MAX_REVIEW_PART_SCAN_BYTES})`,
    );
  }

  const tokens = tokenizeHtml(html);
  const range = bodyRangeOf(html, tokens);
  const units: BodyUnitRange[] = [];
  const stack: string[] = [];
  let rootStart = 0;
  let cursor = range.from;

  const pushText = (end: number) => {
    if (html.slice(cursor, end).trim() !== '') units.push({ name: '#text', start: cursor, end });
  };

  for (const token of tokens) {
    if (token.start < range.from || token.end > range.to) continue;

    if (stack.length === 0) {
      pushText(token.start);
      cursor = token.end;
    }

    if (token.kind === 'comment') continue;

    if (token.kind === 'start') {
      if (stack.length === 0) rootStart = token.start;
      if (token.selfClosing) {
        if (stack.length === 0)
          units.push({ name: token.name, start: token.start, end: token.end });
        continue;
      }
      stack.push(token.name);
      continue;
    }

    if (stack.at(-1) !== token.name) throw validation('HTMLのパーツ境界を確認できません');
    stack.pop();
    if (stack.length === 0) {
      units.push({ name: token.name, start: rootStart, end: token.end });
      cursor = token.end;
    }
  }

  if (stack.length > 0) throw validation('HTMLのパーツ境界を確認できません');
  pushText(range.to);

  return { units, bodyEnd: range.to };
}

/** create申請の確定候補生成で使用するパーツ判定。 */
export interface CreateReviewPartDecision {
  partKey: string;
  status: 'pending' | 'approved' | 'rejected';
}

/**
 * create申請のJinja原文へ、値入りHTMLで行ったパーツ判定を適用する。
 *
 * 原文と値入りHTMLのパーツキー・順序が一致するときだけ処理し、承認済みパーツは原文の
 * まま残し、却下済みパーツのouterHTML範囲だけを削除する。DOMで再直列化しないため、
 * Jinja、改ページ、コメント、style、空白など判定対象外の文字列は変更しない。
 */
export function buildCreateReviewedHtml(
  sourceHtml: string,
  filledHtml: string,
  decisions: readonly CreateReviewPartDecision[],
): string {
  const sourceParts = extractReviewParts(sourceHtml);
  const filledParts = extractReviewParts(filledHtml);

  const sourceKeys = sourceParts.map((part) => part.partKey);
  const filledKeys = filledParts.map((part) => part.partKey);

  if (
    sourceKeys.length !== filledKeys.length ||
    sourceKeys.some((partKey, index) => partKey !== filledKeys[index])
  ) {
    throw validation('Jinja原文と値入りHTMLのパーツ構造が一致しません');
  }

  const decisionByPartKey = new Map<string, CreateReviewPartDecision>();

  for (const decision of decisions) {
    if (decisionByPartKey.has(decision.partKey)) {
      throw validation(`同じパーツの判定が複数あります: ${decision.partKey}`);
    }

    decisionByPartKey.set(decision.partKey, decision);
  }

  const sourceKeySet = new Set(sourceKeys);

  // `pending` は判定が無いのと同じ(取り消しで残った本文に無いキーで最終確定を止めない)。
  const unknownDecision = decisions.find(
    (decision) => decision.status !== 'pending' && !sourceKeySet.has(decision.partKey),
  );

  if (unknownDecision) {
    throw validation(`現在の本文に存在しないパーツ判定があります: ${unknownDecision.partKey}`);
  }

  const missingDecision = sourceParts.find((part) => !decisionByPartKey.has(part.partKey));

  if (missingDecision) {
    throw validation(
      `判定が保存されていないパーツがあるため最終確定できません: ${missingDecision.partKey}`,
    );
  }

  const pendingDecision = decisions.find(
    (decision) => decision.status === 'pending' && sourceKeySet.has(decision.partKey),
  );

  if (pendingDecision) {
    throw validation(`未判定のパーツがあるため最終確定できません: ${pendingDecision.partKey}`);
  }

  const rejectedParts = sourceParts
    .filter((part) => decisionByPartKey.get(part.partKey)?.status === 'rejected')
    .sort((left, right) => right.start - left.start);

  let reviewedHtml = sourceHtml;

  for (const part of rejectedParts) {
    reviewedHtml = reviewedHtml.slice(0, part.start) + reviewedHtml.slice(part.end);
  }

  return reviewedHtml;
}
