// =============================================================================
// history.ts — 履歴フィルタリング (履歴画面が使う純粋なドメインルール)
// =============================================================================
// サーバ側でも再利用できるよう Vue にも I/O にも依存しない。

// ── git オブジェクトID の形 ──
// 履歴 API の `historyId` は git のコミット hash そのもので、server では `git show` の
// リビジョン引数になる。`-` で始まる値は git がオプションとして解釈するため
// (`--output=<file>` でリポジトリ外のファイルを作成/切り詰められる)、git へ渡す前に
// この形で弾く。短縮 hash も外部連携や手入力で来うるので 7 桁から許す。
const GIT_OBJECT_ID_RE = /^[0-9a-f]{7,40}$/;

/** `value` が git のオブジェクトID(小文字 16 進 7〜40 桁)の形か。 */
export function isGitObjectId(value: string): boolean {
  return GIT_OBJECT_ID_RE.test(value);
}

/**
 * 編集履歴 1 行の id。確定コミットは `git add -A` で作るため 1 コミットが複数テンプレを
 * 含みうる。コミット hash をそのまま行 id にすると同じコミットの行が同じキーになり、
 * 一覧の `:key` が衝突する。コミットを指す値は `historyId` が持ち、行 id は
 * `<historyId>:<templateId>` で一意にする。server(git 由来)と web の local 実装が同じ
 * 綴りを使うよう、組み立てはここ 1 箇所に置く。
 */
export function editHistoryRowId(historyId: string, templateId: string): string {
  return `${historyId}:${templateId}`;
}

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
