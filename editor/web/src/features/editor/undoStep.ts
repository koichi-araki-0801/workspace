// =============================================================================
// undoStep.ts — Undo を 1 手として包む
// =============================================================================
// 「開始時の snapshot を保留 → 変化があれば確定、無ければ捨てる」の手順を 1 本にする。無変更で
// 積むと `future`(Redo)が消え、修正履歴に実際には無い変更が残るため、変化の有無で分岐する。

/** `useSnapshotHistory.ts` が返す、保留・確定・破棄の 3 操作。 */
interface UndoHistory {
  beginUndo(): void;
  cancelUndo(): void;
  commitUndo(): void;
}

/**
 * `op` を 1 手として包む。`op` が false(何も変えなかった)を返したら Undo を積まない。積んだら
 * true を返す。`op` が投げたときは保留を取り消して投げ直す(保留を残すと次の操作の開始時
 * snapshot と取り違える)。
 */
export function undoable(h: UndoHistory, op: () => boolean): boolean {
  h.beginUndo();
  let changed: boolean;
  try {
    changed = op();
  } catch (e) {
    h.cancelUndo();
    throw e;
  }
  if (changed) h.commitUndo();
  else h.cancelUndo();
  return changed;
}
