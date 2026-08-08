// =============================================================================
// atomic.ts — ファイルのアトミック書き込み(temp + fsync + rename)
// =============================================================================
// 一時ファイル(`tmp`)へ書いてから対象へ `rename` する。読み手が書きかけの
// 中途半端なファイルを見ること(half-written read)を防ぎ、書き込み途中の
// クラッシュでも旧内容(old content)が壊れずに残る。template/draft/snapshot の
// 本体書き込みに使う(phase 2 は大きなテキストをディスクに置き、DB は索引のみ持つ)。

import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

/**
 * rename の一時的な共有違反として扱うエラーコード。Windows では別プロセスが宛先を
 * 開いているだけで rename がこれらで落ちる(恒久的な ACL 拒否と事前に区別できない)。
 */
const RETRIABLE_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

/** rename リトライの待ち(ms)。合計 ~750ms 粘って駄目なら例外で諦める(無限に固まらせない)。 */
const RENAME_RETRY_DELAYS_MS = [50, 100, 200, 400];

/**
 * `rename` を共有違反リトライ付きで行う。
 *
 * プロセス内の書き込み競合は呼び出し側の `fileLock` が直列化するが、dataRoot が
 * ネットワークドライブ上にあると**別クライアント**(ウイルス対策・エクスプローラの
 * プレビュー・バックアップ・TortoiseGit のステータスキャッシュ)が宛先を開いた瞬間の
 * rename が共有違反になる。これはプロセス内ロックでは原理的に防げないため、短い待ちで
 * 数回だけやり直す。
 */
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (const ms of RENAME_RETRY_DELAYS_MS) {
    try {
      await fs.rename(from, to);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? '';
      if (!RETRIABLE_RENAME_CODES.has(code)) throw e;
      await delay(ms);
    }
  }
  await fs.rename(from, to);
}

/**
 * 一時ファイル名は**必ず衝突しない**ものにする。
 *
 * 名前が `pid + ミリ秒` だった版は、サーバが単一プロセスなので pid が定数であり、
 * 同一ミリ秒に同じ対象へ走った 2 つの書き込みが**同じ一時パスを共有**した。両者が
 * 切り詰めモードで開いて交互に書き、先に rename した側が消えるので、残る内容は
 * 混ざったバイト列か、後続が ENOENT で 500 になるかのどちらかだった。
 * `randomUUID` は衝突を暗号学的に無視できる水準まで落とす。
 *
 * rename の前に fsync まで済ませる: ネットワークドライブ(SMB)上の dataRoot では
 * 書き込みがクライアント側の write-behind キャッシュに乗ったまま rename が先に届きうる。
 * その瞬間に接続が切れると**0 バイト/切り詰めたファイルが本番名で残り**、「旧内容が
 * 壊れずに残る」という本モジュールの不変則が破れる(ローカル NTFS では close だけで
 * 実用上成立していた)。
 *
 * ⚠ これは**破損しないこと**の保証であって、**更新が消えないこと**の保証ではない。
 * 読み-改変-書きをする呼び出し側は、別途 `files/fileLock.ts` の `withFileLock` で
 * 対象ごとに直列化すること(例: `repositories/noteRepo.saveNote`)。
 */
export async function atomicWrite(filePath: string, content: string): Promise<void> {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}-${randomUUID()}`;
  const handle = await fs.open(tmp, 'w');
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await renameWithRetry(tmp, filePath);
  } catch (e) {
    // rename は失敗しうる(リトライ後も残る共有違反・恒久的な権限拒否)。ここでは
    // **中途半端な一時ファイルを残さない**ことだけを保証する(残すと `.gitignore` の
    // `*.tmp-*` 頼みのゴミが溜まる)。
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
}
