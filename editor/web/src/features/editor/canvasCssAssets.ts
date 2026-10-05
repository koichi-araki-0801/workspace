// =============================================================================
// canvasCssAssets.ts — 編集画面の canvas 専用に、url() を含む規則を配信 URL へ直した複製を作る
// =============================================================================
// canvas(GrapesJS の iframe)は相対 URL をアプリの URL 基準で解くので、テンプレの CSS の
// `url(fonts/x.woff2)`(= `css/fonts/x.woff2`)や `url(../images/x.svg)`(= `images/x.svg`)は
// 必ず 404 になる。CSS 自体を書き換えると `getCss()` 経由で配信 URL が下書き・申請・確定 CSS へ
// 混ざるので、触らない。代わりに `url()` を含む規則だけを複製して配信 URL へ直し、canvas 専用の
// `<style>` に置く(`fundImageLayer.ts`)。複製は元の規則と同じセレクタ・同じ記述子なので、後ろに
// 置けば同じ規則として勝ち、他の宣言の見た目は元の規則のまま変わらない。
//
// 配信 URL は、フォントがプレビューホスト(`/api/preview-host/css/fonts/…`。同一オリジンで
// cookie が付く)、画像が単体配信ルート(`/api/fund-assets/images/…`)。画像の判定と会社フォルダの
// 照合は `lib/fundImages.ts` と共有する。参照の解決は CSS 自身の位置(`css/`)を基準にする。

import {
  collectCssUrlSpans,
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

/** 1 規則の `url()` を配信 URL へ直す。直したものが 1 つも無ければ undefined。 */
function rewriteRule(text: string, companyCode: string | null): string | undefined {
  let out = text;
  let changed = false;
  // 後ろから置換して、先行する範囲のオフセットを保つ。
  for (const span of [...collectCssUrlSpans(text)].reverse()) {
    const rel = resolveDocAssetPath(span.value, TEMPLATE_CSS_FROM);
    const url = rel === undefined ? undefined : canvasAssetUrl(rel, companyCode);
    if (url === undefined) continue;
    out = `${out.slice(0, span.start)}url(${cssString(url)})${out.slice(span.end)}`;
    changed = true;
  }
  return changed ? out : undefined;
}

/**
 * テンプレの CSS から、`url()` を配信 URL へ直せた規則だけを、囲む at-rule ごと複製して返す
 * (1 規則 1 行)。直せる参照が無ければ空文字。
 */
export function canvasCssAssetCopy(css: string, companyCode: string | null): string {
  const out: string[] = [];
  for (const rule of splitCssRules(css)) {
    const rewritten = rewriteRule(rule.text, companyCode);
    if (rewritten === undefined) continue;
    out.push(rule.atRules.reduceRight((inner, prelude) => `${prelude}{${inner}}`, rewritten));
  }
  return out.join('\n');
}
