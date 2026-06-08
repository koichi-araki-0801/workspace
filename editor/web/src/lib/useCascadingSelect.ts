import { isErr, ok, type Result } from '@editor/shared';
import { onMounted, type Ref, reactive, ref } from 'vue';
import { useAsyncResult } from '@/lib/useAsyncResult';

interface CascadingConfig<Q extends object, O, L> {
  /** Level keys in dependency order (upper → lower). */
  levels: Array<keyof Q & string>;
  /** Initial/empty options object. */
  emptyOptions: O;
  /** Fetch the candidate options for the current query. */
  fetchOptions: (query: Q) => Promise<Result<O>>;
  /** Optional secondary fetch (e.g. the filtered list) run alongside options. */
  fetchList?: (query: Q) => Promise<Result<L[]>>;
  /** Called after every selection change / reset, with a snapshot of the query. */
  onChange?: (query: Q) => void;
  /** Refresh on mount (default true). */
  immediate?: boolean;
}

/**
 * Shared cascading-dropdown behavior: holds the query/options/list, clears
 * lower levels when an upper one changes (index-driven), and refetches — with
 * unified loading + error handling. Used by template search and the parts
 * catalog, which previously hand-rolled this twice.
 */
export function useCascadingSelect<Q extends object, O, L = unknown>(
  config: CascadingConfig<Q, O, L>,
) {
  const { run, loading } = useAsyncResult();
  const query = reactive({}) as Q;
  const options = ref(config.emptyOptions) as Ref<O>;
  const list = ref([]) as Ref<L[]>;

  async function refresh(): Promise<void> {
    await run(async () => {
      const optRes = await config.fetchOptions({ ...query });
      if (isErr(optRes)) return optRes;
      options.value = optRes.value;
      if (config.fetchList) {
        const listRes = await config.fetchList({ ...query });
        if (isErr(listRes)) return listRes;
        list.value = listRes.value;
      }
      return ok(undefined);
    });
  }

  /** Selecting a level clears every lower level, then refetches. */
  function onLevelChange(key: keyof Q & string): void {
    const idx = config.levels.indexOf(key);
    for (const lower of config.levels.slice(idx + 1)) {
      query[lower] = undefined as Q[typeof lower];
    }
    config.onChange?.({ ...query });
    void refresh();
  }

  function reset(): void {
    for (const key of config.levels) query[key] = undefined as Q[typeof key];
    config.onChange?.({ ...query });
    void refresh();
  }

  if (config.immediate ?? true) onMounted(refresh);

  return { query, options, list, loading, onLevelChange, reset, refresh };
}
