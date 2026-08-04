// =============================================================================
// historyFiles.ts — PDF出力/作成/パーツ変更の履歴(ファイル監査ログ)
// =============================================================================
// 版/スナップ/編集履歴は git(コミット履歴)が正典。一方 PDF出力・作成・パーツ変更は
// DB(旧 SP.history)を廃し、`logs/history/<種別>.jsonl` の追記専用ログへ寄せる
// (監査ログがファイル正典である方針と同じ)。1 行 1 イベントの JSON Lines。
//
// 資源上限の方針(分類 B: degrade。例外にしない):
// - 追記側は世代ローテーションで 1 ファイルの上限を保つ。無制限に太ると読み側が
//   ファイル全体を 1 文字列にできなくなり、履歴が「消えたように見える」状態になる。
// - 読み側は**末尾だけ**を読む。全体読み + `split` + `JSON.parse` は入力サイズに比例した
//   停止時間になり、しかも壊れた 1 行でフィード全体が恒久 500 になっていた。
//   行単位の parse 失敗はスキップする(1 行の破損で監査画面を落とさない)。

import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';

/** ファイル監査ログに記録する履歴の種別。 */
type HistoryKind = 'pdf' | 'create' | 'part';

/** 1 ファイルの上限。超えたら世代を繰り上げる。 */
export const MAX_HISTORY_BYTES = 32 * 1024 * 1024;
/** 保持する旧世代の数(`<kind>.1.jsonl` … `<kind>.N.jsonl`)。 */
export const MAX_HISTORY_GENERATIONS = 3;
/** 読み取りでファイル末尾から読む最大バイト数。 */
export const MAX_HISTORY_TAIL_BYTES = 4 * 1024 * 1024;
/** `readHistory` が返す既定の最大件数。 */
export const DEFAULT_HISTORY_LIMIT = 500;

const historyDir = (): string => path.join(config.logging.dir, 'history');
const fileFor = (kind: HistoryKind): string => path.join(historyDir(), `${kind}.jsonl`);
const genFileFor = (kind: HistoryKind, gen: number): string =>
  path.join(historyDir(), `${kind}.${gen}.jsonl`);

/**
 * 追記前のローテーション。`<kind>.N.jsonl` を末尾から 1 つずつ繰り上げ、最古は捨てる。
 * 失敗しても追記自体は続ける(監査ログを取りこぼす方が悪い)。
 */
async function rotateIfNeeded(kind: HistoryKind): Promise<void> {
  const size = await fs
    .stat(fileFor(kind))
    .then((s) => s.size)
    .catch(() => 0);
  if (size < MAX_HISTORY_BYTES) return;
  for (let gen = MAX_HISTORY_GENERATIONS; gen >= 1; gen--) {
    const from = gen === 1 ? fileFor(kind) : genFileFor(kind, gen - 1);
    await fs.rm(genFileFor(kind, gen), { force: true }).catch(() => {});
    await fs.rename(from, genFileFor(kind, gen)).catch(() => {});
  }
}

/** 1 イベントを追記する(ディレクトリは必要に応じて作成)。 */
export async function appendHistory(kind: HistoryKind, entry: unknown): Promise<void> {
  await fs.mkdir(historyDir(), { recursive: true });
  await rotateIfNeeded(kind);
  await fs.appendFile(fileFor(kind), `${JSON.stringify(entry)}\n`, 'utf8');
}

/**
 * ファイル末尾から最大 `MAX_HISTORY_TAIL_BYTES` を読む。先頭が行の途中で切れている
 * ときは最初の改行までを捨てる(壊れた JSON を作らないため)。
 */
async function readTail(file: string): Promise<string> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(file, 'r');
    const { size } = await handle.stat();
    const start = Math.max(0, size - MAX_HISTORY_TAIL_BYTES);
    const length = size - start;
    if (length === 0) return '';
    const buf = Buffer.alloc(length);
    await handle.read(buf, 0, length, start);
    const text = buf.toString('utf8');
    if (start === 0) return text;
    const nl = text.indexOf('\n');
    return nl < 0 ? '' : text.slice(nl + 1);
  } catch {
    return '';
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * 種別のイベントを新しい順(先頭が最新)で返す。ファイルが無ければ空配列。
 * `limit` は返す件数の上限で、既定 `DEFAULT_HISTORY_LIMIT`。
 *
 * `where` は**打ち切りの手前**で適用する。フィルタを呼び出し側で後から掛けると、共用の
 * jsonl(例: `part.jsonl` は全テンプレ共用)では他対象の更新が limit 件積むだけで当該対象の
 * 履歴が 0 件になる(= 画面から履歴が消える)。打ち切りは常に「フィルタ後の件数」で行うこと。
 */
export async function readHistory<T>(
  kind: HistoryKind,
  opts: { limit?: number; where?: (entry: T) => boolean } = {},
): Promise<T[]> {
  const limit = Math.max(1, Math.min(opts.limit ?? DEFAULT_HISTORY_LIMIT, DEFAULT_HISTORY_LIMIT));
  const raw = await readTail(fileFor(kind));
  const lines = raw.split('\n');
  const out: T[] = [];
  // 末尾から遡る = 新しい順。上限に達したら残りは読まない。
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    const line = lines[i];
    if (line.length === 0) continue;
    try {
      const entry = JSON.parse(line) as T;
      if (opts.where === undefined || opts.where(entry)) out.push(entry);
    } catch {
      // 追記の競合等で壊れた行は飛ばす。1 行の破損でフィード全体を落とさない。
    }
  }
  return out;
}
