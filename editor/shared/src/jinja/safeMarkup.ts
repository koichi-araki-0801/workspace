// =============================================================================
// safeMarkup.ts — `safe` の値をエスケープせずに置いてよいかの判定
// =============================================================================
// `safe` の付いた値は本番と同じ見た目にするため HTML のまま描くが、値の形と置く位置を両方確かめ、
// 疑わしければエスケープする。値を生で置けるかを自前の字句解析で「安全」と判定する限り、ブラウザの
// パーサとの解釈のずれがそのまま穴になるので、判定は狭く倒す。
//   - 値の形: 許可したタグと属性だけを、ブラウザと解釈が分かれない単純な書き方(属性名は英字と `-`、
//     値は引用符で囲むか英数字だけ、区切りは空白)で書いた、対応の取れた断片だけ。コメント・`<!`・
//     名前で始まらない `<`・往復用の印は持たせない。能動コンテンツ(イベント属性・script・URL を取る
//     属性)は許可リストに無いので、そもそも生で置かない。
//   - 置く位置: 描き終えた HTML そのものを読み、要素の中身(テキスト)の位置にある値だけ。原文で
//     判定すると、if の枝で引用符や開始タグが消えたときに描いた結果と文脈がずれる。属性値・タグの
//     中・コメント・raw text・表の行の間・外来要素(svg / math)の中は、値の `"` `>` `-->` `</…` で
//     その文脈を抜け、周りのマークアップ(作成タブの往復用の印や固めた要素の属性を含む)を
//     書き換えられるので生で置かない。
// 生で置いた値も、web では canvas の入口の刈り取り(DOM で読む)、server では承認で書く本文の検査を
// 通るので、ここは最後の守りではなく、値で文脈を抜けさせないための層である。

import { findEditingMarkers } from '../security/editingMarkers.js';

// ── 1. 値の形 ──

/**
 * 帳票の注記で使う書式の要素。URL・実行・フォームに関わる要素は入れない。生で置いた値は web の
 * canvas の入口の刈り取り(`sanitizeHtml.ts` の `pruneCanvasActiveContent`)を通るので、その許可リストに
 * 無い要素(`font` など)を足すと、値が中身ごと消える。足すときは刈り取りの許可リストにあることを
 * 確かめる(`safeMarkupGates` のテストが web と server の両方で検査する)。
 */
export const SAFE_MARKUP_TAGS: ReadonlySet<string> = new Set([
  'b',
  'i',
  'u',
  's',
  'em',
  'strong',
  'small',
  'sup',
  'sub',
  'span',
  'div',
  'p',
  'br',
  'hr',
  'ul',
  'ol',
  'li',
  'dl',
  'dt',
  'dd',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'th',
  'td',
  'caption',
  'colgroup',
  'col',
  'mark',
  'ruby',
  'rt',
  'rp',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'blockquote',
  'pre',
  'code',
]);

const VOID_TAGS: ReadonlySet<string> = new Set(['br', 'hr', 'col']);

/**
 * 見た目だけに効く属性。URL・実行・id(canvas の要素の取り違え)に関わる属性は入れない。canvas の
 * 刈り取りの許可リストと、server の描き直しの関所(`templateScripts.ts` の `INERT_ATTRS`)の両方に
 * ある属性だけにする。刈り取りに無ければ canvas で落ち、関所に無ければ能動コンテンツの並びが変わった
 * として描き直しを見送るので、古い見た目用の属性(`align` `color` `size` など)は入れない。
 */
export const SAFE_MARKUP_ATTRS: ReadonlySet<string> = new Set([
  'class',
  'style',
  'title',
  'lang',
  'dir',
  'colspan',
  'rowspan',
  'span',
  'width',
  'height',
]);

// 空白は HTML の 5 文字だけ(ブラウザが属性の区切りに使う文字と揃える)。区切りの `/` は受けない。
const WS = '[\\t\\n\\f\\r ]';
const ATTR = `${WS}+([A-Za-z][A-Za-z-]*)(?:${WS}*=${WS}*("[^"]*"|'[^']*'|[A-Za-z0-9_.%#-]+))?`;
const START_TAG_RE = new RegExp(`<([A-Za-z][A-Za-z0-9]*)((?:${ATTR})*)${WS}*(/?)>`, 'y');
const END_TAG_RE = new RegExp(`</([A-Za-z][A-Za-z0-9]*)${WS}*>`, 'y');
const ATTR_RE = new RegExp(ATTR, 'g');

/**
 * style の値に使える文字(許可リスト)。括弧を入れないので CSS の関数(`url(` `src(` `image(`
 * `cross-fade(` `rgb(` など)は一律に通らず、`\`(CSS のエスケープ)・`&`(実体参照で `url(` を隠す)・
 * `@` も通らない。外れたら判定をやめてエスケープする側に倒す。
 */
const SAFE_STYLE_RE = /^[\p{L}\p{N}\t\n\f\r #%.,:;!'-]*$/u;

/**
 * 文字は通っても置かせない宣言の名前。`position`(`fixed` / `absolute`)は値の要素を本文の外へ出して、
 * ページ全体に重ねて見せられる(`position:fixed;top:0;width:100%`)。
 */
const DENIED_STYLE_PROPS: ReadonlySet<string> = new Set(['position']);

function styleAllowed(style: string): boolean {
  if (!SAFE_STYLE_RE.test(style)) return false;
  for (const decl of style.split(';')) {
    const colon = decl.indexOf(':');
    const prop = (colon < 0 ? decl : decl.slice(0, colon)).trim().toLowerCase();
    if (DENIED_STYLE_PROPS.has(prop)) return false;
  }
  return true;
}

/** 属性値の引用符を外す(`ATTR` の値は引用符つきか英数字だけ)。 */
const unquote = (v: string) => (/^["']/.test(v) ? v.slice(1, -1) : v);

function attrsAllowed(attrs: string): boolean {
  for (const m of attrs.matchAll(ATTR_RE)) {
    const name = m[1].toLowerCase();
    if (!SAFE_MARKUP_ATTRS.has(name)) return false;
    if (name === 'style' && !styleAllowed(unquote(m[2] ?? ''))) return false;
  }
  return true;
}

/**
 * 地の文の引用符。テキストの位置に置く限り無害だが、位置の判定を誤ったときに属性値を抜ける文字なので、
 * 疑わしければエスケープする側に倒す。
 */
const QUOTE_RE = /["'`]/;

/**
 * `html` を生で置いてよい形か: 許可したタグ・属性だけの、対応の取れた断片(上の冒頭の説明)。
 * 外れたら false(呼び出し側がエスケープする)。
 */
export function isAllowedSafeMarkup(html: string): boolean {
  const stack: string[] = [];
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (QUOTE_RE.test(html.slice(i, lt < 0 ? html.length : lt))) return false;
    if (lt < 0) break;
    END_TAG_RE.lastIndex = lt;
    const end = END_TAG_RE.exec(html);
    if (end) {
      const name = end[1].toLowerCase();
      if (VOID_TAGS.has(name) || stack.pop() !== name) return false;
      i = END_TAG_RE.lastIndex;
      continue;
    }
    START_TAG_RE.lastIndex = lt;
    const start = START_TAG_RE.exec(html);
    if (!start) return false;
    const name = start[1].toLowerCase();
    if (!SAFE_MARKUP_TAGS.has(name) || !attrsAllowed(start[2])) return false;
    // `<b/>` も HTML では開くので、空要素でなければ閉じを求める。
    if (!VOID_TAGS.has(name)) stack.push(name);
    i = START_TAG_RE.lastIndex;
  }
  return stack.length === 0 && findEditingMarkers(html).length === 0;
}

// ── 2. 置く位置 ──

/** 中身を文字データとして読む要素(ブラウザが RAWTEXT / RCDATA として読むもの全部)。 */
const RAW_TEXT_TAGS: ReadonlySet<string> = new Set([
  'script',
  'style',
  'textarea',
  'title',
  'xmp',
  'iframe',
  'noembed',
  'noframes',
  'noscript',
]);

/** 直下のテキストをパーサが別の場所へ移す(表)か捨てる要素。ここでは値を生で置かない。 */
const NON_TEXT_PARENTS: ReadonlySet<string> = new Set([
  'html',
  'head',
  'table',
  'tbody',
  'thead',
  'tfoot',
  'tr',
  'colgroup',
  'select',
  'optgroup',
  'frameset',
]);

const HTML_VOID: ReadonlySet<string> = new Set([
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

const isWs = (c: string | undefined) =>
  c === ' ' || c === '\t' || c === '\n' || c === '\f' || c === '\r';
const isAlpha = (c: string | undefined) => c !== undefined && /[A-Za-z]/.test(c);
const lower = (s: string) => s.replace(/[A-Z]+/g, (m) => m.toLowerCase());

/**
 * 描き終えた `html` の上で、`at` の各位置が要素の中身(テキスト)の位置か。字句の規則はブラウザの
 * tokenizer に揃え(属性名・値の状態、`<!-->`、`</` の後が英字でないときの bogus コメント、CDATA)、
 * 揃えきれない所(外来要素の中・表の行の間・暗黙に閉じる要素の扱い)はテキストでないと見なす。
 */
export function textPositions(html: string, at: readonly number[]): ReadonlySet<number> {
  const want = new Set(at);
  const out = new Set<number>();
  const stack: string[] = [];
  let foreign = 0;
  let low: string | null = null;
  let i = 0;
  const n = html.length;
  const inText = () => foreign === 0 && !NON_TEXT_PARENTS.has(stack[stack.length - 1] ?? '');
  /** `from` から `needle` の後ろまで飛ばす(無ければ末尾)。 */
  const skipPast = (from: number, needle: string) => {
    const k = html.indexOf(needle, from);
    return k < 0 ? n : k + needle.length;
  };
  while (i < n) {
    if (html[i] !== '<') {
      if (want.has(i) && inText()) out.add(i);
      i++;
      continue;
    }
    const c1 = html[i + 1];
    if (html.startsWith('<!--', i)) {
      // `<!-->` と `<!--->` はそこで閉じる(ブラウザの abrupt-closing-of-empty-comment)。
      if (html[i + 4] === '>') i += 5;
      else if (html.startsWith('->', i + 4)) i += 6;
      else {
        let k = i + 4;
        for (;;) {
          const a = html.indexOf('--', k);
          if (a < 0) {
            k = n;
            break;
          }
          if (html[a + 2] === '>') {
            k = a + 3;
            break;
          }
          if (html.startsWith('!>', a + 2)) {
            k = a + 4;
            break;
          }
          k = a + 1;
        }
        i = k;
      }
      continue;
    }
    if (c1 === '!' && foreign > 0 && html.startsWith('<![CDATA[', i)) {
      i = skipPast(i + 9, ']]>');
      continue;
    }
    if (c1 === '!' || c1 === '?' || (c1 === '/' && !isAlpha(html[i + 2]) && html[i + 2] !== '>')) {
      i = skipPast(i + 2, '>'); // bogus コメント
      continue;
    }
    if (c1 === '/' && html[i + 2] === '>') {
      i += 3; // `</>` はブラウザが読み捨てる
      continue;
    }
    if (!isAlpha(c1) && c1 !== '/') {
      if (want.has(i) && inText()) out.add(i);
      i++; // 名前で始まらない `<` は文字
      continue;
    }
    // ── タグ ──
    const endTag = c1 === '/';
    let k = i + (endTag ? 2 : 1);
    const nameStart = k;
    while (k < n && !isWs(html[k]) && html[k] !== '/' && html[k] !== '>') k++;
    const name = lower(html.slice(nameStart, k));
    let selfClosing = false;
    // 属性(ブラウザの before/after attribute name・attribute value の状態に揃える)。
    while (k < n && html[k] !== '>') {
      const c = html[k];
      if (isWs(c)) {
        k++;
        continue;
      }
      if (c === '/') {
        selfClosing = html[k + 1] === '>';
        k++;
        continue;
      }
      // 属性名。先頭の `=` は名前の一部になる。
      k++;
      while (k < n && !isWs(html[k]) && html[k] !== '/' && html[k] !== '>' && html[k] !== '=') k++;
      while (k < n && isWs(html[k])) k++;
      if (html[k] !== '=') continue;
      k++;
      while (k < n && isWs(html[k])) k++;
      const q = html[k];
      if (q === '"' || q === "'") {
        const close = html.indexOf(q, k + 1);
        k = close < 0 ? n : close + 1;
      } else {
        while (k < n && !isWs(html[k]) && html[k] !== '>') k++;
      }
    }
    i = Math.min(n, k + 1);
    if (endTag) {
      if ((name === 'svg' || name === 'math') && foreign > 0) foreign--;
      const at = stack.lastIndexOf(name);
      if (at >= 0) stack.length = at;
      continue;
    }
    if (foreign > 0) {
      if ((name === 'svg' || name === 'math') && !selfClosing) foreign++;
      continue;
    }
    if (name === 'svg' || name === 'math') {
      if (!selfClosing) foreign++;
      continue;
    }
    if (name === 'plaintext') break; // 以後はすべて文字データ
    if (RAW_TEXT_TAGS.has(name)) {
      // 閉じタグ `</name` の後ろが空白・`/`・`>` のものまで飛ばす(大文字小文字を区別しない)。
      low ??= lower(html);
      let k2 = i;
      for (;;) {
        const a = low.indexOf(`</${name}`, k2);
        if (a < 0) {
          k2 = n;
          break;
        }
        const after = low[a + 2 + name.length];
        if (after === undefined || isWs(after) || after === '/' || after === '>') {
          k2 = a;
          break;
        }
        k2 = a + 1;
      }
      i = k2;
      continue;
    }
    if (!HTML_VOID.has(name)) stack.push(name);
  }
  return out;
}
