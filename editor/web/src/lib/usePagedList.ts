import { computed, type Ref, reactive, ref, watch } from 'vue';

/**
 * Incrementally reveal a long list ("load more") instead of rendering it all at
 * once. The visible window resets whenever the source changes (e.g. a filter is
 * applied), so the user always starts from the top of the new result set.
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
