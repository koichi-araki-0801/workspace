// =============================================================================
// cropMarks.ts — トンボ(トリムマーク)を有効化する CSS 注入ヘルパ
// =============================================================================
// プレビュー(ブラウザ内 `@vivliostyle/core`)と PDF(サーバ `@vivliostyle/cli`)は同じ
// vivliostyle エンジンで描画するため, CSS Paged Media の `@page { marks }` 一本で両経路に
// トンボを効かせられる(サーバ/スキーマ改修不要で見た目も一致する)。トンボの ON/OFF は
// プレビュー画面内トグル(`PreviewView.vue`)で切り替え, ここで CSS を組み立てる。

/**
 * トンボ用の `@page` 規則。`crop`(角の裁ちトンボ)+ `cross`(天地左右中央のセンタートンボ)。
 * 既存のファンド別 `@page { size; margin }` とは別規則としてカスケード合流するため, サイズ/
 * 余白は壊さない。
 */
export const CROP_MARKS_CSS = '@page { marks: crop cross; }';

/**
 * 組み立て済みプレビュー文書 `doc` に, `on` のときだけトンボ用 `<style>` を注入して返す純関数
 * (`off` は `doc` をそのまま返す)。`</head>` 直前へ差し込むのが基本で, 無い異常系は
 * `nunjucksRender.ts` の `assemblePreviewDocument` と同じフォールバック(body 直後 / 完全ラッパ)
 * に倣う。PDF 経路は CSS 文字列側へ `CROP_MARKS_CSS` を連結するのでこの関数は使わない。
 */
export function withCropMarks(doc: string, on: boolean): string {
  if (!on) return doc;
  const styleTag = `<style>${CROP_MARKS_CSS}</style>`;
  if (/<\/head>/i.test(doc)) return doc.replace(/<\/head>/i, `${styleTag}</head>`);
  if (/<body[^>]*>/i.test(doc)) return doc.replace(/<body([^>]*)>/i, `<body$1>${styleTag}`);
  return `<!doctype html><html><head><meta charset="utf-8" />${styleTag}</head><body>${doc}</body></html>`;
}
