// =============================================================================
// redlineAttr.ts — 赤入れの削除要素に付ける属性の名前(shared の再 export)
// =============================================================================
// 赤入れの装飾(`features/editor/redline/redlineApply.ts`)と、それを数えずに飛ばす判定
// (shared の `pageSplit.ts` の `pageItems` など)の両方が読む。名前の実体は判定と同じ
// `pageSplit.ts` にあり、web の import 先を変えないためここから出す。
export { REDLINE_ATTR } from '@editor/shared';
