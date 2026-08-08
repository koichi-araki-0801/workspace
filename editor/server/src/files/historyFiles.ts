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
import { validation } from '@editor/shared';
import { config } from '../config.js';
import { logger } from '../logger.js';

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
/**
 * 1 レコード(1 行)の上限バイト数。
 *
 * 読み側が末尾 `MAX_HISTORY_TAIL_BYTES` しか読まないので、**1 行がその窓より長いと
 * それ以前の履歴が全部視界から消える**。しかも `readTail` は行の途中から始まる先頭を
 * 捨てるので、窓を丸ごと覆う 1 行は「0 件」を返させる。読み窓に対して十分小さい上限を
 * 追記側に置き、書式の想定(id・templateId・ISO 時刻・ログインID)から外れた巨大な
 * レコードは記録せず入力エラーとして返す。契約側の `.max()` と二重にするのは、
 * 契約を通らない内部呼び出しでも窓を潰させないため。
 */
export const MAX_HISTORY_RECORD_BYTES = 64 * 1024;

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
    // 失敗しても続行するが、黙らせない: `readTail` や別クライアント(ログ置き場が
    // ネットワーク上の場合)がファイルを開いている間、Windows の rename は共有違反に
    // なる。無言のままだとローテーションが効かず `<kind>.jsonl` が読み窓を超えて太り、
    // 古い履歴が画面から消えたように見える。
    await fs.rename(from, genFileFor(kind, gen)).catch((e: unknown) => {
      logger.warn({ err: e, from }, '履歴ログのローテーションに失敗しました(次回追記で再試行)');
    });
  }
}

/**
 * 1 イベントを追記する(ディレクトリは必要に応じて作成)。
 * 1 行が `MAX_HISTORY_RECORD_BYTES` を超えるレコードは**書かずに拒否**する(理由は定数の説明)。
 */
export async function appendHistory(kind: HistoryKind, entry: unknown): Promise<void> {
  const line = `${JSON.stringify(entry)}\n`;
  if (Buffer.byteLength(line, 'utf8') > MAX_HISTORY_RECORD_BYTES) {
    throw validation('履歴に記録する値が大きすぎます');
  }
  await fs.mkdir(historyDir(), { recursive: true });
  await rotateIfNeeded(kind);
  await fs.appendFile(fileFor(kind), line, 'utf8');
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
  const out: T[] = [];
  // 現行ファイル → 旧世代の順に、上限に達するまで遡る。旧世代を読まなかった版は、
  // ローテーションが 1 回起きただけで画面から履歴が消えた(しかも `rotateIfNeeded` は
  // 追記側が勝手に起こすので、利用者から見ると理由が分からない)。
  for (let gen = 0; gen <= MAX_HISTORY_GENERATIONS && out.length < limit; gen++) {
    const file = gen === 0 ? fileFor(kind) : genFileFor(kind, gen);
    const lines = (await readTail(file)).split('\n');
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
  }
  return out;
}
