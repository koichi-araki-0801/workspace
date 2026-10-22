// =============================================================================
// safeMarkup.ts — `safe` の値をエスケープせずに置いてよいかの判定
// =============================================================================
// `safe` の付いた値は本番と同じ見た目にするため HTML のまま描くが、置く位置と値の形を両方確かめる。
// 位置は「要素の中身(テキスト)」だけ: 属性値・タグの中・HTML コメント・raw text の中に置くと、値の
// `"` `>` `-->` `</title` でその文脈を抜け、周りのマークアップ(作成タブの往復用の印や固めた要素の
// 属性を含む)を書き換えられる。値の形は「それだけで閉じた断片」だけ: 閉じタグの余り・コメント・
// パーサの読み方を切り替える要素があると、テキストの位置からでも外側の要素を閉じたり印を作ったり
// できる。どちらかに外れた値はエスケープして描く(呼び出し側が unsupported に数える)。
//
// 判定は安全側に倒す: 読み方に迷う形(`<` の直後に Jinja が続く等)はテキストの位置と見なさない。

import { isHtmlSpace, isTagNameEnd } from '../html/htmlLex.js';
import { asciiLower, RAW_TEXT_ELEMENTS } from '../html/rawText.js';
import { findEditingMarkers } from '../security/editingMarkers.js';
import { lexJinja } from './jinjaLex.js';

// ── 1. 置く位置 ──

const TAG_NAME_RE = /^[A-Za-z][^\s/>{]*/;

/**
 * `src` の Jinja トークンのうち、HTML のテキストの位置にあるものの開始位置。字句として読めなければ
 * 空(どこにも生の HTML を置かない)。
 */
export function jinjaTextTokenStarts(src: string): ReadonlySet<number> {
  const out = new Set<number>();
  const lexed = lexJinja(src);
  if (!lexed.ok) return out;
  const toks = lexed.tokens;
  let k = 0;
  let state: 'text' | 'tag' | 'comment' | 'bogus' | 'raw' = 'text';
  let tagName = '';
  let endTag = false;
  let rawName = '';
  let quote: string | null = null;
  let afterEq = false;
  let i = 0;
  while (i < src.length) {
    while (k < toks.length && toks[k].start < i) k++;
    const tok = toks[k];
    if (tok && tok.start === i) {
      if (state === 'text') out.add(i);
      else if (state === 'tag') afterEq = false;
      i = tok.end;
      k++;
      continue;
    }
    const c = src[i];
    switch (state) {
      case 'text': {
        if (src.startsWith('<!--', i)) {
          state = 'comment';
          i += 4;
          continue;
        }
        if (c !== '<') break;
        const next = src[i + 1];
        if (next === '!' || next === '?') {
          state = 'bogus';
          i += 2;
          continue;
        }
        const m = TAG_NAME_RE.exec(src.slice(i + (next === '/' ? 2 : 1), i + 66));
        if (m) {
          endTag = next === '/';
          tagName = asciiLower(m[0]);
          state = 'tag';
          quote = null;
          afterEq = false;
          i += (endTag ? 2 : 1) + m[0].length;
          continue;
        }
        // `<{{ x }}` / `</{{ x }}` は値しだいでタグになるので、`>` まで名前の無いタグとして読む。
        if (next === '{' || (next === '/' && src[i + 2] === '{')) {
          tagName = '';
          endTag = false;
          state = 'tag';
          quote = null;
          afterEq = false;
        }
        break;
      }
      case 'tag':
        if (quote !== null) {
          if (c === quote) quote = null;
        } else if (c === '>') {
          state = !endTag && RAW_TEXT_ELEMENTS.has(tagName) ? 'raw' : 'text';
          rawName = tagName;
        } else if (c === '=') afterEq = true;
        else if (afterEq && (c === '"' || c === "'")) {
          quote = c;
          afterEq = false;
        } else if (!isHtmlSpace(c)) afterEq = false;
        break;
      case 'comment':
        if (src.startsWith('-->', i)) {
          state = 'text';
          i += 3;
          continue;
        }
        if (src.startsWith('--!>', i)) {
          state = 'text';
          i += 4;
          continue;
        }
        break;
      case 'bogus':
        if (c === '>') state = 'text';
        break;
      case 'raw': {
        const at = i + 2 + rawName.length;
        if (
          c === '<' &&
          src[i + 1] === '/' &&
          asciiLower(src.slice(i + 2, at)) === rawName &&
          (at >= src.length || isTagNameEnd(src[at]))
        ) {
          state = 'tag';
          endTag = true;
          tagName = rawName;
          quote = null;
          i = at;
          continue;
        }
        break;
      }
    }
    i++;
  }
  return out;
}

// ── 2. 値の形 ──

const VOID_ELEMENTS: ReadonlySet<string> = new Set([
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
  'source',
  'track',
  'wbr',
]);

/** 中身の読み方(raw text・外来要素・文書の骨組み)を切り替える要素。値の中には置かせない。 */
const PARSER_SWITCHING: ReadonlySet<string> = new Set([
  ...RAW_TEXT_ELEMENTS,
  'html',
  'head',
  'body',
  'frameset',
  'frame',
  'template',
  'svg',
  'math',
  'plaintext',
  'xmp',
  'iframe',
  'noembed',
  'noframes',
  'noscript',
]);

/**
 * `html` がそれだけで閉じた断片か: タグはすべて対応が取れ(空要素を除く)、コメント・`<!` `<?`・
 * 名前で始まらない `<`・往復用の印・読み方を切り替える要素を持たない。テキストの位置に置いても、
 * 外側の要素を閉じず、印やコメントを作らない。
 */
export function isSelfContainedMarkup(html: string): boolean {
  const stack: string[] = [];
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt < 0) break;
    const end = html[lt + 1] === '/';
    const name = TAG_NAME_RE.exec(html.slice(lt + (end ? 2 : 1), lt + 66))?.[0];
    if (name === undefined) return false;
    const lower = asciiLower(name);
    if (PARSER_SWITCHING.has(lower)) return false;
    // タグの閉じ `>` を、`=` の後の引用符の中を飛ばして探す。
    let j = lt + (end ? 2 : 1) + name.length;
    let quote: string | null = null;
    let afterEq = false;
    for (; j < html.length; j++) {
      const c = html[j];
      if (quote !== null) {
        if (c === quote) quote = null;
      } else if (c === '>') break;
      else if (c === '=') afterEq = true;
      else if (afterEq && (c === '"' || c === "'")) {
        quote = c;
        afterEq = false;
      } else if (!isHtmlSpace(c)) afterEq = false;
    }
    if (j >= html.length) return false;
    if (end) {
      if (VOID_ELEMENTS.has(lower) || stack.pop() !== lower) return false;
    } else if (!VOID_ELEMENTS.has(lower)) stack.push(lower); // `<span/>` も HTML では開く
    i = j + 1;
  }
  return stack.length === 0 && findEditingMarkers(html).length === 0;
}
