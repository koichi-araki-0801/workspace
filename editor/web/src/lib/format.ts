/** Presentation formatters shared across feature view-models. */

/** Localized date-time, or an em dash for empty values. */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('ja-JP');
}
