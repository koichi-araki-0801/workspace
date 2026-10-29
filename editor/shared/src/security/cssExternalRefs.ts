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
// 文書内の `#id` しか許さない SVG の検査(`svgInspect.ts`)が使う
// `collectCssStringsInFunctions` はこの方針の裏返しで、関数名を見るのは「URL にならない
// 安全な関数」の許可リストを当てるためだけ。知らない関数の中の文字列は URL 候補の側へ倒れる。

import { asciiLower } from '../html/rawText.js';
import { stripUrlIgnoredChars } from './urlNormalize.js';

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

/**
 * `url` が許可リストの `data:` URI か。SVG の `<image href>` の判定(`svgInspect.ts`)が同じ
 * 許可リストを使うために公開する。リスト自体は公開しない — 呼び出し側で足し引きされると、
 * 「テンプレの著者が未検査の SVG を data URI で直接書ける」経路が開く。
 */
export function isAllowedDataUrl(url: string): boolean {
  const lower = stripUrlIgnoredChars(url).toLowerCase();
  return lower.startsWith('data:') && ALLOWED_DATA_PREFIXES.some((p) => lower.startsWith(p));
}

const HEX = /[0-9a-fA-F]/;
/**
 * CSS の空白(CSS Syntax の whitespace)。NBSP や U+3000 は含まない — 含めると NBSP で始まる
 * `url()` の値を `#g` と読み、ブラウザが相対 URL として解く値を見誤る。
 */
const WS = /[ \t\n\r\f]/;
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

/** CSS Syntax の改行。CR / CRLF / FF は `preprocessCss` が LF へ畳んだ後なので LF だけを見る。 */
function isCssNewline(c: string): boolean {
  return c === '\n';
}

/** `preprocessCss` の結果。`toSource` は前処理後の位置を原文の位置へ戻す。 */
interface PreprocessedCss {
  css: string;
  toSource: (at: number) => number;
}

/**
 * CSS Syntax の入力前処理(CRLF・CR・FF を LF へ、U+0000 を U+FFFD へ)。ブラウザは字句を読む前に
 * これを行うので、走査も前処理後の文字列で行う。原文のまま読むと、16 進エスケープの後ろの空白
 * 1 個として CRLF の CR だけが食われ、残った LF が ident を切る — `\75` + CRLF + `rl(` を
 * ブラウザは `url(` と読むのに、走査器は見落とす。
 * 呼び出し側へ返す位置(置換範囲・規則分割)は原文に対するものなので、位置の対応表を持つ。
 */
function preprocessCss(source: string): PreprocessedCss {
  if (!/[\r\f\0]/.test(source)) return { css: source, toSource: (at) => at };
  let css = '';
  /** 前処理後の位置 → 原文の位置。末尾の 1 つ先も引けるよう `source.length` を足す。 */
  const map: number[] = [];
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    map.push(i);
    if (c === '\r') {
      css += '\n';
      if (source[i + 1] === '\n') i++;
    } else if (c === '\f') css += '\n';
    else if (c === '\0') css += '�';
    else css += c;
  }
  map.push(source.length);
  return { css, toSource: (at) => map[at] ?? source.length };
}

/**
 * 引用符文字列を 1 つ読み、エスケープ解決後の中身と次位置(閉じ引用符の次)を返す。
 *
 * **改行でも終端する**(CSS Syntax Level 3 §4.3.5 の bad-string-token)。ここを引用符と EOF
 * だけで終端すると、1 行未終端の引用符を置くだけで**以降のスタイルシート全体が
 * 検査から消える** — ブラウザはその宣言だけを捨てて次の `;`/`}` から再開するので、
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
        i += 2;
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

/** 前後の CSS の空白だけを外す(`trim` は NBSP なども外すので使わない)。 */
function trimCssWhitespace(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && WS.test(s[start])) start++;
  while (end > start && WS.test(s[end - 1])) end--;
  return s.slice(start, end);
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
  return { value: trimCssWhitespace(value), next: Math.min(i + 1, css.length) };
}

/**
 * URL 値が「文書外へ取りに行かない」と言えるか。判定はエスケープ解決後の値に対して行う。
 *
 * 判定前に URL パーサが外す文字を外し(`stripUrlIgnoredChars`)、`\` を `/` へ畳む。
 * WHATWG URL パーサは**特殊スキーム**(http/https/file 等)の
 * base に対して `\` を `/` と同一視するため、`\\host/x` `/\host/x` `\/host/x` はいずれも
 * `http://host/x` へ解決される。畳まずに `startsWith('//')` だけを見ると、この 3 形と
 * CSS エスケープ表記(`\5c\5c host/x`)を「相対参照」として通してしまう。
 */
export function isSelfContainedUrl(url: string): boolean {
  const v = stripUrlIgnoredChars(url).replace(/\\/g, '/');
  if (v === '' || v.startsWith('#')) return true;
  // `//host/x` は scheme 相対 = 外部。`:` より先に現れる `/` は path 区切りなので相対。
  if (v.startsWith('//')) return false;
  const lower = v.toLowerCase();
  if (lower.startsWith('data:')) {
    return isAllowedDataUrl(lower);
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
 * `@namespace` の名前空間 URI(`@namespace [接頭辞] <文字列 | url()>;` の形に最上位で収まるもの)は
 * ブラウザが取得しないので報告しない。
 */
export function findExternalRefsInCss(css: string): string[] {
  const found: string[] = [];
  walkCss(css, {
    atRule: (name) => {
      if (!ALLOWED_AT_RULES.has(name.toLowerCase())) found.push(`@${name}`);
    },
    value: ({ kind, value, ctx }) => {
      if (ctx.namespace) return;
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
  walkCss(css, { atRule: () => undefined, value: ({ value }) => found.push(value) });
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
    value: (v) => {
      if (v.kind === 'url') found.push({ value: v.value, ...v.span });
    },
  });
  return found;
}

/** `collectCssUrlSpansInContext` が返す 1 件。 */
interface CssUrlSpanInContext extends CssUrlSpan {
  /**
   * 最上位の `@font-face { … }` ブロック直下の `src` 宣言の中にあり、かつそのブロックが閉じて
   * いる。範囲が特定できない(閉じていない・入れ子・`src` 以外の宣言)ときは false(fail closed)。
   */
  inFontFaceSrc: boolean;
  /** `@namespace` の名前空間 URI か(`walkCss` の `CssStringContext.namespace`)。取得されない。 */
  inNamespacePrelude: boolean;
}

/**
 * `collectCssUrlSpans` と同じ走査器で `url()` を拾い、`@font-face` の `src` 記述子の中かを
 * 併せて返す。ブロック境界は走査器がコメント・文字列・`url()` を読み飛ばした後の `{` `}` `;`
 * だけを見るので、正規表現で切り出す方式と違いコメントや文字列に隠した括弧に騙されない。
 */
export function collectCssUrlSpansInContext(css: string): CssUrlSpanInContext[] {
  const found: CssUrlSpanInContext[] = [];
  /** 開いているブロックが最上位の `@font-face` か(入れ子の外側から順)。 */
  const stack: boolean[] = [];
  /** 開いている最上位 `@font-face` の中で見つけた `url()`。閉じた時点で確定させる。 */
  let faceItems: CssUrlSpanInContext[] = [];
  let pending = '';
  let declStart = 0;
  /** `declStart` の宣言が `src:` で始まるか。宣言ごとに 1 回だけ判定して持ち回る。 */
  let declIsSrc: boolean | undefined;
  walkCss(css, {
    atRule: (name) => {
      pending = name.toLowerCase();
    },
    punct: (ch, at) => {
      if (ch === '{') {
        stack.push(pending === 'font-face' && stack.length === 0);
        pending = '';
      } else if (ch === '}') {
        if (stack.length === 1 && stack[0]) {
          found.push(...faceItems);
          faceItems = [];
        }
        stack.pop();
      } else {
        pending = '';
      }
      declStart = at + 1;
      declIsSrc = undefined;
    },
    value: (v) => {
      if (v.kind !== 'url') return;
      const { value, span, ctx } = v;
      const inFace = stack.length === 1 && stack[0] === true;
      // url() ごとに `slice` + 正規表現を掛け直すと、長い空白の後に `x:url()` を並べた入力で
      // 二乗時間になる。宣言の頭は同じなので最初の 1 回だけ見る。
      if (inFace && declIsSrc === undefined) {
        declIsSrc = /^\s*src\s*:/i.test(css.slice(declStart, span.start));
      }
      const isSrc = inFace && declIsSrc === true;
      const item = {
        value,
        ...span,
        inFontFaceSrc: isSrc,
        inNamespacePrelude: ctx.namespace,
      };
      if (inFace) faceItems.push(item);
      else found.push(item);
    },
  });
  // 閉じていないブロックの url() は範囲が確定していないので false で返す。
  for (const it of faceItems) found.push({ ...it, inFontFaceSrc: false });
  return found;
}

/** `collectCssStringsInFunctions` が返す 1 件。 */
interface CssFunctionString {
  /** エスケープ解決後の文字列の値。 */
  value: string;
  /**
   * 文字列を囲むいちばん内側の関数の名前(エスケープ解決後、ASCII の範囲だけ小文字化)。
   * カスタムプロパティ・`initial-value` の値の最上位にある文字列は空文字。
   */
  fn: string;
}

/**
 * 関数の引数にある引用符の文字列を、囲む関数の名前と組で返す(用途は `svgInspect.ts` の
 * 「`#id` 以外を指す文字列」の検査)。`image-set("x.png" 1x)` のように引用符の文字列で URL を
 * 取る関数があるため。関数の外の文字列(`font-family:"F"` `content:"注"`)は URL にならないので
 * 返さないが、カスタムプロパティ(`--u:"x.png"`)と `@property` の `initial-value` の値は
 * `var()` で関数の中へ差し込めるので、関数名を空にして返す。
 *
 * 関数の範囲は走査器が数える括弧で決める。名前と `(` の間に空白やコメントを挟んだ括弧は関数では
 * なく(CSS Syntax の function-token にならない)、外側の関数を引き継ぐ。関数の中の `;` `}` では
 * 抜けない — ブラウザも関数を対応する `)` まで読むので、ここで抜けると見え方が割れる。
 */
export function collectCssStringsInFunctions(css: string): CssFunctionString[] {
  const found: CssFunctionString[] = [];
  walkCss(css, {
    atRule: () => undefined,
    value: ({ kind, value, ctx }) => {
      if (kind !== 'string') return;
      if (ctx.fn !== undefined) {
        found.push({ value, fn: ctx.fn });
        return;
      }
      if (ctx.decl !== undefined && isSubstitutableDecl(ctx.decl)) {
        found.push({ value, fn: '' });
      }
    },
  });
  return found;
}

/**
 * 値を `var()` で別の宣言へ差し込める宣言(カスタムプロパティと `@property` の
 * `initial-value`)か。値に `{}` のブロックも持てる。
 */
function isSubstitutableDecl(decl: string): boolean {
  return decl.startsWith('--') || asciiLower(decl) === 'initial-value';
}

/** `collectCssStructure` の結果。位置はすべて原文のオフセット。 */
interface CssStructure {
  /** コメント・文字列・`url()` の外にある `{` `}` `;`(出現順)。 */
  punct: Array<{ ch: '{' | '}' | ';'; at: number }>;
  /** コメントの範囲 `[start, end)`(出現順)。 */
  comments: Array<{ start: number; end: number }>;
  /** at-rule の `@` の位置 → エスケープ解決後の名前。 */
  atRules: Map<number, string>;
}

/**
 * CSS を規則へ分けるための構造を返す(用途は `css/cssRules.ts` のペア同期)。検査と同じ走査器を
 * 使うのが要点で、別の正規表現で括弧を数えると、文字列やコメントに入った `{` `}` で検査と
 * 分割の解釈が割れる。
 */
export function collectCssStructure(css: string): CssStructure {
  const out: CssStructure = { punct: [], comments: [], atRules: new Map() };
  walkCss(css, {
    atRule: (name, at) => {
      out.atRules.set(at, name);
    },
    value: () => undefined,
    punct: (ch, at) => {
      out.punct.push({ ch, at });
    },
    comment: (start, end) => {
      out.comments.push({ start, end });
    },
  });
  return out;
}

/** `walkCss` が `visit.value` へ渡す値。`url()` だけが原文の範囲を持つ。 */
type CssValue =
  | { kind: 'string'; value: string; ctx: CssStringContext }
  | { kind: 'url'; value: string; ctx: CssStringContext; span: { start: number; end: number } };

/** 引用符の文字列・`url()` が置かれた文脈(`walkCss` が値に添えて渡す)。 */
interface CssStringContext {
  /** いちばん内側の関数の名前(`asciiLower` 済み)。関数の外なら undefined。 */
  fn: string | undefined;
  /** 括弧の外で、宣言の先頭に読んだ ident(エスケープ解決後)。無ければ undefined。 */
  decl: string | undefined;
  /**
   * `@namespace [接頭辞] <文字列 | url()>;` の形に最上位で収まった名前空間 URI か。名前空間 URI は
   * ブラウザが取得しないので外部参照として数えない。形から外れたもの(2 つ目の値・関数で包む・
   * `;` で閉じない・規則のブロックの中)は false(崩れた `@namespace` はブラウザが捨てるが、
   * 検査は安全側へ倒す)。
   */
  namespace: boolean;
}

/**
 * `findExternalRefsInCss` / `collectCssUrlCandidates` / `collectCssUrlSpans` /
 * `collectCssStructure` / `collectCssStringsInFunctions` が共有する 1 パス走査。
 * 走査は前処理後の文字列(`preprocessCss`)で行い、`visit` へ渡す位置は原文の位置へ戻す。
 */
function walkCss(
  source: string,
  visit: {
    /** `at` は `@` の位置。 */
    atRule: (name: string, at: number) => void;
    value: (v: CssValue) => void;
    /** コメント・文字列・`url()` の外にある `{` `}` `;` の位置。ブロックの範囲を取るために使う。 */
    punct?: (ch: '{' | '}' | ';', at: number) => void;
    /** コメントの範囲 `[start, end)`。閉じていないコメントは末尾まで。 */
    comment?: (start: number, end: number) => void;
  },
): void {
  const { css, toSource } = preprocessCss(source);
  let i = 0;
  /**
   * 開いている括弧の閉じ文字と、関数の括弧(名前の直後の `(`)か。CSS Syntax の「単純ブロック」と
   * 同じく、閉じ文字が最も内側の括弧と合わないものは無視する — `f({)} "x")` の `)` で `f` を
   * 閉じると、ブラウザが `f` の中と見る文字列を外と見誤る。最上位の `{` `}` は規則のブロックで、
   * ここには積まない(`punct` で扱う)。ただし差し込める宣言の値の中の `{` は値のブロックとして積む
   * (`--u:{} "x"` の `{` で宣言を区切ると、後ろの文字列を値の外と見誤る)。
   * 関数とみなすのは名前の直後の `(` で、`#name(` も関数として読む(ブラウザより広いが、
   * 関数の中の文字列を検査する側へ倒れるだけなので害は無い)。
   */
  const blocks: Array<{ close: ')' | ']' | '}'; fn: boolean }> = [];
  /** 開いている関数の名前(内側が末尾)。`blocks` の `fn: true` の数と一致する。 */
  const fns: string[] = [];
  let decl: string | undefined;
  /** 括弧の外で `{` `}` `;` の直後(宣言の先頭の ident を待っている)か。 */
  let atDeclStart = true;
  /** 宣言の先頭の ident を読んだ直後で、`:` を待っているか。 */
  let afterDeclName = false;
  /** 差し込める宣言(`isSubstitutableDecl`)の `:` の後ろ(値の中)か。 */
  let inSubstValue = false;
  /**
   * 開いている規則のブロック(`{`)の深さ。値の括弧の中の `{` は数えない。`@namespace` は 0 で、
   * 宣言の値の外でだけ効く。
   */
  let ruleDepth = 0;
  /**
   * `@namespace` の前置きを読んでいる段階。`prefix` は接頭辞か URI を待つ、`uri` は接頭辞の後で
   * URI を待つ、`end` は URI の後で `;` を待つ。形から外れたら undefined に戻す。
   */
  let ns: 'prefix' | 'uri' | 'end' | undefined;
  /** `ns` が `end` の間、`;` まで渡すのを保留している URI。 */
  let nsHeld: CssValue | undefined;
  /** 保留した URI を渡して、`@namespace` の前置きの読みを終える。 */
  const endNamespace = (asNamespace: boolean): void => {
    const held = nsHeld;
    nsHeld = undefined;
    ns = undefined;
    if (held !== undefined) {
      visit.value({ ...held, ctx: { ...held.ctx, namespace: asNamespace } });
    }
  };
  /** URI を待っている段階なら値を保留して true を返す(呼び出し側はその場で渡さない)。 */
  const holdNamespaceUri = (v: CssValue): boolean => {
    if (ns !== 'prefix' && ns !== 'uri') return false;
    nsHeld = v;
    ns = 'end';
    return true;
  };
  while (i < css.length) {
    const c = css[i];
    if (c === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      const next = end === -1 ? css.length : end + 2;
      visit.comment?.(toSource(i), toSource(next));
      i = next;
      continue;
    }
    if (c === '"' || c === "'") {
      const s = readString(css, i);
      const ctx: CssStringContext = { fn: fns[fns.length - 1], decl, namespace: false };
      if (ns === 'end') endNamespace(false);
      const v: CssValue = { kind: 'string', value: s.value, ctx };
      if (!holdNamespaceUri(v)) visit.value(v);
      atDeclStart = false;
      afterDeclName = false;
      i = s.next;
      continue;
    }
    if (c === '@') {
      if (ns !== undefined) endNamespace(false);
      const id = readIdent(css, i + 1);
      if (id.next > i + 1) {
        visit.atRule(id.value, toSource(i));
        // 宣言の値の中(`decl` がある)は、深さが 0 でも最上位の規則ではない。style 属性の宣言の並び
        // には `{` が無く、深さだけでは `--x:@namespace "…"` を見分けられない。
        if (
          asciiLower(id.value) === 'namespace' &&
          ruleDepth === 0 &&
          blocks.length === 0 &&
          decl === undefined
        ) {
          ns = 'prefix';
        }
      }
      atDeclStart = false;
      afterDeclName = false;
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
        const span = { start: toSource(i), end: toSource(u.next) };
        const ctx: CssStringContext = { fn: fns[fns.length - 1], decl, namespace: false };
        if (ns === 'end') endNamespace(false);
        const v: CssValue = { kind: 'url', value: u.value, ctx, span };
        if (!holdNamespaceUri(v)) visit.value(v);
        atDeclStart = false;
        afterDeclName = false;
        i = u.next;
        continue;
      }
      // `@namespace` の接頭辞は関数でない ident 1 つだけ。2 つ目の語や関数は形から外れる。
      if (ns === 'prefix' && css[id.next] !== '(') ns = 'uri';
      else if (ns !== undefined) endNamespace(false);
      afterDeclName = atDeclStart && blocks.length === 0;
      if (afterDeclName) decl = id.value;
      atDeclStart = false;
      if (css[id.next] === '(') {
        blocks.push({ close: ')', fn: true });
        fns.push(asciiLower(id.value));
        i = id.next + 1;
        continue;
      }
      i = id.next;
      continue;
    }
    // 前置きの読みは空白とコメントだけを読み飛ばす。`;` で閉じたときだけ URI を名前空間 URI として
    // 渡す。`punct` より先に渡す(`collectCssUrlSpansInContext` は `;` で宣言の頭を進める)。
    if (ns !== undefined && !WS.test(c)) endNamespace(c === ';' && ns === 'end');
    if (c === '{' || c === '}' || c === ';') visit.punct?.(c, toSource(i));
    const valueBlock = c === '{' && inSubstValue;
    if (blocks.length === 0 && !valueBlock) {
      if (c === '{') ruleDepth++;
      else if (c === '}' && ruleDepth > 0) ruleDepth--;
    }
    if (blocks.length === 0 && !valueBlock && (c === '{' || c === '}' || c === ';')) {
      decl = undefined;
      atDeclStart = true;
      afterDeclName = false;
      inSubstValue = false;
    } else if (c === '(' || c === '[' || c === '{') {
      blocks.push({ close: c === '(' ? ')' : c === '[' ? ']' : '}', fn: false });
      atDeclStart = false;
      afterDeclName = false;
    } else if (c === ')' || c === ']' || c === '}') {
      if (blocks[blocks.length - 1]?.close === c && blocks.pop()?.fn === true) fns.pop();
    } else if (!WS.test(c)) {
      if (c === ':' && afterDeclName && decl !== undefined)
        inSubstValue = isSubstitutableDecl(decl);
      atDeclStart = false;
      afterDeclName = false;
    }
    i++;
  }
  if (ns !== undefined) endNamespace(false);
}
