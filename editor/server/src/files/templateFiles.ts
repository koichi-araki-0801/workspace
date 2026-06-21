// =============================================================================
// templateFiles.ts — 確定 template 本体(HTML)とファンド別共有 CSS(ディスク I/O)
// =============================================================================
// 確定済み template 本体(HTML)とファンド別(per-fund)共有 CSS をディスク上に持つ。
// DB レジストリ(台帳)はメタデータのみを保持し、バイト列(本体)はここに置く。
// キーはファイル名規約 / `fundCode`(phase 1 のファイルレイアウトから不変)。

import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWrite } from './atomic.js';

export const templatePath = (fileName: string): string => path.join(config.templatesDir, fileName);
export const cssPath = (fundCode: string): string => path.join(config.cssDir, `${fundCode}.css`);

export function readTemplateHtml(fileName: string): Promise<string> {
  return fs.readFile(templatePath(fileName), 'utf8').catch(() => '');
}
export function readFundCss(fundCode: string): Promise<string> {
  return fs.readFile(cssPath(fundCode), 'utf8').catch(() => '');
}

/** 確定保存(confirm-save)失敗時にロールバックできるよう、現在のバイト列を読む。 */
export async function snapshotCurrent(
  fileName: string,
  fundCode: string,
): Promise<{ html: string | null; css: string | null }> {
  const read = (p: string) =>
    fs
      .readFile(p, 'utf8')
      .then((s) => s as string | null)
      .catch(() => null);
  return { html: await read(templatePath(fileName)), css: await read(cssPath(fundCode)) };
}

export async function writeTemplateAndCss(
  fileName: string,
  html: string,
  fundCode: string,
  css: string,
): Promise<void> {
  await fs.mkdir(config.templatesDir, { recursive: true });
  await fs.mkdir(config.cssDir, { recursive: true });
  await atomicWrite(templatePath(fileName), html);
  await atomicWrite(cssPath(fundCode), css);
}

/** 先に読んだバイト列を復元する(DB コミット失敗時の補償 = compensation)。 */
export async function restoreTemplateAndCss(
  fileName: string,
  fundCode: string,
  prev: { html: string | null; css: string | null },
): Promise<void> {
  if (prev.html !== null) await atomicWrite(templatePath(fileName), prev.html);
  if (prev.css !== null) await atomicWrite(cssPath(fundCode), prev.css);
}
