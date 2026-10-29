// =============================================================================
// reviewDecisionState.ts — 承認タブの手元の判定状態(純関数)
// =============================================================================
// 判定は番号つきの変更パーツ(`ChangedPart`)と保存済みの判定(`ReviewPartDecision`)から読む。
// 保存済みの `pending`(取り消し)と判定の無いパーツは、どちらも「未判定」と読む。
import type { ChangedPart, PaperDecision, ReviewPartDecision } from '@editor/shared';

export interface DecisionCounts {
  total: number;
  approved: number;
  rejected: number;
  pending: number;
}

/** パーツの現在の判定。登録が無ければ `pending`。 */
export function decisionOf(
  decisions: readonly ReviewPartDecision[],
  partKey: string,
): PaperDecision {
  return decisions.find((d) => d.partKey === partKey)?.status ?? 'pending';
}

export function decisionCounts(
  changes: readonly ChangedPart[],
  decisions: readonly ReviewPartDecision[],
): DecisionCounts {
  let approved = 0;
  let rejected = 0;
  for (const c of changes) {
    const d = decisionOf(decisions, c.partKey);
    if (d === 'approved') approved++;
    else if (d === 'rejected') rejected++;
  }
  return {
    total: changes.length,
    approved,
    rejected,
    pending: changes.length - approved - rejected,
  };
}

/** `afterNo` の次の未判定の番号。無ければ先頭から探す。未判定が無ければ null。 */
export function nextPendingNo(
  changes: readonly ChangedPart[],
  decisions: readonly ReviewPartDecision[],
  afterNo: number | null,
): number | null {
  const pending = changes
    .filter((c) => decisionOf(decisions, c.partKey) === 'pending')
    .map((c) => c.no)
    .sort((a, b) => a - b);
  if (pending.length === 0) return null;
  if (afterNo === null) return pending[0];
  return pending.find((no) => no > afterNo) ?? pending[0];
}

/** 保存の応答で手元の判定を差し替える。同じ `partKey` は置き換え、無いものは足す。 */
export function mergeSavedDecisions(
  current: readonly ReviewPartDecision[],
  saved: readonly ReviewPartDecision[],
): ReviewPartDecision[] {
  const savedByKey = new Map(saved.map((d) => [d.partKey, d]));
  const merged = current.map((d) => savedByKey.get(d.partKey) ?? d);
  const known = new Set(current.map((d) => d.partKey));
  for (const d of saved) {
    if (!known.has(d.partKey)) {
      merged.push(d);
      known.add(d.partKey);
    }
  }
  return merged;
}

/** 却下のパーツキーを並べた文字列。承認の増減では変わらず、右面を組み直す合図になる。 */
export function rejectedSignature(decisions: readonly ReviewPartDecision[]): string {
  return decisions
    .filter((d) => d.status === 'rejected')
    .map((d) => d.partKey)
    .sort()
    .join('\n');
}

export function finalizeHint(c: DecisionCounts): string {
  if (c.pending > 0) return `未判定が ${c.pending} 件あります。すべて判定すると押せます`;
  return `承認 ${c.approved} 件を反映し、却下 ${c.rejected} 件は現行版のまま残します`;
}

/**
 * サーバの文言に並ぶパーツのキー(`<アンカー>#<通し番号>`。利用者に読めない)を、右欄の番号と
 * パーツ名(`変更 N「名前」`)へ読み替える。右欄に無いキー(どの行にも当たらない)はそのまま残す。
 * 判定の保存・最終確定の 400・409 の文言(shared の `partKeysText` が並べる)に使う。
 */
export function describePartKeys(
  message: string,
  changes: readonly (ChangedPart & { name: string })[],
): string {
  const byKey = new Map(changes.map((c) => [c.partKey, c]));
  return message.replace(/[^\s,、。:：「」]+#\d+/g, (key) => {
    const c = byKey.get(key);
    return c ? `変更 ${c.no}「${c.name}」` : key;
  });
}
