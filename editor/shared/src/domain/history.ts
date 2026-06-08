/**
 * History filtering — pure domain rules shared by the history screen (and
 * reusable on the server). No Vue, no I/O.
 */

/** Per-tab history filter values. */
export interface HistoryFilter {
  user?: string;
  keyword?: string;
  from?: string;
  to?: string;
}

export function uniq(values: string[]): string[] {
  return [...new Set(values)];
}

/**
 * True if `entry` passes `filter`. `haystacks` are the entry's searchable text
 * (matched case-insensitively against the keyword).
 */
export function matchFilter(
  entry: { user: string; timestamp: string },
  filter: HistoryFilter,
  haystacks: string[],
): boolean {
  if (filter.user && entry.user !== filter.user) return false;

  const ts = new Date(entry.timestamp).getTime();
  if (filter.from && ts < new Date(`${filter.from}T00:00:00`).getTime()) return false;
  if (filter.to && ts > new Date(`${filter.to}T23:59:59.999`).getTime()) return false;

  if (filter.keyword) {
    const kw = filter.keyword.toLowerCase();
    if (!haystacks.some((h) => h.toLowerCase().includes(kw))) return false;
  }
  return true;
}
