// =============================================================================
// cropMarks.ts — トンボ(トリムマーク)を有効化する CSS 注入ヘルパ
// =============================================================================
// プレビュー(ブラウザ内 `@vivliostyle/core`)と PDF(サーバ `@vivliostyle/cli`)は同じ
// vivliostyle エンジンで描画するため, CSS Paged Media の `@page { marks }` 一本で両経路に
// トンボを効かせられる(サーバ/スキーマ改修不要で見た目も一致する)。トンボの ON/OFF は
// プレビュー画面内トグル(`PreviewView.vue`)で切り替え, ここで CSS を組み立てる。
import { appendPreviewStyle, sanitizePreviewRoot, serializePreviewRoot } from '@/lib/sanitizeHtml';

/**
 * トンボ用の `@page` 規則。`crop`(角の裁ちトンボ)+ `cross`(天地左右中央のセンタートンボ)。
 * 既存のファンド別 `@page { size; margin }` とは別規則としてカスケード合流するため, サイズ/
 * 余白は壊さない。
 */
export const CROP_MARKS_CSS = '@page { marks: crop cross; }';

/**
 * 組み立て済みプレビュー文書 `doc` に, `on` のときだけトンボ用 `<style>` を注入して返す純関数
 * (`off` は `doc` をそのまま返す)。PDF 経路は CSS 文字列側へ `CROP_MARKS_CSS` を連結するので
 * この関数は使わない。
 *
 * 入力を**パースし直してから** head へ足す。`</head>` を文字列で探して割り込む形だと、
 * `doc` は他ユーザのテンプレ由来なので、属性値に `</head>` の字面を置かれると
 * アプリが組み立てた `<style>` が属性値の内側へ落ち、CSS の字面が属性トークン列として
 * 再解釈される(= `<title data-x="…" onload=…>` が作れる)。**アンカー探索を戻さないこと。**
 *
 * 再パースにサニタイザを通すのは、この関数の入力が「自分の出力」である保証を呼び出し側の
 * 規律だけに委ねないため(トグルは稀なのでコストは許容する)。
 */
export function withCropMarks(doc: string, on: boolean): string {
  if (!on) return doc;
  const root = sanitizePreviewRoot(doc);
  appendPreviewStyle(root, CROP_MARKS_CSS, { 'data-crop-marks': '' });
  return serializePreviewRoot(root);
}
