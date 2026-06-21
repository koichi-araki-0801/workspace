// =============================================================================
// useCascadingSelect.ts — 連動ドロップダウンの共通ふるまい
// =============================================================================
import { isErr, ok, type Result } from '@editor/shared';
import { onMounted, type Ref, reactive, ref } from 'vue';
import { useAsyncResult } from '@/lib/useAsyncResult';

interface CascadingConfig<Q extends object, O, L> {
  /** 依存順(upper → lower)の level キー。 */
  levels: Array<keyof Q & string>;
  /** 初期/空の options オブジェクト。 */
  emptyOptions: O;
  /** 現在の query に対する候補 options を fetch する。 */
  fetchOptions: (query: Q) => Promise<Result<O>>;
  /** options と並行して走らせる任意の二次 fetch(例: 絞り込み済みリスト)。 */
  fetchList?: (query: Q) => Promise<Result<L[]>>;
  /** 選択変更 / reset のたびに, query のスナップショットとともに呼ばれる。 */
  onChange?: (query: Q) => void;
  /** mount 時に refresh する(既定 true)。 */
  immediate?: boolean;
}

/**
 * 連動ドロップダウンの共通ふるまい: query/options/list を保持し, upper level が
 * 変わると(index 駆動で)下位 level を clear し, 再 fetch する — 統一された
 * loading + error 処理付き。テンプレート検索と parts catalog が利用する(以前は
 * 各々で二度 hand-roll していた)。
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

  /** ある level を選ぶと, それより下位の全 level を clear して再 fetch する。 */
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
