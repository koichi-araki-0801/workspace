// =============================================================================
// usePartEditHistory.ts — canvas part のセッション内編集履歴
// =============================================================================
// 役割: 本セッション中の編集を記録し、永続 history より前に併合して表示する
// composable。記録/併合ロジックを `useTemplateEditor.ts` から分離し単体テスト可能に保つ。

import type { PartHistoryEntry } from '@editor/shared';
import { computed } from 'vue';
import { newId } from '@/lib/newId';

/**
 * canvas part のセッション内編集履歴。本セッション中にユーザーが行った編集を、版を跨いで
 * 安定なパーツ構造キー(`partKey`)をキーに新しい順で記録し、表示時に永続 history より前へ
 * 併合する。記録/併合ロジックを `useTemplateEditor.ts` から分離し単体テスト可能に保つ。
 *
 * @param templateId  所有 template id(各エントリに刻印する)
 * @param currentPartKey  選択中パーツの構造パスキーの getter(解決不能なら undefined)
 * @param userName  操作ユーザーの表示名の getter
 * @param persisted  永続 history の getter。`key` を渡すとそのパーツのみ、未指定なら版インスタンス
 *                   全パーツ分を返す(未選択時の「全パーツ表示」に使う)
 * @param persist  変更を永続化する sink(fire-and-forget)。結果に関わらず
 *                 セッション内エントリは即座に表示される。`id` はセッション内エントリと同じ
 *                 UUID で、永続側に同じ id で残させて表示時の重複除去に使う
 * @param init  外部のセッション履歴 state(`editorSession` ストア由来)。履歴レコードを
 *              そのストアに委ね、編集⇄プレビュー往復で履歴が維持される
 */
export function usePartEditHistory(
  templateId: string,
  currentPartKey: () => string | undefined,
  userName: () => string,
  persisted: (key?: string) => PartHistoryEntry[],
  persist: (partKey: string, change: string, id: string) => void,
  init: { history: Record<string, PartHistoryEntry[]> },
) {
  const sessionHistory = init.history;

  /** 現在の選択に編集履歴エントリを記録する(セッション内 + 永続)。 */
  function record(change: string): void {
    const key = currentPartKey();
    if (!key) return;
    const arr = sessionHistory[key] ?? [];
    sessionHistory[key] = arr;
    const id = newId();
    arr.unshift({
      id,
      templateId,
      partKey: key,
      change,
      timestamp: new Date().toISOString(),
      user: userName(),
    });
    persist(key, change, id);
  }

  // 表示する history。
  // - パーツ選択中: そのパーツの history = セッション内編集を先頭に、続けて永続 history。
  // - 未選択(画面を開いた当初): 全パーツの history を併合し、timestamp 降順で俯瞰表示する。
  //   `persisted(undefined)` は版インスタンス全件、セッション内は全パーツ分を平坦化して足す。
  // セッション内の履歴はストアに残るので、プレビューとの往復で開き直すと、同じ id で永続化
  // された 1 件を読み直した永続側と重なる。どちらの表示もセッション内 → 永続の順に並べてから
  // `dedupeById` に通し、先に出るセッション内の 1 件を残す。
  const displayHistory = computed<PartHistoryEntry[]>(() => {
    const key = currentPartKey();
    if (key) {
      const sess = sessionHistory[key] ?? [];
      return dedupeById([...sess, ...persisted(key)]);
    }
    const allSess = Object.values(sessionHistory).flat();
    return dedupeById([...allSess, ...persisted(undefined)]).sort((a, b) =>
      b.timestamp.localeCompare(a.timestamp),
    );
  });

  return { record, displayHistory };
}

/**
 * 同じ `id` の 2 件目以降を落とす(先に出た方を残す)。id が空の項目は同定できないので
 * 落とさない。
 */
function dedupeById(list: PartHistoryEntry[]): PartHistoryEntry[] {
  const seen = new Set<string>();
  return list.filter((e) => {
    if (!e.id) return true;
    if (seen.has(e.id)) return false;
    seen.add(e.id);
    return true;
  });
}
