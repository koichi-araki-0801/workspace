// =============================================================================
// useFundNames.ts — fundCode → ファンド名の共有リゾルバ
// =============================================================================
import { isErr } from '@editor/shared';
import { reactive } from 'vue';
import { useTemplateRepo } from '@/api/repositories';

/**
 * ファンドコード → ファンド名の共有リゾルバ。
 *
 * 名前は `getSampleData(fundCode)` の `fund.name` から解決する。fundCode 単位の
 * 取得なので、モジュールレベルでキャッシュして複数行・複数画面での重複 fetch を防ぐ。
 * 名前は best-effort: 失敗・未収録なら空文字をキャッシュし、表示は壊さない。
 */

/** code → name（未収録は ''）。reactive なので解決完了で参照側が再描画される。 */
const cache = reactive(new Map<string, string>());
/** 取得中のコード（多重 fetch 防止）。 */
const inflight = new Set<string>();

export function useFundNames() {
  const repo = useTemplateRepo();

  /** 未解決のコードだけ非同期で取得し、キャッシュへ格納する。 */
  function resolve(codes: Iterable<string>): void {
    for (const code of codes) {
      if (!code || cache.has(code) || inflight.has(code)) continue;
      inflight.add(code);
      void repo
        .getSampleData(code)
        .then((res) => {
          const name =
            !isErr(res) && res.value
              ? ((res.value.fund as { name?: string } | undefined)?.name ?? '')
              : '';
          cache.set(code, name);
        })
        .catch(() => cache.set(code, ''))
        .finally(() => inflight.delete(code));
    }
  }

  /** キャッシュ済みのファンド名（未解決なら ''）。 */
  function nameOf(code: string): string {
    return cache.get(code) ?? '';
  }

  return { resolve, nameOf };
}
