// =============================================================================
// atomic.ts — ファイルのアトミック書き込み(temp + rename)
// =============================================================================
// 一時ファイル(`tmp`)へ書いてから対象へ `rename` する。読み手が書きかけの
// 中途半端なファイルを見ること(half-written read)を防ぎ、書き込み途中の
// クラッシュでも旧内容(old content)が壊れずに残る。template/draft/snapshot の
// 本体書き込みに使う(phase 2 は大きなテキストをディスクに置き、DB は索引のみ持つ)。

import fs from 'node:fs/promises';

export async function atomicWrite(filePath: string, content: string): Promise<void> {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, content, 'utf8');
  await fs.rename(tmp, filePath);
}
