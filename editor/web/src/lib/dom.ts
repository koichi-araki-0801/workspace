// =============================================================================
// dom.ts — DOM イベントまわりの小さな判定
// =============================================================================

/** `input` / `textarea` / `select` / contenteditable へフォーカス中か(キーを横取りしない)。 */
export function isEditableTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  const tag = t.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable;
}
