import { ref } from 'vue';

/**
 * Snapshot-based undo/redo over an opaque state `T`. The caller supplies how to
 * `capture` the current state and how to `apply` a restored snapshot; this keeps
 * the editor's GrapesJS specifics out of the history logic (and makes it unit
 * testable). Used by {@link useTemplateEditor} because GrapesJS' own UndoManager
 * doesn't reliably track our programmatic style writes.
 *
 * `pushUndo` is a no-op while a snapshot is being applied, so `apply` can rebuild
 * state without spuriously recording a new undo step.
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

  /** Capture the pre-mutation state. Call right before a recordable change. */
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
   * Drop the most recent {@link pushUndo} snapshot. Used when a change was
   * speculatively snapshotted (e.g. text edit / drag start) but turned out to be
   * a no-op, so the empty step shouldn't linger on the undo stack.
   */
  function discardLast(): void {
    past.pop();
    updateFlags();
  }

  return { canUndo, canRedo, pushUndo, undo, redo, discardLast };
}
