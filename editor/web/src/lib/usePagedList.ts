// =============================================================================
// usePagedList.ts — 長いリストを段階表示する("load more")
// =============================================================================
import { computed, type Ref, reactive, ref, watch } from 'vue';

/**
 * 長いリストを一度に全描画せず段階的に表示する("load more")。`source` が変わる
 * (例: フィルタ適用)たびに可視 window を reset するため, ユーザーは常に新しい
 * 結果セットの先頭から始められる。
 */
export function usePagedList<T>(source: Ref<readonly T[]>, pageSize = 50) {
  const limit = ref(pageSize);
  watch(source, () => {
    limit.value = pageSize;
  });
  return reactive({
    visible: computed(() => source.value.slice(0, limit.value)),
    hasMore: computed(() => source.value.length > limit.value),
    remaining: computed(() => Math.max(0, source.value.length - limit.value)),
    loadMore: () => {
      limit.value += pageSize;
    },
  });
}
