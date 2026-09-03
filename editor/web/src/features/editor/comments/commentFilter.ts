// =============================================================================
// commentFilter.ts — コメント一覧のスレッド化・絞り込み・並び(純関数)
// =============================================================================
// 役割: `PartNoteEntry` の平坦な配列を「親投稿 + 返信」のスレッドへ組み、右ペインの
// 一覧が持つ検索・絞り込み・並びの規則をここに閉じる。DOM や store に依存しないので
// 単体テストで規則を固定できる。表示コンポーネント(`CommentPanel.vue`)は結果を描くだけ。
import type { NoteKind, PartNoteEntry } from '@editor/shared';

/** 親投稿 1 件とその返信。`lastAt` は親・返信の作成/編集日時の最大値(更新順の並びに使う)。 */
export interface CommentThread {
  parent: PartNoteEntry;
  replies: PartNoteEntry[];
  lastAt: string;
}

export type CommentStatusFilter = 'all' | 'open' | 'resolved';
export type CommentSort = 'updated' | 'part';

export interface CommentFilter {
  /** 本文・投稿者の部分一致。空文字は無条件。 */
  query: string;
  status: CommentStatusFilter;
  /** 空集合は無条件。 */
  kinds: ReadonlySet<NoteKind>;
  /** null は無条件。 */
  author: string | null;
  /** true なら選択中のパーツのスレッドだけ。 */
  onlySelected: boolean;
  sort: CommentSort;
}

/** 既定は「未対応を更新順」— レビューで次に見るべきものが上に来る形。 */
export const DEFAULT_COMMENT_FILTER: CommentFilter = {
  query: '',
  status: 'open',
  kinds: new Set<NoteKind>(),
  author: null,
  onlySelected: false,
  sort: 'updated',
};

export const KIND_LABEL: Record<NoteKind, string> = {
  note: 'メモ',
  'fix-request': '修正依頼',
  question: '質問',
};

function activityAt(e: PartNoteEntry): string {
  return e.updatedAt && e.updatedAt > e.createdAt ? e.updatedAt : e.createdAt;
}

/**
 * 平坦な投稿列をスレッドへ組む。親の無い返信は捨てる — サーバは親の削除で返信も消すので
 * 通常は起きないが、並行操作の狭間で届いた場合に一覧のどこにも置けない。
 */
export function threadsOf(entries: readonly PartNoteEntry[]): CommentThread[] {
  const byParent = new Map<string, CommentThread>();
  const parents = entries
    .filter((e) => e.replyTo === null)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const p of parents) byParent.set(p.id, { parent: p, replies: [], lastAt: activityAt(p) });
  const replies = entries
    .filter((e) => e.replyTo !== null)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const r of replies) {
    const t = byParent.get(r.replyTo as string);
    if (!t) continue;
    t.replies.push(r);
    const at = activityAt(r);
    if (at > t.lastAt) t.lastAt = at;
  }
  return [...byParent.values()];
}

/** 投稿者の一覧(重複除去・出現順)。絞り込みの選択肢に使う。 */
export function authorsOf(entries: readonly PartNoteEntry[]): string[] {
  return [...new Set(entries.map((e) => e.createdBy))];
}

/** 未対応の親投稿を持つ `pathKey` の集合(マーカーの色分けに使う。返信の状態は見ない)。 */
export function openKeysOf(entries: readonly PartNoteEntry[]): Set<string> {
  return new Set(
    entries.filter((e) => e.replyTo === null && e.status === 'open').map((e) => e.pathKey),
  );
}

/** 未対応の**親投稿**の件数(タブバッジに使う。返信・パーツ数は数えない)。 */
export function openThreadCount(entries: readonly PartNoteEntry[]): number {
  return entries.filter((e) => e.replyTo === null && e.status === 'open').length;
}

/** 表示用の日時(年は省く。同一基準日のスレッドなので月日と時刻で足りる)。 */
export function formatCommentAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${mm}/${dd} ${hh}:${mi}`;
}

function matchesQuery(t: CommentThread, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === '') return true;
  const all = [t.parent, ...t.replies];
  return all.some(
    (e) => e.content.toLowerCase().includes(q) || e.createdBy.toLowerCase().includes(q),
  );
}

/**
 * 絞り込みと並び。状態・種別・投稿者は**親投稿**で判定する(スレッド 1 本が 1 つの状態・
 * 種別を持つ形)。検索だけは返信の本文も見る(返信に書かれた語で探せないと一覧の意味が薄い)。
 * パーツ順は `partOrder`(canvas の出現順)に従い、無いキーは末尾へ回す。
 */
export function filterThreads(
  threads: readonly CommentThread[],
  filter: CommentFilter,
  ctx: { selectedKey: string | null; partOrder: ReadonlyMap<string, number> },
): CommentThread[] {
  const out = threads.filter((t) => {
    const p = t.parent;
    if (filter.status !== 'all' && p.status !== filter.status) return false;
    if (filter.kinds.size > 0 && !filter.kinds.has(p.kind)) return false;
    if (filter.author !== null && p.createdBy !== filter.author) return false;
    if (filter.onlySelected && p.pathKey !== ctx.selectedKey) return false;
    return matchesQuery(t, filter.query);
  });
  if (filter.sort === 'updated') return out.sort((a, b) => b.lastAt.localeCompare(a.lastAt));
  const order = (t: CommentThread) =>
    ctx.partOrder.get(t.parent.pathKey) ?? Number.MAX_SAFE_INTEGER;
  return out.sort(
    (a, b) => order(a) - order(b) || a.parent.createdAt.localeCompare(b.parent.createdAt),
  );
}
