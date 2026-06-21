// =============================================================================
// usePartEditHistory.ts — canvas part のセッション内編集履歴
// =============================================================================
// 役割: 本セッション中の編集を記録し、永続 history より前に併合して表示する
// composable。記録/併合ロジックを `useTemplateEditor.ts` から分離し単体テスト可能に保つ。

import type { PartHistoryEntry } from '@editor/shared';
import { computed, reactive } from 'vue';

/**
 * canvas part のセッション内編集履歴。本セッション中にユーザーが行った編集を
 * canvas component id をキーに新しい順で記録し、表示時に永続 history より前へ併合する。
 * 記録/併合ロジックを `useTemplateEditor.ts` から分離し単体テスト可能に保つ。
 *
 * @param templateId  所有 template id(各エントリに刻印する)
 * @param currentPartId  選択中の canvas component id の getter
 * @param userName  操作ユーザーの表示名の getter
 * @param persisted  現在の選択の永続 history の getter
 * @param persist  変更を永続化する任意の sink(fire-and-forget)。結果に関わらず
 *                 セッション内エントリは即座に表示される
 */
export function usePartEditHistory(
  templateId: string,
  currentPartId: () => string | undefined,
  userName: () => string,
  persisted: () => PartHistoryEntry[],
  persist?: (partId: string, change: string) => void,
) {
  const sessionHistory = reactive<Record<string, PartHistoryEntry[]>>({});
  let seq = 0;

  /** 現在の選択に編集履歴エントリを記録する(セッション内 + 永続)。 */
  function record(change: string): void {
    const cid = currentPartId();
    if (!cid) return;
    const arr = sessionHistory[cid] ?? [];
    sessionHistory[cid] = arr;
    arr.unshift({
      id: `s${++seq}`,
      templateId,
      partId: cid,
      change,
      timestamp: new Date().toISOString(),
      user: userName(),
    });
    persist?.(cid, change);
  }

  // 選択 part の history = セッション内編集を先頭に、続けて永続 history。
  const displayHistory = computed<PartHistoryEntry[]>(() => {
    const cid = currentPartId();
    const sess = cid ? (sessionHistory[cid] ?? []) : [];
    return [...sess, ...persisted()];
  });

  return { record, displayHistory };
}
