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

/** CSS Syntax の改行(入力前処理で CR / CRLF / FF は LF へ畳まれるが、原文のまま走査する)。 */
function isCssNewline(c: string): boolean {
  return c === '\n' || c === '\r' || c === '\f';
}

/**
 * 引用符文字列を 1 つ読み、エスケープ解決後の中身と次位置(閉じ引用符の次)を返す。
 *
 * **改行でも終端する**(CSS Syntax Level 3 §4.3.5 の bad-string-token)。ここを引用符と EOF
 * だけで終端していた版は、1 行未終端の引用符を置くだけで**以降のスタイルシート全体が
 * 検査から消えた** — ブラウザはその宣言だけを捨てて次の `;`/`}` から再開するので、
 * 検査器だけが残り全部を「文字列の中身」と見なす形になる(外部参照ゲートの 400 と
 * `templateScripts.ts` の `pushCssUnits` が同時に無効化される)。
 * 終端時の `next` は**改行の位置**を指す(消費しない) — 呼び出し側の `walkCss` が
 * そこから走査を再開できるようにするため。
 */
function readString(css: string, at: number): { value: string; next: number; bad: boolean } {
  const quote = css[at];
  let i = at + 1;
  let value = '';
  while (i < css.length) {
    const c = css[i];
    if (c === quote) return { value, next: i + 1, bad: false };
    if (isCssNewline(c)) return { value, next: i, bad: true };
    if (c === '\\') {
      // `\` + 改行は行継続で、文字を 1 つも生まない(仕様どおり)。
      if (isCssNewline(css[i + 1] ?? '')) {
        i += css.startsWith('\r\n', i + 1) ? 3 : 2;
        continue;
      }
      const esc = readEscape(css, i);
      value += esc.ch;
      i = esc.next;
      continue;
    }
    value += c;
    i++;
  }
  return { value, next: i, bad: false };
}

/** `url(` の直後から `)` までを読み、エスケープ解決後の URL と次位置を返す。 */
function readUrlToken(css: string, at: number): { value: string; next: number } {
  let i = at;
  while (i < css.length && WS.test(css[i])) i++;
  if (css[i] === '"' || css[i] === "'") {
    const s = readString(css, i);
    // 未終端文字列(改行終端)を含む `url()` は bad-url。閉じ括弧を探しに行かず、その場で
    // 走査を返す — 探しに行くと改行の先が丸ごと「url の中身」として検査から消える。
    if (s.bad) return { value: s.value, next: s.next };
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

/**
 * URL 値が「文書外へ取りに行かない」と言えるか。判定はエスケープ解決後の値に対して行う。
 *
 * 判定前に `\` を `/` へ畳む。WHATWG URL パーサは**特殊スキーム**(http/https/file 等)の
 * base に対して `\` を `/` と同一視するため、`\\host/x` `/\host/x` `\/host/x` はいずれも
 * `http://host/x` へ解決される。畳まずに `startsWith('//')` だけを見ていた版は、この 3 形と
 * CSS エスケープ表記(`\5c\5c host/x`)を「相対参照」として通していた。
 */
export function isSelfContainedUrl(url: string): boolean {
  const v = url.trim().replace(/\\/g, '/');
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
  walkCss(css, {
    atRule: (name) => {
      if (!ALLOWED_AT_RULES.has(name.toLowerCase())) found.push(`@${name}`);
    },
    value: (value, kind) => {
      if (isSelfContainedUrl(value)) return;
      found.push(kind === 'url' ? `url(${value})` : `"${value}"`);
    },
  });
  return found;
}

/**
 * CSS が値として持つ URL 候補を**外部・内部を問わず**すべて拾う(エスケープ解決後)。
 *
 * 用途は `vivliostyle/docAssets.ts` の「実際に参照された資産だけを配信ルートへ置く」判断で、
 * 検査ではない。検査(`findExternalRefsInCss`)と**同じ走査器**を共有するのが要点 —
 * 別の正規表現で拾い直すと「検査は見たが staging は見ていない」形の食い違いが生まれる。
 */
export function collectCssUrlCandidates(css: string): string[] {
  const found: string[] = [];
  walkCss(css, { atRule: () => undefined, value: (value) => found.push(value) });
  return found;
}

/** `collectCssUrlSpans` が返す 1 件。`start`〜`end` は `url(…)` 式全体の原文範囲。 */
export interface CssUrlSpan {
  /** エスケープ解決後の URL 値(`collectCssUrlCandidates` と同じ物差し)。 */
  value: string;
  start: number;
  end: number;
}

/**
 * CSS の `url()` 参照を**原文の置換範囲つき**で拾う。
 *
 * 用途は web の表示境界インライン化(`previewSelfContain.ts` — フォント参照を data: URI へ
 * 置き換える)で、値だけでは足りず「原文のどこを書き換えるか」が要る。検査
 * (`findExternalRefsInCss`)・staging(`collectCssUrlCandidates`)と**同じ走査器**を共有する
 * のが要点で、置換側だけ別の正規表現で探すと「検査は見たが置換は見ていない」形の
 * 食い違い(エスケープで書いた参照が置換だけ素通りする等)が生まれる。
 * 引用符文字列は範囲を返さない — `url()` 以外の形は置換対象にしない(fail closed)。
 */
export function collectCssUrlSpans(css: string): CssUrlSpan[] {
  const found: CssUrlSpan[] = [];
  walkCss(css, {
    atRule: () => undefined,
    value: (value, kind, span) => {
      if (kind === 'url' && span !== undefined) found.push({ value, ...span });
    },
  });
  return found;
}

/** `findExternalRefsInCss` / `collectCssUrlCandidates` / `collectCssUrlSpans` が共有する 1 パス走査。 */
function walkCss(
  css: string,
  visit: {
    atRule: (name: string) => void;
    value: (value: string, kind: 'url' | 'string', span?: { start: number; end: number }) => void;
  },
): void {
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
      visit.value(s.value, 'string');
      i = s.next;
      continue;
    }
    if (c === '@') {
      const id = readIdent(css, i + 1);
      if (id.next > i + 1) visit.atRule(id.value);
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
        // span は `url(` の先頭から閉じ括弧の直後まで = `url(…)` 式全体を置換できる範囲。
        visit.value(u.value, 'url', { start: i, end: u.next });
        i = u.next;
        continue;
      }
      i = id.next;
      continue;
    }
    i++;
  }
}
