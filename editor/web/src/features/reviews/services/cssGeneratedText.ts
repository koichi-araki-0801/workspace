// =============================================================================
// cssGeneratedText.ts — 申請者の CSS が文字を生むか(承認画面の注意の帯に出す)
// =============================================================================
// 承認判断の正典は右欄の文字の差分(`textContent`。申請者の CSS が届かない)だが、CSS の `content`・
// `quotes`・`list-style` などは紙面にだけ文字を出し、右欄には出ない。承認画面は、本文の `<style>`・
// `style` 属性・CSS の欄のどれかが文字を生みうるなら注意の帯で知らせる。数えるのは 2 つ:
//   - 文字を生むプロパティの宣言(`TEXT_PROPERTIES`)と `@counter-style`。値の形は問わない
//     (`attr()`・`counter()`・引用符の無い識別子の `symbols` も文字を生む)。
//   - それ以外の場所の文字列トークン。文字を生まない文字列(`url()` の中・`font-family` の値・
//     `@font-face` の中・`@import` などの at-rule の前置き)は数えない。
// CSS 全体を読む字句解析は持たず、文字列・コメント・`url(`・`:`・`{` の区切りだけを見る(拾いすぎる側)。

/** 値の形を問わず文字を生みうるプロパティ。 */
const TEXT_PROPERTIES = new Set([
  'content',
  'quotes',
  'list-style',
  'list-style-type',
  'text-overflow',
  'hyphenate-character',
]);

/** 文字列が文字を生まない宣言の名前(値はフォントの名前)。 */
const FONT_PROPERTIES = new Set(['font-family', 'font']);

/** `css` に、文字を生みうる文字列トークンがあるか。宣言だけ(`style` 属性の値)も読める。 */
export function cssMakesText(css: string): boolean {
  /** 開いているブロックが `@font-face` か(入れ子の深さごと)。 */
  const blocks: boolean[] = [];
  /** 今の宣言・前置き(最後の `{` `}` `;` からの文字)。 */
  let head = '';
  let i = 0;
  while (i < css.length) {
    const c = css[i];
    if (c === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      i = end === -1 ? css.length : end + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      if (!stringIsInert(head, blocks)) return true;
      i = skipString(css, i);
      continue;
    }
    if (/url\($/i.test(css.slice(Math.max(0, i - 3), i + 1)) && !/[\w-]/.test(css[i - 4] ?? '')) {
      i = skipUrl(css, i + 1);
      head += 'url()';
      continue;
    }
    if (c === ':' && TEXT_PROPERTIES.has(head.trim().toLowerCase())) return true;
    if (c === '{') {
      if (/^\s*@counter-style\b/i.test(head)) return true;
      blocks.push(/^\s*@font-face\b/i.test(head) || (blocks.at(-1) ?? false));
      head = '';
    } else if (c === '}') {
      blocks.pop();
      head = '';
    } else if (c === ';') head = '';
    else head += c;
    i++;
  }
  return false;
}

/** 文字列が文字を生まない文脈にあるか。 */
function stringIsInert(head: string, blocks: readonly boolean[]): boolean {
  if (blocks.at(-1)) return true; // @font-face の中
  const h = head.trim();
  if (h.startsWith('@')) return true; // @import・@charset などの前置き
  const colon = h.indexOf(':');
  if (colon === -1) return false;
  return FONT_PROPERTIES.has(h.slice(0, colon).trim().toLowerCase());
}

/** 引用符 `css[at]` の文字列の次の位置。閉じなければ末尾(行末で終わる CSS の規則は見ない)。 */
function skipString(css: string, at: number): number {
  const q = css[at];
  let i = at + 1;
  while (i < css.length && css[i] !== q) i += css[i] === '\\' ? 2 : 1;
  return i + 1;
}

/** `url(` の直後 `from` から、対応する `)` の次の位置(中の文字列は読み飛ばす)。 */
function skipUrl(css: string, from: number): number {
  let i = from;
  while (i < css.length && css[i] !== ')') {
    if (css[i] === '"' || css[i] === "'") i = skipString(css, i);
    else i += css[i] === '\\' ? 2 : 1;
  }
  return i + 1;
}
