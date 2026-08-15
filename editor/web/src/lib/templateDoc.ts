// =============================================================================
// templateDoc.ts — GrapesJS で `<body>` 内 HTML だけを編集するヘルパ
// =============================================================================
// 役割:
//   GrapesJS では `<body>` の inner HTML だけを編集し, doctype/`<head>`(これ自体が
//   `<title>` や `<link href>` 等に Jinja を含みうる)は verbatim に保持する。
//
// 範囲特定を正規表現の文字列手術でやると、属性値やコメントの中の `<body` / `</body>` で
// 誤分割する(`<meta content="<body>">` や `<!-- </body> -->` が実タグに見える)。よって
// `cssExternalRefs.ts` の `readString` 系トークナイザと同型の 1 文字走査で index を求め、
// slice 位置だけを直す(`noPostSanitizeSurgery.guard.test.ts` の GUARDED 監視対象)。
//   head の生 Jinja を verbatim 保持する契約のため、全文 DOM 化はしない(DOM round-trip は
//   属性引用符の正規化・実体参照の再エンコード等の再整形差分を生む — `jinjaMask.ts` が
//   意図的に避けている罠)。

const LT = 0x3c; // '<'
const GT = 0x3e; // '>'
const SLASH = 0x2f; // '/'
const BANG = 0x21; // '!'
const DASH = 0x2d; // '-'
const DQUOTE = 0x22; // '"'
const SQUOTE = 0x27; // "'"

/** tag 名の終端になりうる文字(空白 4 種 / `>` / `/`)。NaN(文字列末尾)も終端扱い。 */
function isNameTerminator(code: number): boolean {
  return (
    Number.isNaN(code) ||
    code === GT ||
    code === SLASH ||
    code === 0x20 ||
    code === 0x09 ||
    code === 0x0a ||
    code === 0x0d ||
    code === 0x0c
  );
}

/** `<foo bar="x>y">` の `>` を属性値の中で拾わないよう、引用符を認識して開始タグの `>` を越える。 */
function skipTag(html: string, at: number): number {
  const len = html.length;
  let i = at + 1;
  while (i < len) {
    const code = html.charCodeAt(i);
    if (code === DQUOTE || code === SQUOTE) {
      i++;
      while (i < len && html.charCodeAt(i) !== code) i++;
      i++; // 閉じ引用符の次へ
      continue;
    }
    if (code === GT) return i + 1;
    i++;
  }
  return len;
}

/**
 * `html[at..]` が(大小無視で)`name` に一致し、かつ直後が tag 名終端かを判定する。
 * `<bodyish>` を `<body>` と誤認しないための終端確認込み。`name` は小文字前提。
 */
function tagNameMatches(html: string, at: number, name: string): boolean {
  for (let k = 0; k < name.length; k++) {
    let code = html.charCodeAt(at + k);
    if (code >= 0x41 && code <= 0x5a) code += 0x20; // ASCII 大文字→小文字
    if (code !== name.charCodeAt(k)) return false;
  }
  return isNameTerminator(html.charCodeAt(at + name.length));
}

/** 開始タグ `<name` が raw-text 要素なら名前を返す。中身を実タグとして走査してはならない要素。 */
const RAW_TEXT = ['script', 'style', 'title', 'textarea'];
function rawTextNameAt(html: string, at: number): string | null {
  for (const name of RAW_TEXT) if (tagNameMatches(html, at, name)) return name;
  return null;
}

/** raw-text 要素の中身を対応する `</name` まで読み飛ばし、その閉じタグの次を返す。 */
function skipRawText(html: string, from: number, name: string): number {
  const len = html.length;
  let i = from;
  while (i < len) {
    if (
      html.charCodeAt(i) === LT &&
      html.charCodeAt(i + 1) === SLASH &&
      tagNameMatches(html, i + 2, name)
    ) {
      return skipTag(html, i);
    }
    i++;
  }
  return len;
}

/**
 * 最初の実 `<body>` 開始タグの `>` の次(`openEnd`)と、それ以降で最後に現れるコメント外の
 * `</body>` の開始位置(`closeStart`)を返す。どちらか欠ければ `null`。
 *
 * コメント・raw-text 要素・引用符付き属性値を読み飛ばすので、それらの中の `<body` /
 * `</body>` は検出対象から外れる。
 */
function findBodySpan(html: string): { openEnd: number; closeStart: number } | null {
  const len = html.length;
  let i = 0;
  let openEnd = -1;
  let closeStart = -1;
  while (i < len) {
    if (html.charCodeAt(i) !== LT) {
      i++;
      continue;
    }
    // コメント `<!-- … -->` を読み飛ばす。
    if (
      html.charCodeAt(i + 1) === BANG &&
      html.charCodeAt(i + 2) === DASH &&
      html.charCodeAt(i + 3) === DASH
    ) {
      const end = html.indexOf('-->', i + 4);
      i = end === -1 ? len : end + 3;
      continue;
    }
    // 閉じタグ `</body` は openEnd 確定後のみ、最後の 1 つを採る。
    if (html.charCodeAt(i + 1) === SLASH) {
      if (openEnd !== -1 && tagNameMatches(html, i + 2, 'body')) closeStart = i;
      i = skipTag(html, i);
      continue;
    }
    // 開始タグ。raw-text 要素は中身ごと読み飛ばす。
    const rawName = rawTextNameAt(html, i + 1);
    if (rawName !== null) {
      i = skipRawText(html, skipTag(html, i), rawName);
      continue;
    }
    if (openEnd === -1 && tagNameMatches(html, i + 1, 'body')) {
      openEnd = skipTag(html, i);
      i = openEnd;
      continue;
    }
    i = skipTag(html, i);
  }
  if (openEnd === -1 || closeStart === -1) return null;
  return { openEnd, closeStart };
}

export function getBodyInner(rawHtml: string): string {
  const span = findBodySpan(rawHtml);
  return span ? rawHtml.slice(span.openEnd, span.closeStart) : rawHtml;
}

export function replaceBodyInner(rawHtml: string, newInner: string): string {
  const span = findBodySpan(rawHtml);
  if (!span) return newInner;
  return rawHtml.slice(0, span.openEnd) + newInner + rawHtml.slice(span.closeStart);
}
