// =============================================================================
// useSnapshotHistory.ts — snapshot 方式の undo/redo composable
// =============================================================================
// 役割: 不透明な state `T` の snapshot を積んで undo/redo を提供する。GrapesJS の
// 詳細を history ロジックから切り離し、`useTemplateEditor.ts` から利用される。

import { ref } from 'vue';

/**
 * 不透明な state `T` に対する snapshot 方式の undo/redo。呼び出し側が現在 state の
 * `capture` 方法と、復元した snapshot の `apply` 方法を渡す。これにより editor の
 * GrapesJS 固有部分を history ロジックから切り離す(かつ単体テスト可能にする)。
 * GrapesJS 自前の UndoManager はプログラム経由の style 書き込みを確実には追えないため、
 * `useTemplateEditor.ts` がこれを使う。
 *
 * snapshot 適用中は `pushUndo` を no-op にするので、`apply` が新たな undo ステップを
 * 誤って記録せずに state を再構築できる。
 */
export function useSnapshotHistory<T>(capture: () => T, apply: (snap: T) => void, max = 100) {
  const past: T[] = [];
  const future: T[] = [];
  const canUndo = ref(false);
  const canRedo = ref(false);
  let applying = false;

  function updateFlags(): void {
    canUndo.value = past.length > 0;
    canRedo.value = future.length > 0;
  }

  /** 変更前の state を capture する。記録対象の変更の直前に呼ぶ。 */
  function pushUndo(): void {
    if (applying) return;
    past.push(capture());
    if (past.length > max) past.shift();
    future.length = 0;
    updateFlags();
  }

  function applySnap(snap: T): void {
    applying = true;
    try {
      apply(snap);
    } finally {
      applying = false;
    }
    updateFlags();
  }

  function undo(): void {
    if (!past.length) return;
    future.push(capture());
    applySnap(past.pop() as T);
  }

  function redo(): void {
    if (!future.length) return;
    past.push(capture());
    applySnap(future.shift() as T);
  }

  /**
   * 直近の `pushUndo` snapshot を捨てる。変更を見込んで snapshot を取った(例: text
   * 編集 / drag 開始)が結果的に no-op だった場合に使い、空のステップを undo stack に
   * 残さないようにする。
   */
  function discardLast(): void {
    past.pop();
    updateFlags();
  }

  return { canUndo, canRedo, pushUndo, undo, redo, discardLast };
}
