// =============================================================================
// history.ts — 履歴フィルタリング (履歴画面が使う純粋なドメインルール)
// =============================================================================
// サーバ側でも再利用できるよう Vue にも I/O にも依存しない。

/** タブ別の履歴フィルタ値。 */
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
 * `entry` が `filter` を通過するとき true。`haystacks` はエントリの検索対象テキスト
 * (キーワードと大文字小文字を無視して照合する)。
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
