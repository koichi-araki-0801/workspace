// =============================================================================
// pdfInputRefs.ts — 単体 PDF の入力 HTML の参照を dataRoot の資産の置き場に限る
// =============================================================================
// create_report は `<dataRoot>/pdf-input/<id>.html` に置いた HTML を組版し、相対参照を
// **パスのとおりに**ファイルとして読む。外部参照の関門(`externalRefs.ts`)は相対参照を
// 「同梱資産」として通すので、そのままだと `<iframe src="../../x/appconfig.json">` のような参照で
// サーバ上の任意のファイルを PDF へ写して持ち出せる。
//
// そこで入力 HTML の取得系の参照をすべて `pdf-input/` を基準に解き、dataRoot 直下の資産の
// 置き場(下の `PDF_ASSET_DIRS`)の内側に収まるものだけを通す。
//
//   <dataRoot>/
//     pdf-input/<id>.html   <- 入力。参照の基準
//     css/  images/  js/    <- 通す(フォントは css/fonts/)
//     それ以外              <- 拒む(templates/・filled/・pdf-input/ 自身・dataRoot の外)
//
// 解き方は配信と同じ `resolveDocAssetPath`(文書を論理ルートの 1 段下に置いて解く)を使う。
// `pdf-input/` も dataRoot の 1 段下なので、論理ルート = dataRoot としてそのまま当てはまる。
// 先頭 `/` のルート相対・ドライブ付き・scheme 付き・`%2e%2e` などの紛らわしい綴りは
// `resolveDocAssetPath` が解けない(undefined)ので拒む側へ倒れる。
//
// 埋め込み文書の要素(`iframe` / `object` / `embed` / `frame`)と `<meta http-equiv=refresh>` は
// 参照先を問わず拒む。どれも別の文書を読み込ませる口で、帳票に使う理由が無い。
import {
  collectCssStringsInFunctions,
  collectCssUrlSpans,
  decodeHtmlEntities,
  fetchUrlAttrsFor,
  findExternalRefsInCss,
  isSelfContainedUrl,
  MAX_REPORTED_REFS,
  normalizeHtmlUrlValue,
  REPORT_INPUT_REF_OUTSIDE,
  resolveDocAssetPath,
  splitSrcsetUrls,
  validation,
} from '@editor/shared';
import { scanTags, type TagSpan } from '../vivliostyle/inlineCss.js';

/** 参照を許す dataRoot 直下の置き場(小文字。Windows は大小を区別しないので比較も小文字)。 */
const PDF_ASSET_DIRS: ReadonlySet<string> = new Set(['css', 'images', 'js']);

/** 参照先を問わず拒む要素。別の文書を読み込ませる口になる。 */
const EMBEDDING_ELEMENTS: ReadonlySet<string> = new Set(['iframe', 'object', 'embed', 'frame']);

/** カンマ区切りで URL と記述子(`1x` `480w`)を並べる属性。先頭の URL だけを解く。 */
const SRCSET_ATTRS: ReadonlySet<string> = new Set(['srcset', 'imagesrcset']);

/** URL を持たない属性(`<link imagesizes>`。外部参照の表には過剰包含で載っている)。 */
const NON_URL_ATTRS: ReadonlySet<string> = new Set(['imagesizes']);

/** 引用符の文字列で画像の URL を取る関数(`image-set("x.png" 1x)` など)。 */
const STRING_URL_FUNCTIONS: ReadonlySet<string> = new Set([
  'image-set',
  '-webkit-image-set',
  'image',
  'cross-fade',
]);

/**
 * raw text 要素の中身(`<svg><title>` の中は foreign content で実要素になる)を走査し直す深さの
 * 上限。`externalRefs.ts` の同名の上限と同じ考え方で、先はタグの字面があれば拒む。
 */
const MAX_NESTED_HTML_DEPTH = 2;

const REF_OUTSIDE_MESSAGE =
  'PDF の入力 HTML が、資産の置き場(css/・images/・js/)の外を参照しているため PDF を作れません。' +
  '参照を ../css/ ../images/ ../js/ の下へ直してから出してください。';

/**
 * 1 つの URL 値が通せるか。`#…` と空は文書内、`data:` は外部参照の関門と同じ判定に任せる。
 * それ以外は `pdf-input/` から解いた先の先頭が資産の置き場で、その下のファイルを指すこと。
 */
function isContainedUrl(url: string): boolean {
  const v = normalizeHtmlUrlValue(url);
  if (v === '' || v.startsWith('#')) {
    return true;
  }
  if (/^data:/i.test(v)) {
    return isSelfContainedUrl(v);
  }
  const resolved = resolveDocAssetPath(v, 'doc');
  if (resolved === undefined) {
    return false;
  }
  const segments = resolved.split('/');
  return segments.length >= 2 && PDF_ASSET_DIRS.has(segments[0].toLowerCase());
}

/**
 * CSS の値(エスケープ解決済み)を URL として判定する。`resolveDocAssetPath` は HTML の文字参照を
 * 解くので、CSS の字面の `&` は `&amp;` へ戻して二重に解かない(解くと区切りが増え、字面とは
 * 違う場所を検めることになる)。
 */
function isContainedCssUrl(value: string): boolean {
  return isContainedUrl(value.replaceAll('&', '&amp;'));
}

/** CSS 1 片の参照のうち、通せないものを `out` へ積む。 */
function collectCssRefs(css: string, out: string[]): void {
  // `@import` などの at-rule と絶対参照は外部参照の関門でも拒むが、この関数だけで閉じるよう重ねて見る。
  out.push(...findExternalRefsInCss(css));
  for (const span of collectCssUrlSpans(css)) {
    if (!isContainedCssUrl(span.value)) {
      out.push(`url(${span.value})`);
    }
  }
  for (const s of collectCssStringsInFunctions(css)) {
    if (STRING_URL_FUNCTIONS.has(s.fn) && !isContainedCssUrl(s.value)) {
      out.push(`${s.fn}("${s.value}")`);
    }
  }
}

/** `<meta http-equiv=refresh>` か(属性名・値は文字参照を解いて比べる)。 */
function isMetaRefresh(tag: TagSpan): boolean {
  return tag.attrs.some(
    (a) =>
      a.name === 'http-equiv' && decodeHtmlEntities(a.value).trim().toLowerCase() === 'refresh',
  );
}

/** 開始タグ 1 つの取得系属性のうち、通せないものを `out` へ積む。 */
function collectTagRefs(tag: TagSpan, out: string[]): void {
  if (EMBEDDING_ELEMENTS.has(tag.name)) {
    out.push(`<${tag.name}>`);
    return;
  }
  if (tag.name === 'meta' && isMetaRefresh(tag)) {
    out.push('<meta http-equiv="refresh">');
    return;
  }
  const watched = fetchUrlAttrsFor(tag.name);
  for (const a of tag.attrs) {
    if (!watched.includes(a.name) || NON_URL_ATTRS.has(a.name)) {
      continue;
    }
    const urls = SRCSET_ATTRS.has(a.name) ? splitSrcsetUrls(a.value) : [a.value];
    for (const url of urls) {
      if (!isContainedUrl(url)) {
        out.push(`<${tag.name} ${a.name}="${url}">`);
      }
    }
  }
}

/** HTML 1 枚分の通せない参照を `out` へ積む(raw text の中身は深さの上限まで降りる)。 */
function collectHtmlRefs(html: string, out: string[], depth: number): void {
  const scan = scanTags(html);
  if (!scan.ok) {
    // 境界が決まらない入れ子は中身を検められない(トップレベルは外部参照の関門が先に拒む)。
    out.push('(解析できない HTML)');
  }
  for (const tag of scan.tags) {
    if (tag.rawText !== undefined && tag.name === 'style') {
      collectCssRefs(tag.rawText, out);
    } else if (tag.rawText !== undefined && tag.name !== 'script') {
      if (depth < MAX_NESTED_HTML_DEPTH) {
        collectHtmlRefs(tag.rawText, out, depth + 1);
      } else if (tag.rawText.includes('<')) {
        out.push('(解析できない HTML)');
      }
    }
    for (const a of tag.attrs) {
      if (a.name === 'style') {
        collectCssRefs(decodeHtmlEntities(a.value), out);
      }
    }
    if (!tag.isEnd) {
      collectTagRefs(tag, out);
    }
  }
}

/**
 * 単体 PDF の入力 HTML が、`pdf-input/` から見て資産の置き場の内側だけを参照することを強制する。
 * 1 件でも外を指せば 400(`REPORT_INPUT_REF_OUTSIDE`)。応答には参照の頭だけと総数を載せる。
 */
export function assertPdfInputRefsContained(html: string, where: string): void {
  const refs: string[] = [];
  collectHtmlRefs(html, refs, 0);
  if (refs.length === 0) {
    return;
  }
  throw validation(REF_OUTSIDE_MESSAGE, {
    code: REPORT_INPUT_REF_OUTSIDE,
    cause: { where, refs: refs.slice(0, MAX_REPORTED_REFS), total: refs.length },
  });
}
