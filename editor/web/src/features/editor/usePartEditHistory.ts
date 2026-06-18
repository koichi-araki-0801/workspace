import type { PartHistoryEntry } from '@editor/shared';
import { computed, reactive } from 'vue';

/**
 * In-session edit history for canvas parts. Records edits the user makes during
 * this session (keyed by canvas component id, newest first) and merges them
 * ahead of any persisted history for display. Kept separate from
 * {@link useTemplateEditor} so the recording/merge logic is unit testable.
 *
 * @param templateId  owning template id (stamped onto each entry)
 * @param currentPartId  getter for the selected canvas component id
 * @param userName  getter for the acting user's display name
 * @param persisted  getter for the persisted history of the current selection
 * @param persist  optional sink that durably stores the change (fire-and-forget);
 *                 the in-session entry shows immediately regardless of its outcome
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

  /** Record an edit-history entry against the current selection (in-session + persisted). */
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

  // Selected part's history = in-session edits first, then any persisted history.
  const displayHistory = computed<PartHistoryEntry[]>(() => {
    const cid = currentPartId();
    const sess = cid ? (sessionHistory[cid] ?? []) : [];
    return [...sess, ...persisted()];
  });

  return { record, displayHistory };
}
