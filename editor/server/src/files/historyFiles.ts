// =============================================================================
// historyFiles.ts — PDF出力/作成/パーツ変更の履歴(ファイル監査ログ)
// =============================================================================
// 版/スナップ/編集履歴は git(コミット履歴)が正典。一方 PDF出力・作成・パーツ変更は
// DB(旧 SP.history)を廃し、`logs/history/<種別>.jsonl` の追記専用ログへ寄せる
// (監査ログがファイル正典である方針と同じ)。1 行 1 イベントの JSON Lines。

import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';

/** ファイル監査ログに記録する履歴の種別。 */
type HistoryKind = 'pdf' | 'create' | 'part';

const historyDir = (): string => path.join(config.logging.dir, 'history');
const fileFor = (kind: HistoryKind): string => path.join(historyDir(), `${kind}.jsonl`);

/** 1 イベントを追記する(ディレクトリは必要に応じて作成)。 */
export async function appendHistory(kind: HistoryKind, entry: unknown): Promise<void> {
  await fs.mkdir(historyDir(), { recursive: true });
  await fs.appendFile(fileFor(kind), `${JSON.stringify(entry)}\n`, 'utf8');
}

/** 種別のイベントを新しい順(末尾が最新)で返す。ファイルが無ければ空配列。 */
export async function readHistory<T>(kind: HistoryKind): Promise<T[]> {
  const raw = await fs.readFile(fileFor(kind), 'utf8').catch(() => '');
  return raw
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as T)
    .reverse();
}
