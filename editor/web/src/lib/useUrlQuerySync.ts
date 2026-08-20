// =============================================================================
// useUrlQuerySync.ts — 絞り込み query を URL クエリへ双方向同期する
// =============================================================================
import { type Ref, watch } from 'vue';
import { type LocationQuery, type Router, useRoute, useRouter } from 'vue-router';
import { firstQueryString } from '@/lib/routeQuery';

/** query 本体とは別に同期したいスカラ(例: 一覧の自由文検索テキスト)。 */
interface ExtraScalar {
  /** URL 上のキー(prefix は別途付与される)。 */
  key: string;
  ref: Ref<string>;
}

interface QuerySyncConfig<Q extends object> {
  /** 同期する query キー(= cascade の levels/fields)。 */
  keys: Array<keyof Q & string>;
  /** 名前空間。比較 A/B のように同一ルートへ複数同期するときの衝突回避(例 'a'/'b')。 */
  prefix?: string;
  /** query 本体に無いスカラ ref を併せて同期する。 */
  extra?: ExtraScalar[];
}

/** patch を畳み込む先(router ごと)。値 undefined はキー削除を表す。 */
type QueryPatch = Record<string, string | undefined>;
const pending = new WeakMap<Router, { patch: QueryPatch; scheduled: boolean }>();

/**
 * router ごとに patch を1つへ畳み込み, microtask で `router.replace` を1回に集約する。
 * 比較 A/B など同一ページの複数同期インスタンスが同 tick で書いても, 直前に
 * `currentRoute` を読んでマージするため互いの prefix キーを上書きしない。
 */
function scheduleWrite(router: Router, patch: QueryPatch): void {
  let entry = pending.get(router);
  if (!entry) {
    entry = { patch: {}, scheduled: false };
    pending.set(router, entry);
  }
  Object.assign(entry.patch, patch);
  if (entry.scheduled) return;
  entry.scheduled = true;
  queueMicrotask(() => {
    const e = pending.get(router);
    if (!e) return;
    pending.delete(router);
    const merged: LocationQuery = { ...router.currentRoute.value.query };
    for (const [k, v] of Object.entries(e.patch)) {
      if (v == null || v === '') delete merged[k];
      else merged[k] = v;
    }
    // replace なのでフィルタ操作で戻る履歴を増やさない。冗長遷移の reject は無視。
    void router.replace({ query: merged }).catch(() => {});
  });
}

/**
 * `useCascadingSelect` の `reactive` query を URL クエリへ双方向同期し, 戻る/進む/リロードで
 * 絞り込みを復元する。setup で同期的に hydrate する(=`onMounted(refresh)` より前に効くため,
 * 復元済み query で options を取得できる)。戻り値 `hydrated` で「URL から1つでも復元したか」を
 * 親へ伝え, 一覧の再取得トリガに使う。
 */
export function useUrlQuerySync<Q extends object>(
  query: Q,
  config: QuerySyncConfig<Q>,
): { hydrated: boolean } {
  const route = useRoute();
  const router = useRouter();
  const prefix = config.prefix ? `${config.prefix}_` : '';
  const bag = query as Record<string, unknown>;

  // ── hydrate(setup 同期) — URL の prefix キーを query/extra へ流し込む ──
  let hydrated = false;
  for (const key of config.keys) {
    const raw = firstQueryString(route.query[prefix + key]);
    if (raw != null) {
      bag[key] = raw;
      hydrated = true;
    }
  }
  for (const e of config.extra ?? []) {
    const raw = firstQueryString(route.query[prefix + e.key]);
    if (raw != null) {
      e.ref.value = raw;
      hydrated = true;
    }
  }

  // ── persist — query/extra の変化を URL へ(空/undefined はキー削除) ──
  function write(): void {
    const patch: QueryPatch = {};
    for (const key of config.keys) {
      const v = bag[key];
      patch[prefix + key] = v == null || v === '' ? undefined : String(v);
    }
    for (const e of config.extra ?? []) {
      patch[prefix + e.key] = e.ref.value || undefined;
    }
    scheduleWrite(router, patch);
  }

  watch([() => config.keys.map((k) => bag[k]), ...(config.extra ?? []).map((e) => e.ref)], write, {
    deep: true,
  });

  return { hydrated };
}
