// =============================================================================
// bodyStyleAttr.ts — canvas の本文の `<style>` の置き場に付ける属性の名前(shared の再 export)
// =============================================================================
// 置き場を描く側(`features/editor/bodyStyle.ts`)と、それを数えずに飛ばす判定
// (shared の `pageSplit.ts` の `pageItems`)の両方が読む。名前の実体は判定と同じ `pageSplit.ts` に
// あり、web の import 先を変えないためここから出す。
export { BODY_STYLE_VIEW_ATTR } from '@editor/shared';
