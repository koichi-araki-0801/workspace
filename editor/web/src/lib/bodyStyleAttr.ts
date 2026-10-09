// =============================================================================
// bodyStyleAttr.ts — canvas の本文の `<style>` の置き場に付ける属性の名前
// =============================================================================
// 置き場を描く側(`features/editor/bodyStyle.ts`)と、それを数えずに飛ばす判定
// (`lib/pageBreaks.ts` の `pageItems`)の両方が読む。lib は features に依存しないので、名前だけを
// ここに置く。

/** 本文の `<style>` の置き場の要素(canvas の view だけに付く)の印。モデルにも保存出力にも無い。 */
export const BODY_STYLE_VIEW_ATTR = 'data-body-style';
