/**
 * Confirmed template body (HTML) and per-fund shared CSS, on disk. The DB
 * registry (台帳) holds only metadata; the bytes live here, keyed by the
 * filename convention / fundCode (unchanged from phase 1's file layout).
 */
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

/** Read current bytes so a failed confirm-save can be rolled back. */
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

/** Restore previously-read bytes (compensation when the DB commit fails). */
export async function restoreTemplateAndCss(
  fileName: string,
  fundCode: string,
  prev: { html: string | null; css: string | null },
): Promise<void> {
  if (prev.html !== null) await atomicWrite(templatePath(fileName), prev.html);
  if (prev.css !== null) await atomicWrite(cssPath(fundCode), prev.css);
}
