// =============================================================================
// fundImages.ts — ファンド別画像(images/)の配信 URL とファイル名の判定(web 共通)
// =============================================================================
// ファンド別画像は別ツールが `dataRoot/images/` 直下に置き、web はサーバの
// `GET /api/fund-assets/images/:file` だけから取る(SVG 検査と認証を通る唯一の経路)。
// 画面内プレビュー(`previewSelfContain.ts`)と編集画面(`features/editor/fundImages.ts`)が
// 同じ判定と URL を使うよう、ここに 1 つだけ置く。拡張子はサーバの `vivliostyle/docAssets.ts` の
// images グループと揃える — 片方だけ広げると、取りに行っても 404 になるだけの参照を作る。

import { apiPaths, buildPath, resolveServedAssetPath } from '@editor/shared';

/** 配信ルートでの置き場の名前(テンプレの相対参照 `images/…` の先頭)。 */
export const FUND_IMAGES_DIR = 'images';

/** 拡張子 → MIME。`Map` なのは、利用者入力の拡張子で `Object.prototype` を引かないため。 */
const FUND_IMAGE_MIME: ReadonlyMap<string, string> = new Map([
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
]);

/** ファイル名の拡張子から MIME を引く。許可外は `undefined`。 */
export function fundImageMime(file: string): string | undefined {
  const dot = file.lastIndexOf('.');
  return dot < 0 ? undefined : FUND_IMAGE_MIME.get(file.slice(dot).toLowerCase());
}

/**
 * 文書中の参照値(`<img src>` / CSS の `url()`)が images 直下の 1 ファイルを指すなら、その
 * ファイル名を返す。判定は配信ルートの正規化(`resolveServedAssetPath`)を通した形で行う。
 */
export function fundImageFileOf(ref: string): string | undefined {
  const rel = resolveServedAssetPath(ref);
  if (rel === undefined) return undefined;
  const segments = rel.split('/');
  if (segments.length !== 2 || segments[0] !== FUND_IMAGES_DIR) return undefined;
  return fundImageMime(segments[1]) === undefined ? undefined : segments[1];
}

/** ファイル名 → 単体配信ルートの URL(同一オリジン。cookie が付く)。 */
export function fundImageUrl(file: string): string {
  return `/api${buildPath(apiPaths.fundAssetImage, { file })}`;
}
