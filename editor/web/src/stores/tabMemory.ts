// =============================================================================
// tabMemory.ts — タブごとに「直前に見ていた画面」を覚える Pinia ストア
// =============================================================================
import { defineStore } from 'pinia';
import { reactive } from 'vue';
import { type TabName, type TabRouteLike, tabOf } from '@/features/layout/tabOf';

/**
 * 上部ナビのタブを押したとき、そのタブで直前に見ていた画面(一覧 or 編集中のテンプレート)へ
 * 戻すための記憶。編集画面がタブの下に展開されるため、他タブを見てから「編集」へ戻ったときに
 * 一覧へ落とすと、編集中のテンプレートを探し直すことになる。
 * in-memory のみ — リロード後はルート自体が復元されるので永続化は要らない。
 */
export const useTabMemoryStore = defineStore('tabMemory', () => {
  const paths = reactive<Partial<Record<TabName, string>>>({});

  /** 遷移先を、その属するタブの「直前の画面」として記録する。タブを持たない画面は無視する。 */
  function remember(route: TabRouteLike & { fullPath: string }): void {
    const tab = tabOf(route);
    if (tab) paths[tab] = route.fullPath;
  }

  /** タブの「直前の画面」。記憶が無ければ undefined(呼び手はタブの既定画面へ送る)。 */
  function pathFor(tab: TabName): string | undefined {
    return paths[tab];
  }

  /**
   * 全タブの記憶を捨てる。ログアウト時に呼ぶ — 共有端末で、前の利用者が最後に編集していた
   * テンプレートへ次の利用者がタブ押下だけで飛ばされないようにするため(Undo ミラーを
   * 利用者ごとのキーへ分けたのと同じ理由)。
   */
  function clear(): void {
    for (const key of Object.keys(paths)) delete paths[key as TabName];
  }

  return { paths, remember, pathFor, clear };
});
