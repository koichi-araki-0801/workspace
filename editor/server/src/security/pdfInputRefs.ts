// =============================================================================
// pdfInputRefs.ts — 単体 PDF の入力 HTML の参照を dataRoot の資産の置き場に限る
// =============================================================================
// create_report は `<dataRoot>/pdf-input/<id>.html` に置いた HTML を組版し、相対参照を
// **パスのとおりに**ファイルとして読む。外部参照の関門(`externalRefs.ts`)は相対参照を
// 「同梱資産」として通すので、そのままだと `<iframe src="../../x/appconfig.json">` のような参照で
// サーバ上の任意のファイルを PDF へ写して持ち出せる。
//
// そこで入力 HTML の取得系の参照をすべて、dataRoot 直下の資産の置き場(下の `PDF_ASSET_DIRS`)を
// 指す**単純な相対パス**に限る。create_report がパスを URL として解くかファイルの字面として読むかに
// 依らず同じ場所になる形だけを通す、という考え方で、解決してから包含を見る方式は採らない
// (`?` `#` `%` を URL として落としてから判定すると、字面で読む側と指す場所が割れる)。
//
//   <dataRoot>/
//     pdf-input/<id>.html   <- 入力。参照の基準
//     css/  images/  js/    <- 通す(フォントは css/fonts/)
//     それ以外              <- 拒む(templates/・filled/・pdf-input/ 自身・dataRoot の外)
//
// 通す形は `../<置き場>/<名前>/…/<名前>` だけ。文字参照は解かない: 走査器が渡す属性値は
// 引用符を外しただけの原文で、こちらの復号器と組版器の HTML パーサの復号(名前付き実体の表・
// セミコロン無しの旧形式)が一致する保証が無いため、取得系属性に `&` があれば拒む。`style` 属性
// だけは直列化器が必ず出す `&quot;` などの決まった形に限って解く(`decodeSerializerEntities`)。
// CSS の値は走査器のエスケープ解決の後で、その値に `&` `?` `#` `%` `\` `:` と制御文字があれば拒む。各名前は
// `.` `..`・末尾の `.` や空白(Windows が黙って落とす)・`<>"|?*:` を含むものを拒む。
//
// 埋め込み文書の要素(`iframe` / `object` / `embed` / `frame`)と `<meta http-equiv=refresh>` は
// 参照先を問わず拒む。どれも別の文書を読み込ませる口で、帳票に使う理由が無い。
import {
  collectCssStringsInFunctions,
  collectCssUrlSpans,
  fetchUrlAttrsFor,
  findExternalRefsInCss,
  isSelfContainedUrl,
  MAX_REPORTED_REFS,
  REPORT_INPUT_REF_OUTSIDE,
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
 * 値に現れてはならない文字。URL として読むか字面で読むかで指す場所が割れる文字、文字参照の
 * 解き方で読みが割れる `&`、制御文字。
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: 制御文字を拒むための文字クラス
const FORBIDDEN_IN_PATH_RE = /[?#%&\\:\u0000-\u001f\u007f]/;

/** 1 つの名前(セグメント)に現れてはならない文字(Windows のファイル名に使えない文字)。 */
const FORBIDDEN_IN_SEGMENT_RE = /[<>"|?*:]/;

/** 名前として通せるか。空・`.`・`..`・末尾の `.` や空白(Windows が黙って落として別名になる)を拒む。 */
function isPlainSegment(seg: string): boolean {
  if (seg === '' || /^[. ]+$/.test(seg) || /[. ]$/.test(seg)) {
    return false;
  }
  return !FORBIDDEN_IN_SEGMENT_RE.test(seg);
}

/**
 * 復号済みの 1 つの値が通せるか。空と `#…`(文書内)は通し、`data:` は外部参照の関門と同じ判定に
 * 任せる。それ以外は `../<置き場>/<名前>/…` の単純な並びであること(置き場の比較は大小を無視)。
 */
function isContainedValue(v: string): boolean {
  if (v === '' || v.startsWith('#')) {
    return true;
  }
  if (/^data:/i.test(v)) {
    return isSelfContainedUrl(v);
  }
  if (FORBIDDEN_IN_PATH_RE.test(v)) {
    return false;
  }
  const [up, dir, ...rest] = v.split('/');
  if (up !== '..' || dir === undefined || !PDF_ASSET_DIRS.has(dir.toLowerCase())) {
    return false;
  }
  return rest.length > 0 && rest.every(isPlainSegment);
}

/** CSS 1 片の参照のうち、通せないものを `out` へ積む。 */
function collectCssRefs(css: string, out: string[]): void {
  // `@import` などの at-rule と絶対参照は外部参照の関門でも拒むが、この関数だけで閉じるよう重ねて見る。
  out.push(...findExternalRefsInCss(css));
  // 値は走査器がエスケープを解いた字面。HTML の文字参照としては解かない(復号は 1 回だけ)。
  for (const span of collectCssUrlSpans(css)) {
    if (!isContainedValue(span.value)) {
      out.push(`url(${span.value})`);
    }
  }
  for (const s of collectCssStringsInFunctions(css)) {
    if (STRING_URL_FUNCTIONS.has(s.fn) && !isContainedValue(s.value)) {
      out.push(`${s.fn}("${s.value}")`);
    }
  }
}

/**
 * `<meta http-equiv=refresh>` か。値に文字参照(`&`)があれば解かずに refresh とみなす
 * (解き方の違いで見逃さない側へ倒す)。
 */
function isMetaRefresh(tag: TagSpan): boolean {
  return tag.attrs.some(
    (a) =>
      a.name === 'http-equiv' &&
      (a.value.includes('&') || a.value.trim().toLowerCase() === 'refresh'),
  );
}

/** 直列化器が属性値に出す文字参照(セミコロン付きの決まった形)と、解いた文字。 */
const SERIALIZER_ENTITIES: ReadonlyMap<string, string> = new Map([
  ['&amp;', '&'],
  ['&quot;', '"'],
  ['&#39;', "'"],
  ['&apos;', "'"],
  ['&lt;', '<'],
  ['&gt;', '>'],
  ['&nbsp;', '\u00a0'],
]);

/**
 * `style` 属性の値の文字参照を、直列化器が出す決まった形だけ解く(`style="url(&quot;…&quot;)"` は
 * DOM の直列化で必ず現れる)。それ以外の `&` があれば、どう解かれるか言い切れないので undefined。
 */
function decodeSerializerEntities(value: string): string | undefined {
  let out = '';
  let i = 0;
  while (i < value.length) {
    if (value[i] !== '&') {
      out += value[i];
      i++;
      continue;
    }
    const end = value.indexOf(';', i);
    const decoded = end < 0 ? undefined : SERIALIZER_ENTITIES.get(value.slice(i, end + 1));
    if (decoded === undefined) {
      return undefined;
    }
    out += decoded;
    i = end + 1;
  }
  return out;
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
    // 文字参照は解かない。`&` を含む値は `isContainedValue` が拒む(資産の参照に `&` は要らない)。
    const urls = SRCSET_ATTRS.has(a.name) ? splitSrcsetUrls(a.value) : [a.value];
    if (a.value.includes('&')) {
      out.push(`<${tag.name} ${a.name}="${a.value}">`);
      continue;
    }
    for (const url of urls) {
      if (!isContainedValue(url)) {
        out.push(`<${tag.name} ${a.name}="${url}">`);
      }
    }
  }
}

/**
 * `<style>` の中身にあってはならない字面。走査器は文脈を見ずに `<style>` を raw text として切り出すが、
 * `<svg>` `<math>` の中では foreign content になり、中身はマークアップとして読まれ文字参照も解かれる
 * (`<svg><style><img src=…>` は実要素の画像になる)。PDF の入力では、どちらの読み方でも同じになるよう
 * タグの `<` と文字参照(`&` + `#` か英字)を CSS に置かせない。
 */
const STYLE_MARKUP_RE = /<|&[#A-Za-z]/;

/**
 * `style` 以外の属性の値にある `url()` を検める。SVG の表示属性(`fill` `stroke` `mask` `clip-path`
 * `filter` `marker-*` `cursor` …)は値を CSS として読み、`url(…)` で別の文書を取りに行く。名前の表は
 * 必ず漏れるので、タグ・属性名を問わず値を CSS の走査器に掛け、見つかった `url()` と画像の文字列を
 * 判定する(`url(#id)` は文書内なので通る)。決まった形以外の文字参照があれば、解き方が言い切れないので拒む。
 */
function collectAttrCssRefs(tag: TagSpan, name: string, value: string, out: string[]): void {
  const css = decodeSerializerEntities(value);
  if (css === undefined) {
    out.push(`<${tag.name} ${name}="${value}">`);
    return;
  }
  for (const span of collectCssUrlSpans(css)) {
    if (!isContainedValue(span.value)) {
      out.push(`<${tag.name} ${name}="url(${span.value})">`);
    }
  }
  for (const str of collectCssStringsInFunctions(css)) {
    if (STRING_URL_FUNCTIONS.has(str.fn) && !isContainedValue(str.value)) {
      out.push(`<${tag.name} ${name}="${str.fn}(${str.value})">`);
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
      if (STYLE_MARKUP_RE.test(tag.rawText)) {
        out.push('<style>(タグか文字参照を含む)');
      } else {
        collectCssRefs(tag.rawText, out);
      }
    } else if (tag.rawText !== undefined && tag.name !== 'script') {
      if (depth < MAX_NESTED_HTML_DEPTH) {
        collectHtmlRefs(tag.rawText, out, depth + 1);
      } else if (tag.rawText.includes('<')) {
        out.push('(解析できない HTML)');
      }
    }
    for (const a of tag.attrs) {
      if (a.name === 'style') {
        const css = decodeSerializerEntities(a.value);
        if (css === undefined) {
          out.push(`<${tag.name} style="${a.value}">`);
        } else {
          collectCssRefs(css, out);
        }
      } else {
        collectAttrCssRefs(tag, a.name, a.value, out);
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
