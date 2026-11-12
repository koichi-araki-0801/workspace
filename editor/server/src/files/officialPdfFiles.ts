// =============================================================================
// officialPdfFiles.ts — 正式 PDF(`pdf/<id>.pdf`)と値入り HTML の更新時刻・PDF の削除
// =============================================================================
// 正式 PDF が値入り HTML より古いかを調べるための読み取りと、検査に落ちた組版の前に古い PDF を
// 消す書き込みを、リポジトリから fs を直接触らないようここに閉じる。
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { mtimeOrNull } from './fsHelpers.js';
import { filledPath } from './templateFiles.js';

const pdfPath = (id: string): string => path.join(config.pdfDir, `${id}.pdf`);

/** 正式 PDF の更新時刻。無ければ null。 */
export function officialPdfMtime(id: string): Promise<Date | null> {
  return mtimeOrNull(pdfPath(id));
}

/** 値入り HTML の更新時刻。無ければ null。 */
export function filledFileMtime(id: string): Promise<Date | null> {
  return mtimeOrNull(filledPath(`${id}.html`));
}

/** 正式 PDF を消す。無ければ何もしない。 */
export async function removeOfficialPdf(id: string): Promise<void> {
  await fs.rm(pdfPath(id), { force: true });
}
