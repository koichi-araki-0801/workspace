// =============================================================================
// blockKey.ts — DOM 要素の版を跨ぐ整列アンカー(shared の再 export)
// =============================================================================
// 実体は shared の `blockKey.ts`(承認の確定を検査するサーバも同じキーで数える)。web の
// 呼び出し側の import 先を変えないため、ここから同じ名前で出す。
export {
  occurrenceKey,
  occurrenceKeys,
  type RawKeyOf,
  rawKey,
  rawKeyFromParts,
} from '@editor/shared';
