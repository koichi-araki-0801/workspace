// =============================================================================
// atomic.ts — ファイルのアトミック書き込み(temp + rename)
// =============================================================================
// 一時ファイル(`tmp`)へ書いてから対象へ `rename` する。読み手が書きかけの
// 中途半端なファイルを見ること(half-written read)を防ぎ、書き込み途中の
// クラッシュでも旧内容(old content)が壊れずに残る。template/draft/snapshot の
// 本体書き込みに使う(phase 2 は大きなテキストをディスクに置き、DB は索引のみ持つ)。

import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';

/**
 * 一時ファイル名は**必ず衝突しない**ものにする。
 *
 * 名前が `pid + ミリ秒` だった版は、サーバが単一プロセスなので pid が定数であり、
 * 同一ミリ秒に同じ対象へ走った 2 つの書き込みが**同じ一時パスを共有**した。両者が
 * 切り詰めモードで開いて交互に書き、先に rename した側が消えるので、残る内容は
 * 混ざったバイト列か、後続が ENOENT で 500 になるかのどちらかだった。
 * `randomUUID` は衝突を暗号学的に無視できる水準まで落とす。
 *
 * ⚠ これは**破損しないこと**の保証であって、**更新が消えないこと**の保証ではない。
 * 読み-改変-書きをする呼び出し側は、別途 `files/fileLock.ts` の `withFileLock` で
 * 対象ごとに直列化すること(例: `repositories/noteRepo.saveNote`)。
 */
export async function atomicWrite(filePath: string, content: string): Promise<void> {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}-${randomUUID()}`;
  await fs.writeFile(tmp, content, 'utf8');
  try {
    await fs.rename(tmp, filePath);
  } catch (e) {
    // rename は失敗しうる。特に Windows では、別の書き手が同じ宛先を差し替えている最中に
    // `EPERM`(共有違反)になる — 一時名を一意にしても消えない性質で、これを避けたい
    // 呼び出し側は `files/fileLock.ts` で直列化する。ここでは**中途半端な一時ファイルを
    // 残さない**ことだけを保証する(残すと `.gitignore` の `*.tmp-*` 頼みのゴミが溜まる)。
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
}
