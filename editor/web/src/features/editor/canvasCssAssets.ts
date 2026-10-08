// =============================================================================
// canvasCssAssets.ts — 編集画面の canvas 専用に、url() を含む規則を配信 URL へ直した複製を作る
// =============================================================================
// canvas(GrapesJS の iframe)は相対 URL をアプリの URL 基準で解くので、テンプレの CSS の
// `url(fonts/x.woff2)`(= `css/fonts/x.woff2`)や `url(../images/x.svg)`(= `images/x.svg`)は
// 必ず 404 になる。CSS 自体を書き換えると `getCss()` 経由で配信 URL が下書き・申請・確定 CSS へ
// 混ざるので、触らない。代わりに `url()` を含む規則を複製して配信 URL へ直し、canvas 専用の
// `<style>` に置く(`fundImageLayer.ts`)。複製は元の規則と同じセレクタなので、後ろに置けば同じ
// 宣言として勝つ。
//
// 複製に残すのは `url()` を含む宣言だけ(`@font-face` は記述子が揃って初めて 1 つの書体になるので
// 丸ごと)。他の宣言まで複製すると、全規則の後ろに置かれた分だけ優先順位が上がり、元は後続の
// 規則に負けていた宣言(`.a{color:blue}` に対する後ろの `.b{color:red}` など)が canvas でだけ
// 勝ってしまう。`url()` の宣言にも同じことは起こる(後ろの規則で `background:none` に打ち消された
// 背景が canvas でだけ出る)が、これは受け入れる: 表示だけの差で、保存内容と PDF には影響しない。
//
// ただし `url()` の宣言が一括指定(`background` など)のときは、同じ規則でそれより後ろにある同じ
// 系統の個別指定(`background-size` など、`<プロパティ>-` で始まるもの)も残す。一括指定だけを
// 後ろへ置くと、元の規則では一括指定の後ろで上書きされていた個別指定が初期値へ戻されるため。
// 一括指定より前の個別指定は元の規則の中でも一括指定に初期化されているので残さない。
//
// 配信 URL は、フォントがプレビューホスト(`/api/preview-host/css/fonts/…`。同一オリジンで
// cookie が付く)、画像が単体配信ルート(`/api/fund-assets/images/…`)。画像の判定と会社フォルダの
// 照合は `lib/fundImages.ts` と共有する。参照の解決は CSS 自身の位置(`css/`)を基準にする。
// 本文の `<style>` も同じ理由で canvas では解けないので複製するが、こちらは文書の位置(`doc/`)を
// 参照元として解く(書き手は文書からの相対で `url(../css/fonts/…)` と書く)。
//
// 本文の `<style>` は GrapesJS が canvas に置かない(`bodyStyle.ts`)ので、`url()` の宣言だけでなく
// 全規則を複製する(`canvasCssFullCopy`)。直せない `url()` を持つ宣言と、文書の外を取りに行く
// 参照が残る規則は落とす。canvas はアプリの URL 基準で解くので、残しても 404 か文書外への取得に
// しかならない。

import {
  type CssUrlSpan,
  collectCssUrlSpans,
  collectCssUrlSpansInContext,
  findExternalRefsInCss,
  isAllowedDataUrl,
  PREVIEW_HOST_BASE,
  resolveDocAssetPath,
  splitCssRules,
} from '@editor/shared';
import {
  companyFolderMatches,
  FUND_IMAGES_DIR,
  fundImageRefOf,
  fundImageUrl,
  TEMPLATE_CSS_FROM,
} from '@/lib/fundImages';
import { cssString } from './fundImages';

/** フォントの論理ルートでの置き場(CSS からは `url(fonts/…)` と書かれる)。 */
const FONTS_PREFIX = 'css/fonts/';

/** 論理パス → canvas が取りに行く配信 URL。配らないもの(会社フォルダ不一致を含む)は undefined。 */
export function canvasAssetUrl(rel: string, companyCode: string | null): string | undefined {
  if (rel.startsWith(`${FUND_IMAGES_DIR}/`)) {
    const ref = fundImageRefOf(rel);
    if (ref === undefined || !companyFolderMatches(ref, companyCode)) return undefined;
    return fundImageUrl(ref);
  }
  if (!rel.startsWith(FONTS_PREFIX)) return undefined;
  return `/api${PREVIEW_HOST_BASE}/${rel.split('/').map(encodeURIComponent).join('/')}`;
}

/** 先頭のコメントと空白を飛ばして `@font-face` で始まる規則か。 */
const FONT_FACE_RE = /^(?:\s|\/\*[\s\S]*?\*\/)*@font-face\b/i;

/** 宣言の先頭の空白とコメント。 */
const LEADING_TRIVIA_RE = /^(?:\s|\/\*[\s\S]*?\*\/)+/;

/** 宣言(先頭の空白・コメントを除いたもの)のプロパティ名。小文字。`:` が無ければ空。 */
function propertyName(decl: string): string {
  const colon = decl.indexOf(':');
  return colon < 0 ? '' : decl.slice(0, colon).trim().toLowerCase();
}

/** `text` の範囲。`end` は含まない。 */
interface Range {
  start: number;
  end: number;
}

/**
 * 規則本体 `sel{…}` の宣言を、文字列・括弧・コメントの中の `;` `{` `}` を数えずに区切る。
 * 本体の `{` が見つからなければ空。
 */
function declarationRanges(text: string): Range[] {
  const ranges: Range[] = [];
  let open = -1;
  let start = -1;
  let depth = 0;
  let quote = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote !== '') {
      if (ch === '\\') i++;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '\\') {
      i++;
    } else if (ch === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      i = close < 0 ? text.length : close + 1;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '(') {
      depth++;
    } else if (ch === ')') {
      if (depth > 0) depth--;
    } else if (depth === 0 && open < 0 && ch === '{') {
      open = i;
      start = i + 1;
    } else if (depth === 0 && open >= 0 && (ch === ';' || ch === '}')) {
      ranges.push({ start, end: i });
      start = i + 1;
      if (ch === '}') break;
    }
  }
  return ranges;
}

/** `text` の `range` の中の `url()` を配信 URL へ直す。直したものが 1 つも無ければ undefined。 */
function rewriteUrls(
  text: string,
  range: Range,
  spans: readonly CssUrlSpan[],
  companyCode: string | null,
  from: string,
): string | undefined {
  let out = text.slice(range.start, range.end);
  let changed = false;
  // 後ろから置換して、先行する範囲のオフセットを保つ。
  for (const span of [...spans].reverse()) {
    if (span.start < range.start || span.end > range.end) continue;
    const rel = resolveDocAssetPath(span.value, from);
    const url = rel === undefined ? undefined : canvasAssetUrl(rel, companyCode);
    if (url === undefined) continue;
    const s = span.start - range.start;
    const e = span.end - range.start;
    out = `${out.slice(0, s)}url(${cssString(url)})${out.slice(e)}`;
    changed = true;
  }
  return changed ? out : undefined;
}

/**
 * 1 規則の複製を作る。`@font-face` は丸ごと、それ以外は `url()` を直せた宣言と、その後ろにある
 * 同じ系統の個別指定だけを残す。
 * 残すものが無ければ undefined。
 */
function rewriteRule(text: string, companyCode: string | null, from: string): string | undefined {
  const spans = collectCssUrlSpans(text);
  if (spans.length === 0) return undefined;
  if (FONT_FACE_RE.test(text)) {
    return rewriteUrls(text, { start: 0, end: text.length }, spans, companyCode, from);
  }
  const ranges = declarationRanges(text);
  if (ranges.length === 0) return undefined;
  const kept: string[] = [];
  /** これまでに残した `url()` 宣言のプロパティ名(後ろの個別指定を引き込む系統)。 */
  const families: string[] = [];
  for (const range of ranges) {
    const raw = text.slice(range.start, range.end).replace(LEADING_TRIVIA_RE, '');
    const prop = propertyName(raw);
    const decl = rewriteUrls(text, range, spans, companyCode, from);
    if (decl !== undefined) {
      kept.push(decl.replace(LEADING_TRIVIA_RE, '').trim());
      if (prop !== '') families.push(prop);
    } else if (prop !== '' && families.some((f) => prop.startsWith(`${f}-`))) {
      kept.push(raw.trim());
    }
  }
  if (kept.length === 0) return undefined;
  return `${text.slice(0, ranges[0].start)}${kept.join(';')}}`;
}

/**
 * CSS から、`url()` を配信 URL へ直せた規則だけを、囲む at-rule ごと複製して返す
 * (1 規則 1 行。`@font-face` 以外は `url()` の宣言だけ)。直せる参照が無ければ空文字。
 * `from` は参照を解く基準の論理パス。テンプレの CSS は `TEMPLATE_CSS_FROM`、本文の
 * `<style>` は `DOC_DIR`。
 */
export function canvasCssAssetCopy(css: string, companyCode: string | null, from: string): string {
  const out: string[] = [];
  for (const rule of splitCssRules(css)) {
    const rewritten = rewriteRule(rule.text, companyCode, from);
    if (rewritten === undefined) continue;
    out.push(rule.atRules.reduceRight((inner, prelude) => `${prelude}{${inner}}`, rewritten));
  }
  return out.join('\n');
}

// ── 本文の `<style>` の全規則の複製 ──

/** 直さずに残してよい参照(文書の中の断片と、許可した `data:` URI)。canvas は取りに行かない。 */
function staysInDocument(value: string): boolean {
  return value.trim().startsWith('#') || isAllowedDataUrl(value);
}

/**
 * `text` の `range` の `url()` を、直せるものは配信 URL へ直して返す。直せず文書の中でもない
 * 参照が 1 つでもあれば undefined。
 */
function rewriteEveryUrl(
  text: string,
  range: Range,
  spans: readonly CssUrlSpan[],
  companyCode: string | null,
  from: string,
): string | undefined {
  let out = text.slice(range.start, range.end);
  for (const span of [...spans].reverse()) {
    if (span.start < range.start || span.end > range.end) continue;
    const rel = resolveDocAssetPath(span.value, from);
    const url = rel === undefined ? undefined : canvasAssetUrl(rel, companyCode);
    if (url === undefined) {
      if (staysInDocument(span.value)) continue;
      return undefined;
    }
    const s = span.start - range.start;
    const e = span.end - range.start;
    out = `${out.slice(0, s)}url(${cssString(url)})${out.slice(e)}`;
  }
  return out;
}

/**
 * 1 規則を丸ごと複製する。通常の規則は直せない参照を持つ宣言だけを落とす。`@font-face` などの
 * at-rule のブロックは記述子・内側の規則が揃って意味を持つので、直せない参照があれば規則ごと落とす。
 */
function copyWholeRule(text: string, companyCode: string | null, from: string): string | undefined {
  const spans = collectCssUrlSpans(text);
  if (spans.length === 0) return text;
  if (text.trimStart().startsWith('@')) {
    return rewriteEveryUrl(text, { start: 0, end: text.length }, spans, companyCode, from);
  }
  const ranges = declarationRanges(text);
  if (ranges.length === 0) return undefined;
  const kept = ranges.flatMap((range) => {
    const decl = rewriteEveryUrl(text, range, spans, companyCode, from);
    return decl === undefined ? [] : [decl];
  });
  // 宣言を落として空になった規則は出さない(セレクタだけの規則は何も効かない)。
  if (kept.every((decl) => decl.trim() === '')) return undefined;
  return `${text.slice(0, ranges[0].start)}${kept.join(';')}}`;
}

/**
 * 本文の `<style>` の全規則を、`url()` を配信 URL へ直して複製する(1 規則 1 行。囲む at-rule
 * ごと)。直せない `url()` の宣言は落とし、文書の外を取りに行く参照(`@import`・許可外の
 * スキームなど)が残る規則は複製しない。`from` は参照を解く基準の論理パス(`DOC_DIR` など)。
 */
export function canvasCssFullCopy(css: string, companyCode: string | null, from: string): string {
  const out: string[] = [];
  for (const rule of splitCssRules(css)) {
    const copied = copyWholeRule(rule.text, companyCode, from);
    if (copied === undefined) continue;
    const wrapped = rule.atRules.reduceRight((inner, prelude) => `${prelude}{${inner}}`, copied);
    if (findExternalRefsInCss(wrapped).length > 0) continue;
    out.push(wrapped);
  }
  return out.join('\n');
}

// ── canvas に描かれる元の `@font-face` ──

/** 元の `@font-face` の `src` の `url()` を置き換える値。取得を起こさない。 */
const DISABLED_FONT_SRC = 'local("")';

// `url()` に続く `format()` / `tech()`。`local()` には付けられない書き方なので、置き換えと一緒に除く。
const TRAILING_FONT_HINTS = /^(?:\s*(?:format|tech)\([^()]*\))*/i;

/**
 * GrapesJS が canvas に描く規則の文字列から、`@font-face` の `src` のうち `css/fonts/` に解ける
 * `url()` を、取得を起こさない値へ置き換える。canvas はアプリの URL 基準で解くので、元の規則が
 * 取りに行くと SPA の fallback(`index.html`)を受け取り、フォントの解読エラーがコンソールに出る。
 * 後ろに置いた複製だけで足りそうに見えるが、Chromium は記述子の同じ `@font-face` を 1 つの書体に
 * まとめ、複製の読み込みに失敗したときや複製に無い字形があるときに、元の規則へ取りに行く。
 * 書体は複製が配信 URL で担う。GrapesJS のモデル(`getCss` の出どころ)には触れない。
 * `from` は参照を解く基準の論理パス(既定はテンプレの CSS の位置)。
 */
export function canvasFontFaceSrcDisabled(css: string, from: string = TEMPLATE_CSS_FROM): string {
  let out = css;
  // 後ろから置換して、先行する範囲のオフセットを保つ。
  for (const span of collectCssUrlSpansInContext(css).reverse()) {
    if (!span.inFontFaceSrc) continue;
    if (!resolveDocAssetPath(span.value, from)?.startsWith(FONTS_PREFIX)) continue;
    const hints = TRAILING_FONT_HINTS.exec(out.slice(span.end))?.[0] ?? '';
    out = `${out.slice(0, span.start)}${DISABLED_FONT_SRC}${out.slice(span.end + hints.length)}`;
  }
  return out;
}
