// =============================================================================
// fsHelpers.ts — 読み取り系ファイル I/O の小さな共通部品
// =============================================================================
// 「無ければ null / false / 既定値」の分岐を files 層の各ファイルが個別に書くと、握りつぶす
// エラーの範囲が少しずつずれる。範囲をここに 1 つずつ固定する。

import fs from 'node:fs/promises';

/**
 * 最終更新時刻(ISO)。stat できなければ(ENOENT に限らず)null。
 * 一覧・メタ組み立ての表示用で、失敗を例外にすると 1 件の不調で一覧ごと落ちるため倒す。
 */
export function statMtime(p: string): Promise<string | null> {
  return fs
    .stat(p)
    .then((s) => s.mtime.toISOString())
    .catch(() => null);
}

/** stat できるか。できなければ(ENOENT に限らず)false。 */
export function fileExists(p: string): Promise<boolean> {
  return fs
    .stat(p)
    .then(() => true)
    .catch(() => false);
}

/**
 * UTF-8 で読む。ENOENT のときだけ `fallback` を返し、それ以外の読み取り失敗は例外にする。
 * 読んだ値を基準や書き戻しの入力にする経路があり、EACCES / EBUSY を既定値へ倒すと
 * 「空」を前提に後段が進むため。
 */
export function readOrMissing<T extends string | null>(
  p: string,
  fallback: T,
): Promise<string | T> {
  return fs.readFile(p, 'utf8').catch((e: NodeJS.ErrnoException) => {
    if (e?.code === 'ENOENT') return fallback;
    throw e;
  });
}
