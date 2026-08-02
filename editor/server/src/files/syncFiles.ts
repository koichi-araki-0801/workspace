// =============================================================================
// syncFiles.ts — ペア同期の実行状態 `sync/<pairKey>.json` (ディスク I/O)
// =============================================================================
// 交付版⇄全体版 パーツ自動同期の lastSynced/競合記録を dataRoot 配下に持つ。ポリシー
// (同期既定)は DB のパーツカタログ列が正典で、ここは「どこまで同期したか」という
// ファイル実体に従属する実行状態のみ。テンプレ本体と同じ git リポジトリに置き、同じ
// コミットへ入れて履歴の軸を揃える(drafts/reviews と違い .gitignore しない)。

import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { config } from '../config.js';
import { emptySyncState, type PairSyncState } from '../sync/partSync.js';
import { atomicWrite } from './atomic.js';

const syncPath = (pairKey: string): string => path.join(config.syncDir, `${pairKey}.json`);

// 手編集や破損で形式が崩れた状態ファイルを黙って空扱いすると、全パーツが「初期差分」へ
// 退行して競合の山になる。壊れていたら parse 失敗を throw し、呼び出し側(pairSyncService)
// が「同期スキップ + 警告」に倒す。
const PairPartStateSchema = z.object({
  lastSynced: z.string().optional(),
  conflict: z.object({ kind: z.enum(['初期差分', '両側変更']), detectedAt: z.string() }).optional(),
});
const PairSyncStateSchema = z.object({
  pairKey: z.string(),
  parts: z.record(z.string(), PairPartStateSchema),
  updatedAt: z.string(),
});

/** 状態ファイルを読む。未作成なら空状態(全パーツ「一致履歴なし」)から始める。 */
export async function readSyncState(pairKey: string): Promise<PairSyncState> {
  const raw = await fs.readFile(syncPath(pairKey), 'utf8').catch(() => null);
  if (raw === null) return emptySyncState(pairKey);
  return PairSyncStateSchema.parse(JSON.parse(raw));
}

export async function writeSyncState(state: PairSyncState): Promise<void> {
  await fs.mkdir(config.syncDir, { recursive: true });
  await atomicWrite(syncPath(state.pairKey), `${JSON.stringify(state, null, 2)}\n`);
}
