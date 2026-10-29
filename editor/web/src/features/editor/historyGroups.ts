// =============================================================================
// historyGroups.ts — 修正履歴を変更の番号ごとの見出しへ束ねる(右ペイン「プロパティ」)
// =============================================================================
// 役割: 履歴(`PartHistoryEntry`)を、番号(`useChangeNumbers.ts` の `ChangeNumbers`)のあるパーツ
// → 番号の無い紙面のパーツ → 紙面に無いキーの順に並べた見出しの列へ直す。Vue にも canvas にも
// 依存しない純粋関数(`Inspector.vue` が描き、`useTemplateEditor.ts` が入力を組む)。

import type { PartHistoryEntry } from '@editor/shared';
import type { ChangeNumbers } from './useChangeNumbers';

/** 却下された変更の理由(Task 13 が値を入れる。ここでは型だけを定める)。 */
export interface RejectedReason {
  /** 却下した人。 */
  by: string;
  /** 却下の日時(ISO 文字列)。 */
  at: string;
  /** 却下の理由。 */
  reason: string;
}

export interface HistoryGroup {
  key: string;
  /** 変更の番号。差分の無いパーツ・紙面に無いキーは null。 */
  no: number | null;
  name: string;
  /** 確定版にあって作業中の版で削除したパーツ。 */
  removed: boolean;
  /** 現在の紙面に無いキーの履歴(削除パーツとも対応しないもの)。 */
  offCanvas: boolean;
  entries: PartHistoryEntry[];
  rejected: RejectedReason | null;
}

const UNKNOWN_NAME = '削除済みパーツ';

export function groupHistoryByPart(input: {
  entries: readonly PartHistoryEntry[];
  numbers: ChangeNumbers;
  /** canvas のパーツのキー(紙面の順)。 */
  partOrder: readonly string[];
  nameOf: (key: string) => string;
  rejected?: ReadonlyMap<string, RejectedReason>;
}): HistoryGroup[] {
  const { entries, numbers, partOrder, nameOf } = input;
  const rejected = input.rejected ?? new Map<string, RejectedReason>();
  const onCanvas = new Set(partOrder);

  const byKey = new Map<string, PartHistoryEntry[]>();
  for (const e of entries) {
    const list = byKey.get(e.partKey);
    if (list) list.push(e);
    else byKey.set(e.partKey, [e]);
  }
  const take = (key: string): PartHistoryEntry[] => byKey.get(key) ?? [];

  const numbered: HistoryGroup[] = [];
  for (const [key, no] of numbers.byKey) {
    numbered.push({
      key,
      no,
      name: nameOf(key),
      removed: false,
      offCanvas: false,
      entries: take(key),
      rejected: rejected.get(key) ?? null,
    });
  }
  // 削除パーツの履歴は確定版側のキーで引く。canvas にも同じキーがあれば canvas 側の履歴なので渡さない
  // (同じ履歴を 2 つの見出しに出さない)。canvas に無く削除パーツとも合わないキーは末尾の「紙面に無い」へ回る。
  const removedKeys = new Set<string>();
  for (const r of numbers.removed) {
    removedKeys.add(r.key);
    numbered.push({
      key: r.key,
      no: r.no,
      name: `${r.name}（削除）`,
      removed: true,
      offCanvas: false,
      entries: onCanvas.has(r.key) ? [] : take(r.key),
      rejected: onCanvas.has(r.key) ? null : (rejected.get(r.key) ?? null),
    });
  }
  numbered.sort((a, b) => (a.no ?? 0) - (b.no ?? 0));

  const plain: HistoryGroup[] = [];
  for (const key of partOrder) {
    if (numbers.byKey.has(key)) continue;
    const list = take(key);
    const rej = rejected.get(key) ?? null;
    if (list.length === 0 && rej === null) continue;
    plain.push({
      key,
      no: null,
      name: nameOf(key),
      removed: false,
      offCanvas: false,
      entries: list,
      rejected: rej,
    });
  }

  const off: HistoryGroup[] = [];
  const offKeys = new Set([...byKey.keys(), ...rejected.keys()]);
  for (const key of offKeys) {
    if (onCanvas.has(key) || removedKeys.has(key)) continue;
    off.push({
      key,
      no: null,
      name: nameOf(key) || UNKNOWN_NAME,
      removed: false,
      offCanvas: true,
      entries: take(key),
      rejected: rejected.get(key) ?? null,
    });
  }

  return [...numbered, ...plain, ...off];
}
