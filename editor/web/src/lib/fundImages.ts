// =============================================================================
// fundImages.ts — ファンド別画像(images/)の判定・配信 URL・会社フォルダの照合(web 共通)
// =============================================================================
// ファンド別画像は別ツールが論理ルートの `images/` に置く。置けるのは直下(`images/<名前>`)と
// 1 段下の会社フォルダ(`images/<会社フォルダ>/<名前>`)だけで、web はサーバの
// `GET /api/fund-assets/images/:file` と `…/:dir/:file` だけから取る(SVG 検査と認証を通る経路)。
// 画面内プレビュー(`previewSelfContain.ts`)・編集画面(`features/editor/`)・PDF 文書
// (`pdfDocument.ts`)が同じ判定と URL を使うよう、ここに 1 つだけ置く。拡張子はサーバの
// `vivliostyle/docAssets.ts` の images グループと揃える — 片方だけ広げると、取りに行っても 404 に
// なるだけの参照を作る。
//
// 会社フォルダはテンプレの会社コードと大文字小文字の違いだけを許す。テンプレ ID が分かる経路
// (編集画面・プレビュー・承認と比較・editor から出す PDF)はすべて `companyFolderMatches` で
// 照合し、合わないものは表示しない。照合をここ 1 本にするのは、経路ごとに判定が割れると
// 「プレビューには出るが PDF には出ない」ずれになるため。

import {
  apiPaths,
  buildPath,
  DOC_CSS_PATH,
  parseAnyTemplateFileName,
  resolveDocAssetPath,
  rewriteCssUrlSpans,
  splitSrcsetUrls,
} from '@editor/shared';

/** 論理ルートでの置き場の名前(参照を解いた論理パスの先頭)。 */
export const FUND_IMAGES_DIR = 'images';

/**
 * テンプレの CSS の参照元として `resolveDocAssetPath` に渡す論理パス。shared の `DOC_CSS_PATH`
 * (`rebaseCssForDoc` が使う値)をそのまま再公開する。web で別に書くと、付け替えと照合で
 * 基準がずれる。
 */
export const TEMPLATE_CSS_FROM: string = DOC_CSS_PATH;

/** 拡張子 → MIME。`Map` なのは、利用者入力の拡張子で `Object.prototype` を引かないため。 */
const FUND_IMAGE_MIME: ReadonlyMap<string, string> = new Map([
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
]);

/** 配信する 1 画像。`dir` は会社フォルダ(直下なら null)。 */
export interface FundImageRef {
  dir: string | null;
  file: string;
}

/** ファイル名の拡張子から MIME を引く。許可外は `undefined`。 */
export function fundImageMime(file: string): string | undefined {
  const dot = file.lastIndexOf('.');
  return dot < 0 ? undefined : FUND_IMAGE_MIME.get(file.slice(dot).toLowerCase());
}

/**
 * 論理パス(`resolveDocAssetPath` の結果)が配信する画像なら ref を返す。深さ 2 以上・
 * 空のセグメント・許可外の拡張子は `undefined`。
 */
export function fundImageRefOf(rel: string): FundImageRef | undefined {
  const segments = rel.split('/');
  if (segments[0] !== FUND_IMAGES_DIR) return undefined;
  if (segments.length !== 2 && segments.length !== 3) return undefined;
  if (segments.some((s) => s === '')) return undefined;
  const file = segments[segments.length - 1];
  if (fundImageMime(file) === undefined) return undefined;
  return { dir: segments.length === 3 ? segments[1] : null, file };
}

/** ref → 単体配信ルートの URL(同一オリジン。cookie が付く)。 */
export function fundImageUrl(ref: FundImageRef): string {
  if (ref.dir === null) return `/api${buildPath(apiPaths.fundAssetImage, { file: ref.file })}`;
  return `/api${buildPath(apiPaths.fundAssetImageInDir, { dir: ref.dir, file: ref.file })}`;
}

/**
 * 会社フォルダ名がテンプレの会社コードと大文字小文字の違いだけで一致するか。直下の画像は
 * 常に true。会社コードが分からないときに会社フォルダの画像は出さない(照合できないため)。
 */
export function companyFolderMatches(ref: FundImageRef, companyCode: string | null): boolean {
  if (ref.dir === null) return true;
  return companyCode !== null && ref.dir.toLowerCase() === companyCode.toLowerCase();
}

/**
 * テンプレ ID(値入り HTML `<会社>_<ファンド>_<基準日>_<版>`、テンプレート `<会社>_<ファンド>_<版>`)から
 * ファンドコードを取り出す。規約外は null。
 */
export function fundCodeOfTemplateId(templateId: string): string | null {
  return parseAnyTemplateFileName(`${templateId}.html`)?.fundCode ?? null;
}

/** テンプレ ID(4 つ区切り・3 つ区切り)から会社コードを取り出す。規約外は null。 */
export function companyCodeOfTemplateId(templateId: string): string | null {
  return parseAnyTemplateFileName(`${templateId}.html`)?.companyCode ?? null;
}

/** 論理パスの分類。`outside` = `images/` の外(解けない参照を含む)、`other` = `images/` 内でも配信しない形。 */
type ImageRelClass =
  | { kind: 'outside' }
  | { kind: 'fundImage'; ref: FundImageRef; companyMatches: boolean }
  | { kind: 'other' };

/**
 * 参照を解いた論理パス(`resolveDocAssetPath` の結果)を、画像参照の判定の 3 分類に分ける。
 * 警告・表示・PDF で落とす対象が、同じ手順で同じ結論になるよう 1 本にする。
 */
export function classifyImageRel(
  rel: string | undefined,
  companyCode: string | null,
): ImageRelClass {
  if (rel === undefined || !rel.startsWith(`${FUND_IMAGES_DIR}/`)) return { kind: 'outside' };
  const ref = fundImageRefOf(rel);
  if (ref === undefined) return { kind: 'other' };
  return { kind: 'fundImage', ref, companyMatches: companyFolderMatches(ref, companyCode) };
}

/**
 * 参照値(`<img src>`・CSS の `url()`)が、表示してよいファンド別画像なら ref を返す。
 * `from` は文書なら `'doc'`、テンプレの CSS なら `TEMPLATE_CSS_FROM`。
 */
export function servedFundImageOf(
  url: string,
  from: string,
  companyCode: string | null,
): FundImageRef | undefined {
  const c = classifyImageRel(resolveDocAssetPath(url, from), companyCode);
  return c.kind === 'fundImage' && c.companyMatches ? c.ref : undefined;
}

/** 複数の URL を詰める属性(`srcset` は `url 1x, url 2x` の形)。 */
const MULTI_URL_ATTRS = new Set(['srcset', 'imagesrcset']);

/**
 * HTML の属性値から、画像参照になりうる URL を並べる(`srcset` 系は候補ごとの URL、ほかは値
 * そのもの)。サーバ(`vivliostyle/docRefs.ts`)は `style` 以外の**全属性**の値を、それぞれ
 * 1 つの参照として文書基準で解いて画像を作業フォルダへ置くので、照合する側も属性を絞らない。
 * `srcset` 系はサーバも候補ごとに分けて解き、値そのものも参照として拾う。
 * PDF 文書(`pdfDocument.ts`)は値そのものも照合し、サーバが解く形を取りこぼさない。
 */
export function attrUrlCandidates(name: string, value: string): string[] {
  if (!MULTI_URL_ATTRS.has(name.toLowerCase())) return [value];
  return splitSrcsetUrls(value);
}

/**
 * CSS の中の、会社フォルダが合わない画像の `url()` を `none` にする(PDF に配置させないため)。
 * 走査は検査・付け替えと同じ `collectCssUrlSpans`(`rewriteCssUrlSpans` の中)で行い、別の正規表現で
 * 拾い直さない。
 */
export function dropUnmatchedCompanyImageUrls(
  css: string,
  from: string,
  companyCode: string | null,
): string {
  return rewriteCssUrlSpans(css, (span) => {
    const c = classifyImageRel(resolveDocAssetPath(span.value, from), companyCode);
    return c.kind !== 'fundImage' || c.companyMatches ? undefined : 'none';
  });
}
