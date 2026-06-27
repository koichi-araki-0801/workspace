// =============================================================================
// usePartEditHistory.ts — canvas part のセッション内編集履歴
// =============================================================================
// 役割: 本セッション中の編集を記録し、永続 history より前に併合して表示する
// composable。記録/併合ロジックを `useTemplateEditor.ts` から分離し単体テスト可能に保つ。

import type { PartHistoryEntry } from '@editor/shared';
import { computed, reactive } from 'vue';

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
 * @param persist  変更を永続化する任意の sink(fire-and-forget)。結果に関わらず
 *                 セッション内エントリは即座に表示される
 * @param init  外部のセッション履歴 state(`editorSession` ストア由来)。渡すと履歴レコードと
 *              採番をそのストアに委ね、編集⇄プレビュー往復で履歴が維持される。未指定なら
 *              ローカル reactive で開始する(後方互換 / 単体テスト用)
 */
export function usePartEditHistory(
  templateId: string,
  currentPartKey: () => string | undefined,
  userName: () => string,
  persisted: (key?: string) => PartHistoryEntry[],
  persist?: (partKey: string, change: string) => void,
  init?: { history: Record<string, PartHistoryEntry[]>; nextSeq: () => number },
) {
  const sessionHistory = init?.history ?? reactive<Record<string, PartHistoryEntry[]>>({});
  let localSeq = 0;
  const nextSeq = init?.nextSeq ?? (() => ++localSeq);

  /** 現在の選択に編集履歴エントリを記録する(セッション内 + 永続)。 */
  function record(change: string): void {
    const key = currentPartKey();
    if (!key) return;
    const arr = sessionHistory[key] ?? [];
    sessionHistory[key] = arr;
    arr.unshift({
      id: `s${nextSeq()}`,
      templateId,
      partKey: key,
      change,
      timestamp: new Date().toISOString(),
      user: userName(),
    });
    persist?.(key, change);
  }

  // 表示する history。
  // - パーツ選択中: そのパーツの history = セッション内編集を先頭に、続けて永続 history。
  // - 未選択(画面を開いた当初): 全パーツの history を併合し、timestamp 降順で俯瞰表示する。
  //   `persisted(undefined)` は版インスタンス全件、セッション内は全パーツ分を平坦化して足す
  //   (`allPartHistory` はセッション中に再読込しないため両者の重複は出ない)。
  const displayHistory = computed<PartHistoryEntry[]>(() => {
    const key = currentPartKey();
    if (key) {
      const sess = sessionHistory[key] ?? [];
      return [...sess, ...persisted(key)];
    }
    const allSess = Object.values(sessionHistory).flat();
    return [...allSess, ...persisted(undefined)].sort((a, b) =>
      b.timestamp.localeCompare(a.timestamp),
    );
  });

  return { record, displayHistory };
}
