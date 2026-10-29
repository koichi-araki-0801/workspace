// =============================================================================
// partHtmlCompare.ts — パーツの HTML を「DOM 上で同じになる形」へ寄せる比較用の正規形
// =============================================================================
// 承認後のペア同期(`server/src/sync/jinjaPartRerender.ts`)は、編集タブで挿入した Jinja パーツを
// 手で直したかを、カタログの `内容HTML` を写し元の値で描いた形(`renderPlainFilled` の生の出力)と、
// 承認された本文のパーツ(GrapesJS の `getHtml` を通った形)の比較で決める。2 つは同じ DOM でも
// 書き方が違う: GrapesJS は void 要素を `<br/>` と書き、テキストは `&<>` だけをエスケープし
// (`&#39;` `&quot;` `&nbsp;` は文字のまま)、style を `prop:value;` に書き直し、属性を「他の属性 →
// class → style」の順に並べ、表の行を `<tbody>` で包み、SVG の空要素を閉じタグで書く。ここは両方を
// 同じ規則で寄せる。
//
// 判定を誤って「直していない」に倒すと手直しを捨てて描き直すので、寄せるのは DOM と見た目が変わらない
// 書き方の違いだけにする。テキストと属性値は実体参照を解いて比べるので、中身が 1 文字でも違えば必ず
// 一致しない。解く実体参照は 2 つの書き方の間を行き来するもの(`amp` `lt` `gt` `quot` `apos` `nbsp`
// と数値。どれもセミコロンで閉じたものだけ)に限る。それ以外の書き方の違い(暗黙に閉じる要素・知らない
// 名前の実体参照など)は寄せず、「直した」に倒す(承認された HTML をそのまま写すだけで失うものが無い)。
//
// タグを読む走査器を増やすのは、この比較の倒し方(読めなければ一致させない)がほかの走査器と違うため
// (`docs/editor/src/設計正典.md` の却下済み設計「HTML の走査器を 1 本にまとめる」)。字句の部品は
// `htmlLex.ts` / `rawText.ts` を使う。web のテストは GrapesJS の実物の直列化との一致をこれで確かめる。

import {
  commentEnd,
  isAsciiAlpha,
  isHtmlSpace,
  isTagNameEnd,
  newCommentEndMemo,
  readAttr,
} from './htmlLex.js';
import { asciiLower, findRawTextEnd, RAW_TEXT_ELEMENTS } from './rawText.js';

/** 中身を持たない HTML の要素。開始タグの `/` の有無は DOM を変えない。 */
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

/** 比べない属性。`data-part-id` は挿入時に editor が根へ付け、描いた側には無い。 */
const IGNORED_ATTRS: ReadonlySet<string> = new Set(['data-part-id']);

const ENTITY_RE = /&(#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|amp|lt|gt|quot|apos|nbsp);/g;
const NAMED: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
};

function decodeRef(body: string): string | null {
  if (body[0] !== '#') return NAMED[body] ?? null;
  const hex = body[1] === 'x' || body[1] === 'X';
  const code = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
  // 0・サロゲート・範囲外はブラウザが別の文字へ置き換えるので解かない。
  if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return null;
  return String.fromCodePoint(code);
}

/** 解いた後に残る `&` が実体参照として読まれうる形(`&copy;` `&lt` `&#0;` など)。 */
const UNRESOLVED_REF_RE = /&[A-Za-z#]/;

/**
 * 2 つの書き方の間を行き来する実体参照だけを解く。解かない参照が残る値は `null`(比べられない)。
 * 残したまま `&` をエスケープすると、`&copy;`(©)と文字どおりの `&amp;copy;` が同じ形になり、
 * 手直しを「直していない」と取り違える。
 */
function decode(s: string): string | null {
  if (!s.includes('&')) return s;
  const rest = s.replace(ENTITY_RE, (whole, body: string) =>
    decodeRef(body) === null ? whole : '',
  );
  if (UNRESOLVED_REF_RE.test(rest)) return null;
  return s.replace(ENTITY_RE, (_whole, body: string) => decodeRef(body) as string);
}

/** HTML の空白(NBSP は含めない)の連なりを 1 つにする。 */
const collapse = (s: string) => s.replace(/[\t\n\f\r ]+/g, ' ');

const escText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');

/**
 * style を `prop:value;` の並びへ寄せる(GrapesJS の書き直しと同じ形)。引用符・`\`・コメントを含む値は
 * 区切りを読み違えうるので寄せずに返す。`;` は括弧の外でだけ区切る(`url(data:…;base64,…)`)。
 */
function normalizeStyle(v: string): string {
  if (/["'\\]|\/\*/.test(v)) return collapse(v).trim();
  const decls: string[] = [];
  let depth = 0;
  let from = 0;
  for (let k = 0; k <= v.length; k++) {
    const c = v[k];
    if (c === '(') depth++;
    else if (c === ')') depth = Math.max(0, depth - 1);
    else if (k === v.length || (c === ';' && depth === 0)) {
      decls.push(v.slice(from, k));
      from = k + 1;
    }
  }
  let out = '';
  for (const d of decls) {
    const colon = d.indexOf(':');
    if (colon < 0) {
      if (d.trim() !== '') out += `${collapse(d).trim()};`;
      continue;
    }
    const prop = asciiLower(d.slice(0, colon).trim());
    out += `${prop}:${collapse(d.slice(colon + 1)).trim()};`;
  }
  return out;
}

function normalizeAttrValue(name: string, raw: string | null): string | null {
  const v = decode(raw ?? '');
  if (v === null) return null;
  if (name === 'class')
    return v
      .split(/[\t\n\f\r ]+/)
      .filter(Boolean)
      .join(' ');
  if (name === 'style') return normalizeStyle(v);
  return v;
}

/**
 * テキストを寄せる。空白だけのテキスト(タグの間の改行・字下げ)は消す。`<pre>` の中は空白が見た目に
 * 出るので寄せない(`keepSpace`)。
 */
function normalizeText(s: string, keepSpace: boolean): string | null {
  const d = decode(s);
  if (d === null) return null;
  if (keepSpace) return escText(d);
  const t = collapse(d);
  return t === ' ' ? '' : escText(t);
}

interface OpenElement {
  name: string;
  /** 表の行の前にブラウザが補う `<tbody>`(書かれていない)。 */
  implicit: boolean;
}

/**
 * 読む入力の長さと、開いたままの要素の深さの上限。server は承認の排他の中で同期的に読むので、病的な
 * 入力で止まる時間を抑える。どちらもパーツ 1 つとしては実運用で届かない大きさで、超えたら比べない
 * (`null`。呼び出し側は一致しないものとして扱う)。
 */
const MAX_INPUT_CHARS = 10_000_000;
const MAX_OPEN_ELEMENTS = 4096;

/** 中の空白がそのまま見た目に出る要素。 */
const PRESERVE_SPACE = ['pre', 'listing'];

/**
 * 比較用の正規形。2 つのパーツの正規形が一致すれば、GrapesJS で読み込んだときに同じ DOM になる。
 * 一致しないからといって DOM が違うとは限らない(寄せない書き方の違いは一致させない側に倒す)。
 * 上限を超えた入力・解かない実体参照を含む入力・閉じないまま終わるタグは `null`(比べられない)。
 * `null` 同士も一致とは見なさないこと(`samePartHtml`)。
 */
export function normalizePartHtml(html: string): string | null {
  if (html.length > MAX_INPUT_CHARS) return null;
  const out: string[] = [];
  const stack: OpenElement[] = [];
  // 開いている要素の名前ごとの数。閉じる相手の無い終了タグを、スタックを辿らずに捨てるため
  // (辿ると、閉じない開始タグと相手の無い終了タグの繰り返しで入力長の 2 乗になる)。
  const openCount = new Map<string, number>();
  const push = (e: OpenElement) => {
    stack.push(e);
    openCount.set(e.name, (openCount.get(e.name) ?? 0) + 1);
  };
  const pop = (): OpenElement | undefined => {
    const e = stack.pop();
    if (e) openCount.set(e.name, (openCount.get(e.name) ?? 1) - 1);
    return e;
  };
  const memo = newCommentEndMemo();
  let lower: string | null = null;
  let foreign = 0;
  let text = '';
  // 解かない実体参照に出会った(比べられない)。
  let unresolved = false;
  const n = html.length;
  const flush = () => {
    if (text !== '') {
      const t = normalizeText(
        text,
        PRESERVE_SPACE.some((p) => (openCount.get(p) ?? 0) > 0),
      );
      if (t === null) unresolved = true;
      else out.push(t);
    }
    text = '';
  };
  let i = 0;
  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt < 0) {
      text += html.slice(i);
      break;
    }
    text += html.slice(i, lt);
    const c1 = html[lt + 1];
    if (html.startsWith('<!--', lt)) {
      flush();
      const e = commentEnd(html, lt + 4, memo);
      const end = e < 0 ? n : e;
      out.push(collapse(html.slice(lt, end)));
      i = end;
      continue;
    }
    const endTag = c1 === '/' && isAsciiAlpha(html[lt + 2]);
    if (!endTag && !isAsciiAlpha(c1)) {
      if (c1 === '!' || c1 === '?' || c1 === '/') {
        // doctype・処理命令・bogus コメントは寄せずにそのまま残す。
        flush();
        const gt = html.indexOf('>', lt);
        const end = gt < 0 ? n : gt + 1;
        out.push(collapse(html.slice(lt, end)));
        i = end;
        continue;
      }
      text += '<'; // 名前で始まらない `<` は文字
      i = lt + 1;
      continue;
    }
    flush();
    let k = lt + (endTag ? 2 : 1);
    const nameStart = k;
    while (k < n && !isTagNameEnd(html[k])) k++;
    const name = asciiLower(html.slice(nameStart, k));
    const attrs = new Map<string, string>();
    let selfClosing = false;
    while (k < n && html[k] !== '>') {
      const c = html[k];
      if (isHtmlSpace(c)) {
        k++;
        continue;
      }
      if (c === '/') {
        selfClosing = html[k + 1] === '>';
        k++;
        continue;
      }
      const a = readAttr(html, k, n);
      // 同じ名前の 2 つ目以降はブラウザが捨てる。
      if (!attrs.has(a.name)) {
        const v = normalizeAttrValue(a.name, a.value);
        if (v === null) return null;
        attrs.set(a.name, v);
      }
      k = a.next;
    }
    // `>` の前に入力が終わったタグは、ブラウザが丸ごと捨てる。寄せずに比べない側へ倒す。
    if (k >= n) return null;
    i = k + 1;
    if (endTag) {
      if (name === 'table' && stack[stack.length - 1]?.implicit) {
        out.push('</tbody>');
        pop();
      }
      if ((name === 'svg' || name === 'math') && foreign > 0) foreign--;
      // 相手があるときだけ後ろから閉じる。pop の合計は push の合計を超えないので全体で線形。
      if ((openCount.get(name) ?? 0) > 0) while (pop()?.name !== name);
      out.push(`</${name}>`);
      continue;
    }
    if (foreign === 0 && name === 'tr' && stack[stack.length - 1]?.name === 'table') {
      out.push('<tbody>');
      push({ name: 'tbody', implicit: true });
    }
    const kept = [...attrs]
      .filter(([a, v]) => !IGNORED_ATTRS.has(a) && !((a === 'class' || a === 'style') && v === ''))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([a, v]) => ` ${a}="${escAttr(v)}"`)
      .join('');
    out.push(`<${name}${kept}>`);
    const isForeign = foreign > 0 || name === 'svg' || name === 'math';
    if (isForeign && selfClosing) {
      out.push(`</${name}>`); // 外来要素の `<path/>` は `<path></path>` と同じ
      continue;
    }
    if (isForeign && (name === 'svg' || name === 'math')) foreign++;
    if (!isForeign && VOID_ELEMENTS.has(name)) continue;
    if (!isForeign && RAW_TEXT_ELEMENTS.has(name)) {
      lower ??= asciiLower(html);
      const close = findRawTextEnd(lower, name, i).at;
      const end = close < 0 ? n : close;
      // 中身は文字データ。実体参照も解かない(textarea・title は解くが、寄せない側に倒す)。
      out.push(collapse(html.slice(i, end)));
      i = end;
    }
    push({ name, implicit: false });
    if (unresolved || stack.length > MAX_OPEN_ELEMENTS) return null;
  }
  flush();
  return unresolved ? null : out.join('').trim();
}

/** 2 つのパーツの HTML が比較用の正規形で一致するか。比べられない入力(上限超え)は一致しない。 */
export function samePartHtml(a: string, b: string): boolean {
  const na = normalizePartHtml(a);
  return na !== null && na === normalizePartHtml(b);
}
