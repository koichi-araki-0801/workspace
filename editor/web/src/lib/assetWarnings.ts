// =============================================================================
// assetWarnings.ts — 文書の資産(CSS・画像)が表示されない理由を利用者向けの警告文にする
// =============================================================================
// 編集画面とプレビューは、CSS ファイルが無いときも、配信されない画像参照があるときも、開くこと
// 自体は止めない(外部ツールの出力を直すまで作業を止めないため)。代わりに理由を警告欄に出す。
// 判定は表示の判定(`fundImages.ts` の `fundImageRefOf` / `companyFolderMatches`)と同じ材料で
// 行い、「警告は出ないのに表示されない」ずれを作らない。
// SVG の検査で配信しない画像だけは web で判定できない(検査はサーバにある)ので、サーバの画像の
// 確認(`FundAssetRepository.inspect`)の結果を警告にする。違反の文言はサーバのものをそのまま出す。
//
// 警告文はテンプレート構文の字面(`{{ fund.code }}`)や SVG の違反の文言を含みうるので、Vue の
// テンプレートへ直書きせず、補間(`{{ m }}`)で出す。補間はテキストとして挿すだけで、式として
// 評価しない(HTML としても解釈しない)。

import {
  collectCssUrlSpans,
  cssFileNameOf,
  DOC_DIR,
  type FundAssetInspectResult,
  resolveDocAssetPath,
} from '@editor/shared';
import {
  attrUrlCandidates,
  companyCodeOfTemplateId,
  companyFolderMatches,
  FUND_IMAGES_DIR,
  type FundImageRef,
  fundImageRefOf,
  servedFundImageOf,
} from './fundImages';
import { JINJA_OPEN_RE } from './jinjaAttrs';

/**
 * 値入り HTML に `{{ … }}` 入りの画像参照が残っているときの警告。テンプレート構文の字面を含むので、
 * Vue のテンプレートへ直書きせず定数として補間する(直書きすると Vue が式として評価する)。
 */
export const FUND_IMAGE_WARNING_MESSAGE =
  '値入り HTML の画像参照に {{ fund.code }} が残っています。' +
  '外部ツールで確定したパスを書いてください。PDF には表示されません';

/** 画像参照が表示されない理由。`jinja` = `{{` が残る、`unserved` = 配信されない形、`company` = 会社フォルダ不一致。 */
export type ImageRefIssue = 'jinja' | 'unserved' | 'company';

const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
const IMAGES_PREFIX = `${FUND_IMAGES_DIR}/`;
/** 警告文に並べる参照の上限(残りは件数で出す)。 */
const LIST_MAX = 3;

/**
 * `<img src>` の値が表示されない理由。表示される・判定の対象外(scheme 付き = data: や外部 URL。
 * 外部参照は別の関門が扱う)は null。`from` は文書なら `'doc'`。
 */
export function imageRefIssue(
  url: string,
  from: string,
  companyCode: string | null,
): ImageRefIssue | null {
  const v = url.trim();
  if (v === '' || v.startsWith('#') || SCHEME_RE.test(v)) return null;
  const rel = resolveDocAssetPath(v, from);
  if (JINJA_OPEN_RE.test(v)) return rel?.startsWith(IMAGES_PREFIX) ? 'jinja' : null;
  if (rel === undefined) return 'unserved';
  const ref = fundImageRefOf(rel);
  if (ref === undefined) return 'unserved';
  return companyFolderMatches(ref, companyCode) ? null : 'company';
}

/** CSS の `url()` のうち `images/` を指すものの問題を拾う(フォント等の他の参照は見ない)。 */
export function cssImageIssues(
  css: string,
  from: string,
  companyCode: string | null,
): Array<[string, ImageRefIssue]> {
  const out: Array<[string, ImageRefIssue]> = [];
  for (const span of collectCssUrlSpans(css)) {
    const rel = resolveDocAssetPath(span.value, from);
    if (rel === undefined || !rel.startsWith(IMAGES_PREFIX)) continue;
    const ref = fundImageRefOf(rel);
    if (ref === undefined) out.push([span.value, 'unserved']);
    else if (!companyFolderMatches(ref, companyCode)) out.push([span.value, 'company']);
  }
  return out;
}

/**
 * 組み立て済みの文書(プレビュー用)から画像参照の問題を拾う。`<img src>`・`<style>`・`style`
 * 属性の `url()` に加え、ほかの属性(`srcset`・`<source srcset>`・`<input src>`・`<video poster>`
 * など)のうち `images/` を指す値も見る — PDF 文書(`pdfDocument.ts`)が落とす参照と同じ範囲。
 */
export function docImageIssues(
  html: string,
  companyCode: string | null,
): Array<[string, ImageRefIssue]> {
  if (html === '') return [];
  const out: Array<[string, ImageRefIssue]> = [];
  const push = (url: string, kind: ImageRefIssue | null): void => {
    if (kind !== null) out.push([url, kind]);
  };
  visitDocImageRefs(html, {
    imgSrc: (src) => push(src, imageRefIssue(src, DOC_DIR, companyCode)),
    css: (css) => out.push(...cssImageIssues(css, DOC_DIR, companyCode)),
    attrUrl: (url) => push(url, imagesAttrIssue(url, companyCode)),
  });
  return out;
}

/** 文書の画像参照を拾う先。`docImageIssues` と `docFundImageRefs` が拾う範囲を揃えるために共有する。 */
interface DocImageRefVisitor {
  /** `<img src>` の値。 */
  imgSrc(src: string): void;
  /** `<style>` の中身と `style` 属性の値。 */
  css(css: string): void;
  /** ほかの属性(`srcset`・`poster` など)の値に含まれる URL の候補。 */
  attrUrl(url: string): void;
}

/** 文書を解いて、画像参照になりうる値を種類ごとに `visitor` へ渡す(`<img src>` → `<style>` → 属性の順)。 */
function visitDocImageRefs(html: string, visitor: DocImageRefVisitor): void {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  for (const img of Array.from(doc.querySelectorAll('img[src]'))) {
    visitor.imgSrc(img.getAttribute('src') ?? '');
  }
  for (const style of Array.from(doc.querySelectorAll('style')))
    visitor.css(style.textContent ?? '');
  for (const el of Array.from(doc.querySelectorAll('*'))) {
    const isImg = el.tagName.toLowerCase() === 'img';
    for (const { name, value } of Array.from(el.attributes)) {
      if (name === 'style') visitor.css(value);
      else if (!(isImg && name === 'src')) {
        for (const url of attrUrlCandidates(name, value)) visitor.attrUrl(url);
      }
    }
  }
}

/** `images/` を指す属性値の問題(`images/` 以外を指す値は見ない)。 */
function imagesAttrIssue(url: string, companyCode: string | null): ImageRefIssue | null {
  const rel = resolveDocAssetPath(url, DOC_DIR);
  if (rel === undefined || !rel.startsWith(IMAGES_PREFIX)) return null;
  const ref = fundImageRefOf(rel);
  if (ref === undefined) return 'unserved';
  return companyFolderMatches(ref, companyCode) ? null : 'company';
}

function listRefs(refs: readonly string[]): string {
  const uniq = [...new Set(refs)];
  const head = uniq.slice(0, LIST_MAX).join('、');
  return uniq.length > LIST_MAX ? `${head} ほか${uniq.length - LIST_MAX}件` : head;
}

/** 画像参照の問題を、種類ごとに 1 文の警告にまとめる。 */
export function imageIssueMessages(
  issues: Iterable<readonly [string, ImageRefIssue]>,
  companyCode: string | null,
): string[] {
  const by: Record<ImageRefIssue, string[]> = { jinja: [], unserved: [], company: [] };
  for (const [ref, kind] of issues) by[kind].push(ref);
  const out: string[] = [];
  if (by.jinja.length > 0) out.push(FUND_IMAGE_WARNING_MESSAGE);
  if (by.unserved.length > 0) {
    out.push(
      `配信されない画像参照があります（${listRefs(by.unserved)}）。` +
        '画像は ../images/<名前> か ../images/<会社フォルダ>/<名前> で参照してください',
    );
  }
  if (by.company.length > 0) {
    out.push(
      `会社フォルダ名がテンプレの会社コード（${companyCode ?? '不明'}）と違うため表示しません` +
        `（${listRefs(by.company)}）`,
    );
  }
  return out;
}

/** SVG の検査で配信しない画像 1 件と、その違反の文言(サーバの `inspectSvg` の文言そのまま)。 */
export interface SvgRejectedImage {
  ref: FundImageRef;
  violations: readonly string[];
}

/** 画像の確認の結果から、SVG の検査で配信しないものだけを取り出す。 */
export function svgRejectedImages(results: readonly FundAssetInspectResult[]): SvgRejectedImage[] {
  return results
    .filter((r) => r.status === 'svg_rejected')
    .map(({ dir, file, violations }) => ({ ref: { dir, file }, violations: violations ?? [] }));
}

/**
 * SVG の検査で配信しない画像の警告(無ければ null)。参照は名前と理由で並べ、理由は 1 画像に
 * つき最初の 1 つだけ出す(違反は 1 枚で数十件になりうり、1 つ直せば次が分かる)。
 */
export function svgRejectedMessage(images: readonly SvgRejectedImage[]): string | null {
  if (images.length === 0) return null;
  const refs = images.map(({ ref, violations }) =>
    violations.length > 0 ? `${ref.file}: ${violations[0]}` : ref.file,
  );
  return (
    `SVG の検査で配信しない画像があります（${listRefs(refs)}）。` +
    '外部ツールの出力を直してください'
  );
}

/**
 * 組み立て済みの文書(プレビュー用)から、配信対象の画像の ref を重複なく並べる(画像の確認に
 * 渡すため)。拾う範囲は `docImageIssues` と同じで、表示しない参照(会社フォルダ違いなど)は
 * 取りに行かないので除く。
 */
export function docFundImageRefs(html: string, companyCode: string | null): FundImageRef[] {
  if (html === '') return [];
  const out = new Map<string, FundImageRef>();
  const add = (url: string): void => {
    if (JINJA_OPEN_RE.test(url)) return;
    const ref = servedFundImageOf(url.trim(), DOC_DIR, companyCode);
    if (ref !== undefined) out.set(JSON.stringify([ref.dir, ref.file]), ref);
  };
  visitDocImageRefs(html, {
    imgSrc: add,
    css: (css) => {
      for (const span of collectCssUrlSpans(css)) add(span.value);
    },
    attrUrl: add,
  });
  return [...out.values()];
}

/** テンプレの CSS ファイルが無いときの警告。名前は文書 ID から導く(サーバが探した名前と同じ)。 */
export function cssMissingMessage(templateId: string): string {
  const name = cssFileNameOf(templateId) ?? `${templateId}.css`;
  return `CSS ${name} が見つかりません。スタイルを当てずに表示しています`;
}

/** 編集画面の警告欄の中身(CSS の不在を先頭に、canvas の画像の警告を続ける)。 */
export function editorAssetWarnings(
  templateId: string,
  cssMissing: boolean,
  imageWarnings: readonly string[],
): string[] {
  return [...(cssMissing ? [cssMissingMessage(templateId)] : []), ...imageWarnings];
}

/**
 * プレビュー画面の警告欄の中身。画像は組み立て済み文書の参照から判定する。SVG の検査の警告は
 * 画像の確認の結果が届いてから足すので、画像の警告の後ろに置く。
 */
export function previewAssetWarnings(
  templateId: string,
  cssMissing: boolean,
  previewDoc: string,
  svgRejected: readonly SvgRejectedImage[] = [],
): string[] {
  const companyCode = companyCodeOfTemplateId(templateId);
  const svg = svgRejectedMessage(svgRejected);
  return [
    ...(cssMissing ? [cssMissingMessage(templateId)] : []),
    ...imageIssueMessages(docImageIssues(previewDoc, companyCode), companyCode),
    ...(svg === null ? [] : [svg]),
  ];
}
