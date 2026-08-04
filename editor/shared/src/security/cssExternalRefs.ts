// =============================================================================
// cssExternalRefs.ts — CSS が「文書の外へ取りに行く」参照を洗い出す
// =============================================================================
// PDF 経路(サーバの headless ブラウザ)には CSP が無く、CSS の `@import` と URL 値は
// DOMPurify を一切通らない。つまり CSS 1 本でビルドサーバの位置から任意 URL への GET が
// 出る(属性セレクタ + `background:url()` を組めば帳票の内容そのものを外へ運べる)。
//
// **削るのではなく拒む**(fail closed)。削る実装は必ず迂回される: CSS は識別子と URL の
// どちらでも `\` エスケープを許すため、`@\69 mport` や `url(\68ttp://evil/x)` は正規表現に
// 引っかからずブラウザには `@import` / `http://…` として届く。よってここは**エスケープを
// 解決してから**判定する小さなトークナイザで書き、正規表現でのパターン照合は使わない。
//
// 置き場が `shared` なのは、**関門をサーバ側に置く**ため。ブラウザの `pdfDocument.ts` だけに
// 検査を入れていた頃は、公開 API `POST /api/build` へ直接 POST すれば無検査で headless へ
// 届いた(UI を経由しない経路が唯一の関門を迂回する形)。web は早期フィードバックとして
// 同じ関数を呼ぶが、**それを唯一の関門にしない**。
//
// ⚠ URL の検出は「`url()` を探す」ではなく「**文字列値と未引用トークンのうち、外部を指す形を
// 全部拾う**」で書く。関数名を数え上げる形は `image-set("http://evil/x.png" 1x)` のように
// 引用符文字列で URL を取る CSS 関数で破れる(実測)。どの構文が URL を取りうるかの列挙は
// 必ず漏れるので、値の形だけを見る。

/**
 * 取得を伴わない at-rule の許可リスト。ここに無い at-rule 名は「未知」として報告する。
 *
 * CSS Paged Media のマージンボックス(`@bottom-center` 等 16 種)を含める。これらは
 * `@page` の内側にしか現れない**内部**の規則で外部取得を伴わないうえ、ページ番号を印字する
 * ごく普通のテンプレ CSS が使う(本製品自身の `MERGE_PAGE_COUNTER_CSS` がその形)。
 * 落とすと「外部参照が含まれる」という誤った文言で PDF 生成が恒久的に失敗する。
 */
const ALLOWED_AT_RULES = new Set([
  'charset',
  'namespace',
  'media',
  'supports',
  'page',
  'font-face',
  'font-feature-values',
  'font-palette-values',
  'counter-style',
  'keyframes',
  '-webkit-keyframes',
  '-moz-keyframes',
  'layer',
  'container',
  'property',
  'scope',
  'starting-style',
  // CSS Paged Media のマージンボックス 16 種。
  'top-left-corner',
  'top-left',
  'top-center',
  'top-right',
  'top-right-corner',
  'bottom-left-corner',
  'bottom-left',
  'bottom-center',
  'bottom-right',
  'bottom-right-corner',
  'left-top',
  'left-middle',
  'left-bottom',
  'right-top',
  'right-middle',
  'right-bottom',
]);

/**
 * URL 値として許可する `data:` の接頭辞。`data:image/svg+xml` は**入れない** — SVG は
 * 文脈次第でスクリプトを持ち込めるため(必要になったら足す = fail closed)。
 */
const ALLOWED_DATA_PREFIXES = [
  'data:image/png',
  'data:image/jpeg',
  'data:image/jpg',
  'data:image/gif',
  'data:image/webp',
  'data:font/',
  'data:application/font-woff',
];

const HEX = /[0-9a-fA-F]/;
const WS = /\s/;
/** ident を構成する ASCII 文字。非 ASCII(U+0080 以降)は CSS 仕様どおり無条件で ident 文字。 */
const IDENT_ASCII = /[a-zA-Z0-9_-]/;

/** `\` エスケープを 1 つ消費し、実際の文字と次位置を返す(CSS Syntax Level 3 の consume escape)。 */
function readEscape(css: string, at: number): { ch: string; next: number } {
  let i = at + 1;
  if (i >= css.length) return { ch: '�', next: i };
  if (!HEX.test(css[i])) return { ch: css[i], next: i + 1 };
  let hex = '';
  while (i < css.length && hex.length < 6 && HEX.test(css[i])) {
    hex += css[i];
    i++;
  }
  // 16 進エスケープの直後の空白 1 個は区切りとして食われる(`\68 ttp` ではなく `http`)。
  if (i < css.length && WS.test(css[i])) i++;
  const cp = Number.parseInt(hex, 16);
  const ch = cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '�';
  return { ch, next: i };
}

/** ident を 1 つ読み、エスケープ解決後の文字列と次位置を返す。 */
function readIdent(css: string, at: number): { value: string; next: number } {
  let i = at;
  let value = '';
  while (i < css.length) {
    const c = css[i];
    if (c === '\\') {
      const esc = readEscape(css, i);
      value += esc.ch;
      i = esc.next;
    } else if (IDENT_ASCII.test(c) || c.charCodeAt(0) >= 0x80) {
      value += c;
      i++;
    } else break;
  }
  return { value, next: i };
}

/** 引用符文字列を 1 つ読み、エスケープ解決後の中身と次位置(閉じ引用符の次)を返す。 */
function readString(css: string, at: number): { value: string; next: number } {
  const quote = css[at];
  let i = at + 1;
  let value = '';
  while (i < css.length) {
    const c = css[i];
    if (c === quote) return { value, next: i + 1 };
    if (c === '\\') {
      const esc = readEscape(css, i);
      value += esc.ch;
      i = esc.next;
      continue;
    }
    value += c;
    i++;
  }
  return { value, next: i };
}

/** `url(` の直後から `)` までを読み、エスケープ解決後の URL と次位置を返す。 */
function readUrlToken(css: string, at: number): { value: string; next: number } {
  let i = at;
  while (i < css.length && WS.test(css[i])) i++;
  if (css[i] === '"' || css[i] === "'") {
    const s = readString(css, i);
    let j = s.next;
    while (j < css.length && css[j] !== ')') j++;
    return { value: s.value, next: Math.min(j + 1, css.length) };
  }
  let value = '';
  while (i < css.length && css[i] !== ')') {
    if (css[i] === '\\') {
      const esc = readEscape(css, i);
      value += esc.ch;
      i = esc.next;
      continue;
    }
    value += css[i];
    i++;
  }
  return { value: value.trim(), next: Math.min(i + 1, css.length) };
}

/** URL 値が「文書外へ取りに行かない」と言えるか。判定はエスケープ解決後の値に対して行う。 */
export function isSelfContainedUrl(url: string): boolean {
  const v = url.trim();
  if (v === '' || v.startsWith('#')) return true;
  // `//host/x` は scheme 相対 = 外部。`:` より先に現れる `/` は path 区切りなので相対。
  if (v.startsWith('//')) return false;
  const lower = v.toLowerCase();
  if (lower.startsWith('data:')) {
    return ALLOWED_DATA_PREFIXES.some((p) => lower.startsWith(p));
  }
  const colon = v.indexOf(':');
  if (colon < 0) return true;
  const beforeColon = v.slice(0, colon);
  const looksLikeScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*$/.test(beforeColon);
  const slash = v.search(/[/?#]/);
  // `a/b:c` のように `:` が path の中にあるだけなら相対参照。
  if (slash >= 0 && slash < colon) return true;
  return !looksLikeScheme;
}

/**
 * CSS から「文書の外へ取りに行く参照」を洗い出し、見つかった順に説明文字列で返す
 * (空配列 = 外部参照なし)。呼び出し側は**削らずに拒む**こと。
 *
 * 検出するのは (a) 許可リストに無い at-rule(`@import` / `@use` など)、
 * (b) `url()` の値、(c) **引用符文字列の値**のうち、scheme 付き・scheme 相対・許可外
 * `data:` の形をしたもの。(c) を入れているのは `image-set("http://…")` のように引用符
 * 文字列で URL を取る関数を関数名の列挙で追えないため。`content:"注: 説明"` のような
 * 通常の文字列は `注` が scheme の形をしないので報告されない。
 */
export function findExternalRefsInCss(css: string): string[] {
  const found: string[] = [];
  let i = 0;
  while (i < css.length) {
    const c = css[i];
    if (c === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      i = end === -1 ? css.length : end + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      const s = readString(css, i);
      if (!isSelfContainedUrl(s.value)) found.push(`"${s.value}"`);
      i = s.next;
      continue;
    }
    if (c === '@') {
      const id = readIdent(css, i + 1);
      if (id.next > i + 1 && !ALLOWED_AT_RULES.has(id.value.toLowerCase())) {
        found.push(`@${id.value}`);
      }
      i = id.next > i + 1 ? id.next : i + 1;
      continue;
    }
    if (c === '\\' || IDENT_ASCII.test(c) || c.charCodeAt(0) >= 0x80) {
      const id = readIdent(css, i);
      if (id.next === i) {
        i++;
        continue;
      }
      // `url` は関数名としてのみ意味を持つ(直後が `(` の場合だけ URL トークンを読む)。
      if (id.value.toLowerCase() === 'url' && css[id.next] === '(') {
        const u = readUrlToken(css, id.next + 1);
        if (!isSelfContainedUrl(u.value)) found.push(`url(${u.value})`);
        i = u.next;
        continue;
      }
      i = id.next;
      continue;
    }
    i++;
  }
  return found;
}
